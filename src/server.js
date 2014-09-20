'use strict';

var http = require("http");
var express = require("express");
var logger = require('morgan');
var bodyParser = require('body-parser');
var uuidGen = require('node-uuid');
var debug = require('debug')('build');
var Q = require('q');
var qhttp = require("q-io/http");

var app = express();
var port = process.env.PORT || 5000;

app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));

var auth_token;

function getAuthToken() {
    return Q.fcall(function() {
        var now = new Date().getTime();

        if (auth_token !== undefined && auth_token.expires > now) {
            return auth_token.token;
        } else {
            return qhttp.read({
                url: process.env.AUTH_URL + '/auth?ttl=3600',
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": 'Basic ' + new Buffer(process.env.INTERNAL_CREDS).toString('base64')
                }
            }).then(function(b) {
                auth_token = JSON.parse(b.toString());
                return auth_token.token;
            });
        }
    });
}

function authorize(req, restricted) {
    var auth_header = req.get('Authorization');
    if (auth_header === undefined) {
        throw new Error("not authorized");
    }

    var parts = auth_header.split(' ');

    // TODO make a way for internal apis to authorize
    // as a specific account without having to get a
    // different bearer token for each one. Perhaps
    // auth will return a certain account if the authorized
    // token has metadata appended to the end of it
    // or is fernet encoded.
    if (parts[0] != "Bearer") {
        throw new Error("not authorized");
    }

    // This will fail if it's not authorized
    return qhttp.read({
        method: "POST",
        url: process.env.AUTH_URL + '/token',
        headers: {
            "Content-Type": "application/json"
        },
        body: [JSON.stringify({
            token: parts[1],
            restricted: (restricted === true)
        })]
    }).then(function(body) {
        return JSON.parse(body.toString());
    }).fail(function(e) {
        throw new Error("not authorized");
    });
}

function getBlueprints() {
    return qhttp.read(process.env.TECHDB_URL + '/blueprints').then(function(b) {
        return JSON.parse(b.toString());
    });
}

var facilities = {
    "dummy": {
        "blueprint": "dummy"
    }
};
var spodb = {
    "dummy": {
        "blueprint": "dummy"
    }
};
var buildJobs = {};

app.get('/jobs', function(req, res) {
    res.send(buildJobs);
});

// players cancel jobs
app.delete('/jobs/:uuid', function(req, res) {
    // does the user get the resources back?
    // not supported yet
    res.sendStatus(404);
});

// players queue jobs
app.post('/jobs', function(req, res) {
    var uuid = uuidGen.v1();
    debug(req.body);

    var example = {
        "facility": "uuid",
        "action": "manufacture", // refine, construct
        "quantity": 3,
        "target": "blueprintuuid",
        "inventory": "uuid"
    };

    var job = req.body;
    var facility = facilities[job.facility];
    var duration = -1;

    Q.spread([getBlueprints(), authorize(req)], function(blueprints, auth) {
        var facilityType = blueprints[facility.blueprint];
        var canList = facilityType.production[job.action];
        var target = blueprints[req.body.target];

        if (facility.account != auth.account) {
            return res.status(401).send("not authorized to access that facility");
        }

        if (!canList.some(function(e) {
            return e.item == job.target;
        })) {
            console.log(canList);
            console.log(job.target);

            res.status(400).send("facility is unable to produce that");
        }

        var promises = [];

        if (job.action == "refine") {
            job.outputs = target.refine.outputs;

            // TODO verify space in the attached inventory after target is removed
            promises.push(consume(auth.account, job.facility, job.inventory, job.target, job.quantity));
            duration = target.refine.time;
        } else {
            duration = target.build.time;

            for (var key in target.build.resources) {
                var count = target.build.resources[key];
                promises.push(consume(auth.account, job.facility, job.inventory, key, count * job.quantity));
            }

            if (job.action == "construct") {
                job.quantity = 1;
            }
        }

        Q.all(promises).then(function() {
            job.finishAt = (new Date().getTime() + duration * 1000 * job.quantity);
            job.account = auth.account;

            buildJobs[uuid] = job;

            res.sendStatus(201);
        }).fail(function(e) {
            res.status(500).send(e.toString());
        }).done();
    });
});

app.get('/facilities', function(req, res) {
    authorize(req).then(function(auth) {
        if (auth.privileged && req.param('all') == 'true') {
            res.send(facilities);
        } else {
            var my_facilities = {};

            for (var key in facilities) {
                var i = facilities[key];
                if (i.account == auth.account) {
                    my_facilities[key] = i;
                }
            }

            res.send(my_facilities);
        }
    });
});

// spodb tells us when facilities come into existance
app.post('/facilities/:uuid', function(req, res) {
    Q.spread([getBlueprints(), authorize(req, true)], function(blueprints, auth) {
        var blueprint = blueprints[req.body.blueprint];

        if (blueprint) {
            var uuid = req.param('uuid');
            var obj = req.body;
            obj.account = auth.account;

            facilities[uuid] = req.body;

            if (blueprint.type == "structure" || blueprint.type == "deployable") {
                spodb[uuid] = {
                    blueprint: uuid
                };
            }

            res.sendStatus(201);
        } else {
            res.status(400).send("no such blueprint");
        }
    });
});

// this is just a stub until we build the spodb
app.get('/spodb', function(req, res) {
    authorize(req, true).then(function(auth) {
        res.send(spodb);
    });
});

function updateInventory(account, uuid, slice, type, quantity) {
    return getAuthToken().then(function(token) {
        return qhttp.request({
            method: "POST",
            url: process.env.INVENTORY_URL + '/inventory',
            headers: {
                "Authorization": "Bearer " + token + '/' + account,
                "Content-Type": "application/json"
            },
            body: [JSON.stringify([{
                inventory: uuid,
                slice: slice,
                blueprint: type,
                quantity: quantity
            }])]
        }).then(function(resp) {
            if (resp.status !== 204) {
                resp.body.read().then(function(b) {
                    console.log("inventory "+resp.status+" reason: "+b.toString());
                }).done();

                throw new Error("inventory responded with " + resp.status);
            }
        });
    });
}

function consume(account, uuid, slice, type, quantity) {
    return updateInventory(account, uuid, slice, type, quantity * -1);
}

function produce(account, uuid, slice, type, quantity) {
    return updateInventory(account, uuid, slice, type, quantity);
}

var buildWorker = setInterval(function() {
    var timestamp = new Date().getTime();

    for (var uuid in buildJobs) {
        var job = buildJobs[uuid];
        if (job.finishAt < timestamp && job.finished !== true) {
            debug(job);
            job.finished = true;

            switch (job.action) {
                case "manufacture":
                    produce(job.account, job.facility, job.inventory, job.target, job.quantity);
                    break;
                case "refine":
                    for (var key in job.outputs) {
                        var count = job.outputs[key];
                        produce(job.account, job.facility, job.inventory, key, count * job.quantity);
                    }
                    break;
                case "construct":
                    // TODO update inventory and out own tracking in addition
                    // to notifying spodb
                    spodb[job.facility].blueprint = job.target;

                    break;
            }

        }
    }
}, 1000);

var server = http.createServer(app);
server.listen(port);
console.log("server ready");
