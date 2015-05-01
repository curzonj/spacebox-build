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

var pgpLib = require('pg-promise');
var pgp = pgpLib(/*options*/);
var database_url = process.env.DATABASE_URL || process.env.BUILD_DATABASE_URL;
var db = pgp(database_url);


var app = express();
var port = process.env.PORT || 5000;

Q.longStackSupport = true;

app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));

var listeners = [];

var spodb = { };

var dao = {
    facilities: {
        all: function(account) {
            if (account === undefined) {
                return db.query("select * from facilities");
            } else {
                return db.query("select * from facilities where account=$1", [ account ]);
            }
        },
        upsert: function(uuid, doc) {
            return db.
                query("update facilities set blueprint = $2, account = $3, resources = $4 where id =$1 returning id", [ uuid, doc.blueprint, doc.account, doc.resources ]).
                then(function(data) {
                    console.log(data);
                    if (data.length === 0) {
                        return db.
                            query("insert into facilities (id, blueprint, account, resources) values ($1, $2, $3, $4)", [ uuid, doc.blueprint, doc.account, doc.resources ]);
                    }
                });
        },
        destroy: function(uuid) {
            return db.
                query("delete from facilities where id =$1", [ uuid ]);
        },
        get: function(uuid) {
            return db.
                query("select * from facilities where id=$1", [ uuid ]).
                then(function(data) {
                    return data[0];
                });
        }
    
    },
    jobs: {
        all: function(account) {
            if (account === undefined) {
                return db.query("select * from jobs");
            } else {
                return db.query("select * from jobs where account=$1", [ account ]);
            }
        },
        get: function(uuid, account) {
            return db.
                query("select * from jobs where id=$1 and account=$1", [ uuid, account ]).
                then(function(data) {
                    return data[0];
                });
        },
        queue: function(doc) {
            return db.
                query("insert into jobs (id, facility_id, account, doc, status, statusCompletedAt, createdAt) values ($1, $2, $3, $4, $5, $6, $7)", [ doc.uuid, doc.facility, doc.account, doc, "queued", new Date(), new Date() ]);
        
        },
        nextJob: function(facility_id) {
            return db.
                query("select * from jobs where facility_id = $1 and status != 'delivered' and next_status is null order by createdAt limit 1", [ facility_id ]).
                then(function(data) {
                    return data[0];
                });
        },
        destroy: function(uuid) {
            return db.
                query("delete from jobs where id =$1", [ uuid ]);
        },
        flagNextStatus: function(uuid, status) {
            return db.
                query("update jobs set next_status = $2, nextStatusStartedAt = $3 where nextStatusStartedAt is null and id = $1 returning id", [ uuid, status, new Date() ]).
                then(function(data) {
                    if (data.length === 0) {
                        throw("failed to lock job "+uuid+" for "+status);
                    }
                });
        },
        completeStatus: function(uuid, status, doc) {
            return db.
                query("update jobs set status = next_status, statusCompletedAt = $3, next_status = null, nextStatusStartedAt = null, doc = $4 where id = $1 and next_status = $2 returning id", [ uuid, status, new Date(), doc ]).
                then(function(data) {
                    if (data.length === 0) {
                        throw("failed to transition job "+uuid+" to "+status);
                    }
                });
        },
        failNextStatus: function(uuid, status) {
            return db.
                query("update jobs set next_status = null, nextStatusStartedAt = null, where id = $1 and next_status = $2 returning id", [ uuid, status ]).
                then(function(data) {
                    if (data.length === 0) {
                        throw("failed to fail job transition "+uuid+" to "+status);
                    }
                });
        }
    }
};

function hashForEach(obj, fn) {
    for (var k in obj) {
        fn(k, obj[k]);
    }
}

app.get('/jobs/:uuid', function(req, res) {
    C.authorize_req(req).then(function(auth) {
        dao.jobs.get(req.param('uuid'), auth.account).
            then(function(data) {
                res.send(data);
            });
    });
});

app.get('/jobs', function(req, res) {
    C.authorize_req(req).then(function(auth) {
        dao.jobs.
            all(auth.privileged && req.param('all') == 'true' ? undefined : auth.account).
            then(function(data) {
                res.send(data);
            });
    });
});

app.get('/jobs', function(req, res) {
    C.authorize_req(req).then(function(auth) {
        dao.jobs.
            all(auth.privileged && req.param('all') == 'true' ? undefined : auth.account).
            then(function(data) {
                res.send(data);
            });
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
    console.log(req.body);

    var job = req.body;
    var duration = -1;

    job.uuid = uuidGen.v1();

    Q.spread([C.getBlueprints(), C.authorize_req(req), dao.facilities.get(job.facility)], function(blueprints, auth, facility) {
        if (facility === undefined) {
            return res.status(404).send("no such facility: " + job.facility);
        }

        var facilityType = blueprints[facility.blueprint];
        var canList = facilityType.production[job.action];
        var target = blueprints[job.target];

        // Must wait until we have the auth response to check authorization
        if (facility.account != auth.account) {
            return res.status(401).send("not authorized to access that facility");
        }

        if (canList === undefined || !canList.some(function(e) {
            return e.item == job.target;
        })) {
            console.log(canList);
            console.log(job.target);

            return res.status(400).send("facility is unable to produce that");
        }

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

        return dao.jobs.queue(job).then(function() {
            res.status(201).send({
                job: {
                    uuid: job.uuid
                }
            });
        });
    }).fail(function(e) {
        console.log(e);
        console.log(e.stack);
        res.status(500).send(e.toString());
    }).done();
});

app.get('/facilities', function(req, res) {
    C.authorize_req(req).then(function(auth) {
        if (auth.privileged && req.param('all') == 'true') {
            return dao.facilities.all();
        } else {
            return dao.facilities.all(auth.account);
        }
    }).then(function(list) {
        res.send(list);
    }).fail(function(e) {
        console.log(e);
        console.log(e.stack);
        res.status(500).send(e.toString());
    }).done();
});

function updateFacility(uuid, blueprint, account) {
    if (blueprint.production === undefined) {
        throw new Error(uuid+" is not a production facility");
    }

    return dao.facilities.upsert(uuid, {
        blueprint: blueprint.uuid, 
        account: account,
        resources: blueprint.production.generate
    }).then(function() {
        publish({
            type: 'facility',
            account: account,
            uuid: uuid,
            blueprint: blueprint.uuid,
        });

        // Not every facility is a structure. placeholder
        // until spodb is external and is the one calling us
        if (blueprint.type == "structure" || blueprint.type == "deployable") {
            spodb[uuid] = {
                blueprint: uuid
            };
        }
    });
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
    return dao.facilities.get(uuid).then(function(facility) {
        publish({
            type: 'facility',
            account: facility.account,
            tombstone: true,
            uuid: uuid,
            blueprint: facility.blueprint,
        });
    }).then(function() {
        // delete running_jobs[uuid]; TODO when should jobs be cleaned up?
        // delete queued_jobs[uuid];

        return dao.facilities.destroy(uuid);
    });
}

// When a ship or production structure is destroyed
app.delete('/facilities/:uuid', function(req, res) {
    destroyFacility(req.param('uuid')).then(function() {
        res.sendStatus(204);
    }).fail(function(e) {
        console.log(e);
        console.log(e.stack);
        res.status(500).send(e.toString());
    }).done();

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
            return updateFacility(uuid, blueprint, auth.account).then(function() {
                res.status(201).send({
                    facility: {
                        uuid: uuid
                    }
                });
            });
        } else {
            res.status(400).send("no such blueprint");
        }
    }).fail(function(e) {
        console.log(e);
        console.log(e.stack);
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

function fullfillResources(data) {
    var job = data.doc;

    return Q.all([
        C.getBlueprints(),
        dao.jobs.flagNextStatus(data.id, "resourcesFullfilled")
    ]).spread(function(blueprints) {
        var target = blueprints[job.target];

        publish({
            type: 'job',
            account: job.account,
            uuid: job.uuid,
            facility: job.facility,
            state: 'started',
        });

        console.log("running " + job.uuid + " at " + job.facility);

        if (job.action == "refine") {
            return consume(job.account, job.facility, job.slice, job.target, job.quantity);
        } else {
            var promises = [];
            console.log(target);

            for (var key in target.build.resources) {
                var count = target.build.resources[key];
                // TODO do this as a transaction
                promises.push(consume(job.account, job.facility, job.slice, key, count * job.quantity));
            }

            return Q.all(promises);
        }
    }).then(function() {
        job.finishAt = (new Date().getTime() + job.duration * 1000 * job.quantity);
        return dao.jobs.completeStatus(data.id, "resourcesFullfilled", job);
    }).then(function() {
        console.log("fullfilled " + job.uuid + " at " + job.facility);
    }).fail(function(e) {
        console.log("failed to fullfill " + job.uuid + " at " + job.facility + ": " + e.toString());
        console.log(e.stack);
        return dao.jobs.failNextStatus(data.id, "resourcesFullfilled");
    }).done();
}

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

function jobDeliveryHandling(data) {
    var job = data.doc;
    var facility = data.facility_id;

    if (job.finishAt > new Date().getTime())
        return;

    return dao.jobs.flagNextStatus(data.id, "delivered").
        then(function() {
            return deliverJob(job);
        }).then(function() {
            return dao.jobs.completeStatus(data.id, "delivered", job);
        }).then(function() {
            console.log("delivered " + job.uuid + " at " + facility);

            publish({
                account: job.account,
                type: 'job',
                uuid: job.uuid,
                facility: job.facility,
                state: 'delivered',
            });
        }, function(e) {
            console.log("failed to deliver job in " + facility + ": " + e.toString());
            delete job.deliveryStartedAt;
        });
}

function checkAndProcessFacilityJob(facility) {
    return dao.jobs.nextJob(facility.id).then(function(data) {
        if (data === undefined) {
            console.log("no matching jobs");
            return;
        
        } else {
            console.log(data);
        }

        switch(data.status) {
            case "queued":
                return fullfillResources(data);
            case "resourcesFullfilled":
                return jobDeliveryHandling(data);
            case "delivered":
                //return dao.jobs.destroy(data.id);
        }
    });
}

function checkAndDeliverResources(facility) {
    var uuid = facility.id;
    var timestamp = new Date().getTime();

    var resource = facility.resources;

    if (facility.resourcesLastDeliveredAt === null) {
        // The first time around this is just a dummy
        return db.query("update facilities set resourceDeliveryStartedAt = null, resourcesLastDeliveredAt = $? where id = $1", [ uuid, new Date() ]);
    } else if (((facility.resourcesLastDeliveredAt.getTime() + resource.period) < timestamp) && facility.resourceDeliveryStartedAt === undefined) {
        db.query("update facilities set resourceDeliveryStartedAt = $2 where id = $1", [ uuid, new Date() ]).then(function() {
            return produce(facility.account, uuid, 'default', resource.type, resource.quantity);
        }).then(function() {
            publish({
                type: 'resources',
                account: facility.account,
                facility: uuid,
                blueprint: resource.type,
                quantity: resource.quantity,
                state: 'delivered'
            });

            return db.query("update facilities set resourceDeliveryStartedAt = null, resourcesLastDeliveredAt = $? where id = $1", [ uuid, new Date() ]);
        }).fail(function(e) {
            publish({
                type: 'resources',
                account: facility.account,
                facility: uuid,
                blueprint: resource.type,
                quantity: resource.quantity,
                state: 'delivery_failed'
            });

            console.log("failed to deliver resources from "+uuid+": "+e.toString());
            return db.query("update facilities set resourceDeliveryStartedAt = null where id = $1", [ uuid ]);
        }).done();
    } else {
        if (facility.resourceDeliveryStartedAt) {
            console.log("delivery was started for "+uuid+" and I'm still waiting");
        } else {
            console.log(uuid+" is waiting until "+timestamp+" is greater than "+(facility.resourcesLastDeliveredAt.getTime()+resource.period)+ " "+((facility.resourcesLastDeliveredAt.getTime() + resource.period) > timestamp)+" "+(timestamp - facility.resourcesLastDeliveredAt));
        }
    }

    return Q(null); // jshint ignore:line
}

var buildWorker = setInterval(function() {
    console.log("processing jobs");

    dao.facilities.all().then(function(data) {
        console.log('data', data);
        for (var i in data) {
            var facility = data[i];

            console.log('facility', facility);

            if (facility.resources === null) {
                checkAndProcessFacilityJob(facility).done();
            } else {
                checkAndDeliverResources(facility).done();
            }
        }
    });
}, 1000); // TODO don't let runs overlap

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

wss.on('connection', function(ws) {
    listeners.push(ws);

    ws.on('close', function() {
        var i= listeners.indexOf(ws);
        if (i > -1) {
            listeners.splice(i, 1);
        }
    });
});

console.log("server ready");
