'use strict';

var http = require("http"),
    express = require("express"),
    logger = require('morgan'),
    bodyParser = require('body-parser'),
    uuidGen = require('node-uuid'),
    moment = require('moment'),
    npm_debug = require('debug'),
    log = npm_debug('build:info'),
    error = npm_debug('build:error'),
    debug = npm_debug('build:debug'),
    Q = require('q'),
    qhttp = require("q-io/http"),
    WebSockets = require("ws"),
    C = require('spacebox-common');

C.db.select('build');
Q.longStackSupport = true;

var app = express();
var port = process.env.PORT || 5000;

app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));

var listeners = [];

var dao = {
    facilities: {
        all: function(account) {
            if (account === undefined) {
                return C.db.exec('select * from facilities');
            } else {
                return C.db.exec('select * from facilities', [ account ]);
            }
        },
        needAttention: function() {
            return C.db.exec('select * from facilities where trigger_at is null or trigger_at < $1', [ new Date() ]);
        },
        upsert: function(uuid, doc) {
            return C.db.exec('update facilities set blueprint = $2, account = $3, resources = $4 where id =$1 returning id', [ uuid, doc.blueprint, doc.account, doc.resources ]).
                then(function(data) {
                    debug(data);
                    if (data.length === 0) {
                        return C.db.
                            exec('insert into facilities (id, blueprint, account, resources) values ($1, $2, $3, $4)', [ uuid, doc.blueprint, doc.account, doc.resources ]);
                    }
                });
        },
        destroy: function(uuid) {
            return C.db.
                exec("delete from facilities where id=$1", [ uuid ]);
        },
        get: function(uuid) {
            return C.db.
                exec("select * from facilities where id=$1", [ uuid ]).
                then(function(data) {
                    return data[0];
                });
        }
    
    },
    jobs: {
        all: function(account) {
            if (account === undefined) {
                return C.db.exec("select * from jobs");
            } else {
                return C.db.exec("select * from jobs where account=$1", [ account ]);
            }
        },
        get: function(uuid, account) {
            return C.db.
                exec("select * from jobs where id=$1 and account=$1", [ uuid, account ]).
                then(function(data) {
                    return data[0];
                });
        },
        queue: function(doc) {
            var now = new Date();
            return C.db.
                exec("insert into jobs (id, facility_id, account, doc, status, statusCompletedAt, createdAt, trigger_at) values ($1, $2, $3, $4, $5, $6, $7, $8)", [ doc.uuid, doc.facility, doc.account, doc, "queued", now, now, now ]);
        
        },
        nextJob: function(facility_id) {
            return C.db.
                exec("select * from jobs where facility_id = $1 and status != 'delivered' and next_status is null and trigger_at < $2 order by createdAt limit 1", [ facility_id, new Date() ]).
                then(function(data) {
                    return data[0];
                });
        },
        destroy: function(uuid) {
            return C.db.
                exec("delete from jobs where id =$1", [ uuid ]);
        },
        flagNextStatus: function(uuid, status) {
            return C.db.
                exec("update jobs set next_status = $2, nextStatusStartedAt = $3 where nextStatusStartedAt is null and id = $1 returning id", [ uuid, status, new Date() ]).
                then(function(data) {
                    if (data.length === 0) {
                        throw("failed to lock job "+uuid+" for "+status);
                    }
                });
        },
        completeStatus: function(uuid, status, doc) {
            return C.db.
                exec("update jobs set status = next_status, statusCompletedAt = $3, next_status = null, nextStatusStartedAt = null, doc = $4 where id = $1 and next_status = $2 returning id", [ uuid, status, new Date(), doc ]).
                then(function(data) {
                    if (data.length === 0) {
                        throw("failed to transition job "+uuid+" to "+status);
                    }
                });
        },
        failNextStatus: function(uuid, status) {
            return C.db.
                exec("update jobs set next_status = null, nextStatusStartedAt = null, where id = $1 and next_status = $2 returning id", [ uuid, status ]).
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
    debug(req.body);

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
            debug(canList);
            debug(job.target);

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
    }).fail(C.http.errHandler(req, res, error)).done();
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
    }).fail(C.http.errHandler(req, res, error)).done();
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
    }).fail(C.http.errHandler(req, res, error)).done();

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
    }).fail(C.http.errHandler(req, res, error)).done();
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
    }]).tap(C.qDebug('produce'));
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
                    error("inventory " + resp.status + " reason: " + b.toString());
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

        log("running " + job.uuid + " at " + job.facility);

        if (job.action == "refine") {
            return consume(job.account, job.facility, job.slice, job.target, job.quantity);
        } else {
            var promises = [];
            debug(target);

            for (var key in target.build.resources) {
                var count = target.build.resources[key];
                // TODO do this as a transaction
                promises.push(consume(job.account, job.facility, job.slice, key, count * job.quantity));
            }

            return Q.all(promises);
        }
    }).then(function() {
        var now = new Date();
        var timestamp = now.getTime() + (now.getTimezoneOffset() * 60000);

        job.finishAt = (timestamp + job.duration * 1000 * job.quantity);
        return dao.jobs.completeStatus(data.id, "resourcesFullfilled", job);
    }).then(function() {
        log("fullfilled " + job.uuid + " at " + job.facility);
    }).fail(function(e) {
        error("failed to fullfill " + job.uuid + " at " + job.facility + ": " + e.toString());
        error(e.stack);
        return dao.jobs.failNextStatus(data.id, "resourcesFullfilled");
    }).done();
}

function publish(message) {
    log("publishing to %d listeners", listeners.length, message);

    listeners.forEach(function(ws) {
        var account = ws.upgradeReq.authentication.account;

        if (ws.readyState == WebSockets.OPEN && message.account == account) {
            ws.send(JSON.stringify(message));
        } else {
            error("owner %s !== connection %s", message.account, account);
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
                return C.request('3dsim', 'POST', 204, '/spodb/'+job.facility, {
                    blueprint: job.target });
            }).then(function() {
                return C.getBlueprints().then(function(blueprints) {
                    var blueprint = blueprints[job.target];

                    // If a scaffold was upgraded to a non-production
                    // structure, remove the facility tracking
                    if (blueprint.production === undefined) {
                        return destroyFacility(job.facility);
                    } else {
                        return updateFacility(job.facility, blueprint, job.account);
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

    var now = new Date();
    var timestamp = now.getTime() + (now.getTimezoneOffset() * 60000);

    if (job.finishAt > timestamp)
        return;

    return dao.jobs.flagNextStatus(data.id, "delivered").
        then(function() {
            return deliverJob(job);
        }).then(function() {
            return dao.jobs.completeStatus(data.id, "delivered", job);
        }).then(function() {
            log("delivered " + job.uuid + " at " + facility);

            publish({
                account: job.account,
                type: 'job',
                uuid: job.uuid,
                facility: job.facility,
                state: 'delivered',
            });
        }, function(e) {
            error("failed to deliver job in " + facility + ": " + e.toString());
            delete job.deliveryStartedAt;
        });
}

function checkAndProcessFacilityJob(facility) {
    return dao.jobs.nextJob(facility.id).then(function(data) {
        if (data === undefined) {
            log("no matching jobs in "+facility.id);
            return;
        
        } else {
            debug(data);
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
    var now = new Date();
    var timestamp = now.getTime() + (now.getTimezoneOffset() * 60000);

    debug('resource processing', facility);

    var resource = facility.resources;

    if (facility.resourceslastdeliveredat === null) {
        // The first time around this is just a dummy
        return Q(C.db.exec("update facilities set resourcedeliverystartedat = null, resourceslastdeliveredat = $2 where id = $1", [ uuid, new Date() ]));
    } else if (
        moment(facility.resourceslastdeliveredat).add(resource.period, 's').isBefore(moment()) &&
            facility.resourcedeliverystartedat === null
    ) {
        return Q(C.db.exec("update facilities set resourcedeliverystartedat = $2 where id = $1", [ uuid, new Date() ])).then(function() {
            return produce(facility.account, uuid, 'default', resource.type, resource.quantity);
        }).tap(C.qDebug('checkAndDeliver')).then(function() {
            publish({
                type: 'resources',
                account: facility.account,
                facility: uuid,
                blueprint: resource.type,
                quantity: resource.quantity,
                state: 'delivered'
            });

            return C.db.exec("update facilities set resourcedeliverystartedat = null, next_backoff = 1, resourceslastdeliveredat = $2, trigger_at = $3 where id = $1",
                            [ uuid, new Date(), moment().add(resource.period, 's').toDate() ]);
        }).fail(function(e) {
            error("failed to deliver resources from "+uuid+": "+e.toString());

            publish({
                type: 'resources',
                account: facility.account,
                facility: uuid,
                blueprint: resource.type,
                quantity: resource.quantity,
                state: 'delivery_failed'
            });

            return C.db.exec("update facilities set resourcedeliverystartedat = null, next_backoff = $2 where id = $1",
                            [ uuid, facility.next_backoff * 2, moment(facility.trigger_at).add(facility.next_backoff, 's').toDate() ]);
        });
    } else {
        if (facility.resourcedeliverystartedat) {
            log("delivery was started for "+uuid+" and I'm still waiting");
        } else {
            log(uuid+" is waiting for "+moment(facility.resourceslastdeliveredat).add(resource.period, 's').diff(moment()));
        }
    }

    return Q(null);
}

var buildWorker = setInterval(function() {
    log("processing jobs");

    // TODO use an iterator
    dao.facilities.needAttention().then(function(data) {
        debug('data', data);

        return Object.keys(data).map(function(i) {
            var facility = data[i];

            debug('facility', facility);

            if (facility.resources === null) {
                return checkAndProcessFacilityJob(facility);
            } else {
                return checkAndDeliverResources(facility);
            }
        });
    }).all().done();
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
