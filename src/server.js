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

var facilities = { };
var spodb = { };

var queued_jobs = {};
var running_jobs = {};
var resources = { };

var loadouts = require('./loadouts');
var loadout_accounting = {};

// TODO normally spodb would do this when an account first connects
app.get('/setup', function(req, res) {
    var loadout_name = req.param('loadout');
    var loadout = loadouts[loadout_name];


    Q.spread([getBlueprints(), authorize(req)], function(blueprints, auth) {
        if (loadout_accounting[auth.account] !== undefined) {
            return res.status(200).send("that account is already setup");
        } else if (loadout === undefined) {
            return res.status(404).send("no such loadout available");
        } else {
            var list = [];
            var facilities = [];

            for (var ctype in loadout) {
                var uuid = uuidGen.v1();
                list.push({
                    container_action: "create",
                    uuid: uuid,
                    blueprint: ctype
                });

                if (blueprints[ctype].production !== undefined) {
                    facilities.push({
                        uuid: uuid,
                        blueprint: blueprints[ctype],
                        account: auth.account
                    });
                }

                for (var type in loadout[ctype]) {
                    list.push({
                        inventory: uuid,
                        slice: "default",
                        blueprint: type,
                        quantity: loadout[ctype][type]
                    });
                }
            }

            return updateInventory(auth.account, list).then(function() {
                facilities.forEach(function(f) {
                    updateFacility(f.uuid, f.blueprint, f.account);
                });

                loadout_accounting[auth.account] = loadout_name;

                res.status(200).send("account setup with " + loadout_name);
            });
        }
    }).fail(function(e) {
        res.status(500).send(e.toString());
    }).done();
});

function hashForEach(obj, fn) {
    for (var k in obj) {
        fn(k, obj[k]);
    }
}

app.get('/jobs', function(req, res) {
    authorize(req).then(function(auth) {
        var dataset = {};

        function initKey(k) {
            if (dataset[k] === undefined) {
                dataset[k] = {
                    queued: []
                };
            }
        }

        function includeJob(job) {
            return (job.account == auth.account || (auth.privileged && req.param('all') == 'true'));
        }

        hashForEach(running_jobs, function(key, job) {
            initKey(key);

            if (includeJob(job)) {
                dataset[key].running = job;
            }
        });

        hashForEach(queued_jobs, function(key, queue) {
            initKey(key);

            queue.forEach(function(job) {
                if (includeJob(job)) {
                    dataset[key].queued.push(job);
                }
            });
        });

        res.send(dataset);
    });
});

// players cancel jobs
app.delete('/jobs/:uuid', function(req, res) {
    // does the user get the resources back?
    // not supported yet
    res.sendStatus(404);
});

// players queue jobs
app.post('/jobs', function(req, res) {
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

    job.uuid = uuidGen.v1();

    if (facility === undefined) {
        return res.status(404).send("no such facility: " + job.facility);
    }

    Q.spread([getBlueprints(), authorize(req)], function(blueprints, auth) {
        var facilityType = blueprints[facility.blueprint];
        var canList = facilityType.production[job.action];
        var target = blueprints[job.target];

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

            job.duration = target.refine.time;
        } else {
            job.duration = target.build.time;

            if (job.action == "construct") {
                job.quantity = 1;
            }
        }

        job.account = auth.account;

        if (queued_jobs[job.facility] === undefined) {
            queued_jobs[job.facility] = [];
        }

        if (running_jobs[job.facility] === undefined) {
            startJob(job);
        } else {
            queued_jobs[job.facility].push(job);
        }

        res.sendStatus(201);
    }).fail(function(e) {
        res.status(500).send(e.toString());
    }).done();
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

function updateFacility(uuid, blueprint, account) {
    if (blueprint.production === undefined) {
        throw new Error(uuid+" is not a production facility");
    }

    facilities[uuid] = {
        blueprint: blueprint.uuid,
        account: account
    };

    if (blueprint.production.generate !== undefined) {
        resources[uuid] = blueprint.production.generate;
    }

    // Not every facility is a structure. placeholder
    // until spodb is external and is the one calling us
    if (blueprint.type == "structure" || blueprint.type == "deployable") {
        spodb[uuid] = {
            blueprint: uuid
        };
    }
}

function getInventoryData(uuid, account) {
    return getAuthToken().then(function(token) {
        return qhttp.read({
            method: "GET",
            url: process.env.INVENTORY_URL + '/inventory/' + uuid,
            headers: {
                "Authorization": "Bearer " + token + '/' + account,
                "Content-Type": "application/json"
            }
        }).then(function(body) {
            return JSON.parse(body.toString());
        });
    });
}

function destroyFacility(uuid) {
    var facility = facilities[uuid];

    delete resources[uuid];
    delete running_jobs[uuid];
    delete queued_jobs[uuid];
    delete facilities[uuid];
}

// When a ship or production structure is destroyed
app.delete('/facilities/:uuid', function(req, res) {
    destroyFacility(req.param('uuid'));

    res.sendStatus(204);
});

// TODO this endpoint should be restricted when spodb
// starts calling it and users don't have to anymore
app.post('/facilities/:uuid', function(req, res) {
    var authP = authorize(req);
    var uuid = req.param('uuid');
    var inventoryP = authP.then(function(auth) {
        // This verifies that the inventory exists and
        // is owned by the same account
        return getInventoryData(uuid, auth.account);
    });

    Q.spread([getBlueprints(), authP, inventoryP], function(blueprints, auth, inventory) {
        var blueprint = blueprints[req.body.blueprint];

        if (blueprint && inventory.blueprint == blueprint.uuid) {

            updateFacility(uuid, blueprint, auth.account);

            res.sendStatus(201);
        } else {
            res.status(400).send("no such blueprint");
        }
    }).fail(function(e) {
        res.status(500).send(e.toString());
    }).done();
});

// this is just a stub until we build the spodb
app.get('/spodb', function(req, res) {
    authorize(req, true).then(function(auth) {
        res.send(spodb);
    });
});

function updateInventory(account, data) {
    /* data = [{
        inventory: uuid,
        slice: slice,
        blueprint: type,
        quantity: quantity
    }]
    */
    return getAuthToken().then(function(token) {
        return qhttp.request({
            method: "POST",
            url: process.env.INVENTORY_URL + '/inventory',
            headers: {
                "Authorization": "Bearer " + token + '/' + account,
                "Content-Type": "application/json"
            },
            body: [JSON.stringify(data)]
        }).then(function(resp) {
            if (resp.status !== 204) {
                resp.body.read().then(function(b) {
                    console.log("inventory " + resp.status + " reason: " + b.toString());
                }).done();

                throw new Error("inventory responded with " + resp.status);
            }
        });
    });
}

function consume(account, uuid, slice, type, quantity) {
    return updateInventory(account, [{
        inventory: uuid,
        slice: slice,
        blueprint: type,
        quantity: (quantity * -1)
    }]);
}

function produce(account, uuid, slice, type, quantity) {
    return updateInventory(account, [{
        inventory: uuid,
        slice: slice,
        blueprint: type,
        quantity: quantity
    }]);
}

function updateInventoryContainer(uuid, blueprint, account) {
    return getAuthToken().then(function(token) {
        return qhttp.request({
            method: "POST",
            url: process.env.INVENTORY_URL + '/containers/' + uuid,
            headers: {
                "Authorization": "Bearer " + token + '/' + account,
                "Content-Type": "application/json"
            },
            body: [JSON.stringify({
                blueprint: blueprint
            })]
        }).then(function(resp) {
            if (resp.status !== 204) {
                resp.body.read().then(function(b) {
                    console.log("inventory " + resp.status + " reason: " + b.toString());
                }).done();

                throw new Error("inventory responded with " + resp.status);
            }
        });
    });
}

function fullfillResources(job) {
    job.resourcesInProgress = true;

    return getBlueprints().then(function(blueprints) {
        var promises = [];
        var target = blueprints[job.target];

        if (job.action == "refine") {
            promises.push(consume(job.account, job.facility, job.slice, job.target, job.quantity));
        } else {
            for (var key in target.build.resources) {
                var count = target.build.resources[key];
                // TODO do this as a transaction
                promises.push(consume(job.account, job.facility, job.slice, key, count * job.quantity));
            }
        }

        return Q.all(promises);
    }).then(function() {
        job.finishAt = (new Date().getTime() + job.duration * 1000 * job.quantity);
        job.resourcesFullfilled = true;
        job.resourcesInProgress = false;
        console.log("fullfilled " + job.uuid + " at " + job.facility);
    }, function(e) {
        job.resourcesInProgress = false;
        console.log("failed to fullfilled " + job.uuid + " at " + job.facility + ": " + e.toString());
    });
}

function startJob(job) {
    if (running_jobs[job.facility] === undefined) {
        running_jobs[job.facility] = job;
    } else {
        throw new Error("failed to start job in " + job.facility + ", " + running_jobs[job.facility] + " is already running");
    }

    job.resourcesFullfilled = false;
    job.resourcesInProgress = false;

    console.log("running " + job.uuid + " at " + job.facility);
}

function deliverJob(job) {
    switch (job.action) {
        case "manufacture":
            return produce(job.account, job.facility, job.slice, job.target, job.quantity);

        case "refine":
            var promises = [];

            for (var key in job.outputs) {
                var count = job.outputs[key];
                // TODO do this as a transaction
                promises.push(produce(job.account, job.facility, job.slice, key, count * job.quantity));
            }

            return Q.all(promises);
        case "construct":
            return Q.fcall(function() {
                // Updating the facility uuid is because everything
                // is built on a scaffold, so everything starts as a facility
                spodb[job.facility].blueprint = job.target;
            }).then(function() {
                return getBlueprints().then(function(blueprints) {
                    var blueprint = blueprints[job.target];

                    // If a scaffold was upgraded to a non-production
                    // structure, remove the facility tracking
                    if (blueprint.production === undefined) {
                        destroyFacility(job.facility);
                    } else {
                        updateFacility(job.facility, blueprint, job.account);
                    }
                }).then(function() {
                    return updateInventoryContainer(job.facility, job.target, job.account);
                });
            });
    }
}

function checkAndProcessFacilityJob(facility) {
    var timestamp = new Date().getTime();
    var job = running_jobs[facility];

    if (!job.resourcesFullfilled) {
        if (!job.resourcesInProgress) {
            fullfillResources(job);
        }
    } else if (job.finishAt < timestamp && job.deliveryStartedAt === undefined) {
        job.deliveryStartedAt = timestamp;

        deliverJob(job).then(function() {
            if (running_jobs[facility] !== undefined && running_jobs[facility].uuid == job.uuid) {
                console.log("delivered " + job.uuid + " at " + facility);
                delete running_jobs[facility];

                var list = queued_jobs[facility];

                if (list !== undefined && list.length > 0) {
                    startJob(list[0]);
                    list.splice(0, 1);
                }
            } else {
                console.log("unknown job running in " + facility, running_jobs[facility]);
            }
        }, function(e) {
            console.log("failed to deliver job in " + facility + ": " + e.toString());
            delete job.deliveryStartedAt;
        }).done();
    }
}

function checkAndDeliverResources(uuid) {
    var resource = resources[uuid];
    var facility = facilities[uuid];
    var timestamp = new Date().getTime();

    if (resource.lastDeliveredAt === undefined) {
        // The first time around this is just a dummy
        resource.lastDeliveredAt = timestamp;
    } else if (((resource.lastDeliveredAt + resource.period) < timestamp) && resource.deliveryStartedAt === undefined) {
        resource.deliveryStartedAt = timestamp;
        produce(facility.account, uuid, 'default', resource.type, resource.quantity).then(function() {
            resource.lastDeliveredAt = timestamp;
            delete resource.deliveryStartedAt;
        }, function(e) {
            console.log("failed to deliver resources from "+uuid+": "+e.toString());
            delete resource.deliveryStartedAt;
        });
    } else {
        if (resource.deliveryStartedAt) {
            console.log("delivery was started for "+uuid+" and I'm still waiting");
        } else {
            console.log(uuid+" is waiting until "+timestamp+" is greater than "+(resource.lastDeliveredAt+resource.period)+ " "+((resource.lastDeliveredAt + resource.period) > timestamp)+" "+(timestamp - resource.lastDeliveredAt));
        }
    }
}

var buildWorker = setInterval(function() {
    for (var facility in running_jobs) {
        checkAndProcessFacilityJob(facility);
    }
}, 1000);

var resourceWorker = setInterval(function() {
    console.log('resources', resources);

    for (var facility in resources) {
        checkAndDeliverResources(facility);
    }
}, 1000);

var server = http.createServer(app);
server.listen(port);
console.log("server ready");
