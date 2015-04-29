'use strict';

var http = require("http");
var express = require("express");
var logger = require('morgan');
var bodyParser = require('body-parser');
var uuidGen = require('node-uuid');
var debug = require('debug')('build');
var Q = require('q');
var qhttp = require("q-io/http");
var WebSockets = require("ws");
var C = require('spacebox-common');

var app = express();
var port = process.env.PORT || 5000;

app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));

var facilities = { };
var spodb = { };

var queued_jobs = {};
var running_jobs = {};
var resources = { };

var loadouts = require('./loadouts');
var loadout_accounting = {};

// TODO normally spodb would do this when an account first connects
app.post('/setup', function(req, res) {
    var loadout_name = req.param('loadout');
    var loadout = loadouts[loadout_name];


    Q.spread([C.getBlueprints(), C.authorize_req(req)], function(blueprints, auth) {
        if (loadout_accounting[auth.account] !== undefined) {
            return res.status(200).send("that account is already setup");
        } else if (loadout === undefined) {
            return res.status(404).send("no such loadout available: "+loadout_name);
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

            return C.updateInventory(auth.account, list).then(function() {
                facilities.forEach(function(f) {
                    updateFacility(f.uuid, f.blueprint, f.account);
                });

                loadout_accounting[auth.account] = loadout_name;

                res.status(200).send("account setup with " + loadout_name);
            });
        }
    }).fail(function(e) {
        console.log(e);
        console.log(e.stack);
        res.status(500).send(e.toString());
    }).done();
});

function hashForEach(obj, fn) {
    for (var k in obj) {
        fn(k, obj[k]);
    }
}

app.get('/jobs', function(req, res) {
    C.authorize_req(req).then(function(auth) {
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

    Q.spread([C.getBlueprints(), C.authorize_req(req)], function(blueprints, auth) {
        var facilityType = blueprints[facility.blueprint];
        var canList = facilityType.production[job.action];
        var target = blueprints[job.target];

        // Must wait until we have the auth response to check authorization
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

        res.status(201).send({
            job: {
                uuid: job.uuid
            }
        });
    }).fail(function(e) {
        res.status(500).send(e.toString());
    }).done();
});

app.get('/facilities', function(req, res) {
    C.authorize_req(req).then(function(auth) {
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
    }).fail(function(e) {
        res.status(500).send(e.toString());
    }).done();
});

function updateFacility(uuid, blueprint, account) {
    if (blueprint.production === undefined) {
        throw new Error(uuid+" is not a production facility");
    }

    facilities[uuid] = {
        blueprint: blueprint.uuid,
        account: account
    };

    publish({
        type: 'facility',
        account: account,
        uuid: uuid,
        blueprint: blueprint.uuid,
    });

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
    return C.getAuthToken().then(function(token) {
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

    publish({
        type: 'facility',
        account: facility.account,
        tombstone: true,
        uuid: uuid,
        blueprint: facility.blueprint,
    });

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
    var authP = C.authorize_req(req);
    var uuid = req.param('uuid');
    var inventoryP = authP.then(function(auth) {
        // This verifies that the inventory exists and
        // is owned by the same account
        return getInventoryData(uuid, auth.account);
    });

    Q.spread([C.getBlueprints(), authP, inventoryP], function(blueprints, auth, inventory) {
        var blueprint = blueprints[req.body.blueprint];

        if (blueprint && inventory.blueprint == blueprint.uuid) {

            updateFacility(uuid, blueprint, auth.account);

            res.status(201).send({
                facility: {
                    uuid: uuid
                }
            });
        } else {
            res.status(400).send("no such blueprint");
        }
    }).fail(function(e) {
        res.status(500).send(e.toString());
    }).done();
});

// this is just a stub until we build the spodb
app.get('/spodb', function(req, res) {
    C.authorize_req(req, true).then(function(auth) {
        res.send(spodb);
    });
});

function consume(account, uuid, slice, type, quantity) {
    return C.updateInventory(account, [{
        inventory: uuid,
        slice: slice,
        blueprint: type,
        quantity: (quantity * -1)
    }]);
}

function produce(account, uuid, slice, type, quantity) {
    return C.updateInventory(account, [{
        inventory: uuid,
        slice: slice,
        blueprint: type,
        quantity: quantity
    }]);
}

function updateInventoryContainer(uuid, blueprint, account) {
    return C.getAuthToken().then(function(token) {
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

    return C.getBlueprints().then(function(blueprints) {
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

    publish({
        type: 'job',
        account: job.account,
        uuid: job.uuid,
        facility: job.facility,
        state: 'started',
    });

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
                return C.getBlueprints().then(function(blueprints) {
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

                publish({
                    account: job.account,
                    type: 'job',
                    uuid: job.uuid,
                    facility: job.facility,
                    state: 'delivered',
                });

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

            publish({
                type: 'resources',
                account: facility.account,
                facility: uuid,
                blueprint: resource.type,
                quantity: resource.quantity,
                state: 'delivered'
            });

            resource.lastDeliveredAt = timestamp;
            delete resource.deliveryStartedAt;
        }, function(e) {
            publish({
                type: 'resources',
                account: facility.account,
                facility: uuid,
                blueprint: resource.type,
                quantity: resource.quantity,
                state: 'delivery_failed'
            });

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
    for (var facility in resources) {
        checkAndDeliverResources(facility);
    }
}, 1000);

var server = http.createServer(app);
server.listen(port);

var WebSocketServer = WebSockets.Server,
    wss = new WebSocketServer({
        server: server,
        verifyClient: function (info, callback) {
            C.authorize_req(info.req).then(function(auth) {
                info.req.authentication = auth;
                callback(true);
            }, function(e) {
                info.req.authentication = {};
                callback(false);
            });
        }
    });

var listeners = [];
wss.on('connection', function(ws) {
    listeners.push(ws);

    ws.on('close', function() {
        var i= listeners.indexOf(ws);
        if (i > -1) {
            listeners.splice(i, 1);
        }
    });
});

function publish(message) {
    console.log("publishing to %d listeners", listeners.length, message);

    listeners.forEach(function(ws) {
        var account = ws.upgradeReq.authentication.account;

        if (ws.readyState == WebSockets.OPEN && message.account == account) {
            ws.send(JSON.stringify(message));
        } else {
            console.log("owner %s !== connection %s", message.account, account);
        }
    });
}

console.log("server ready");
