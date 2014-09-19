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

function getBlueprints() {
    return qhttp.read(process.env.TECHDB_URL + '/blueprints').then(function (b){
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

    getBlueprints().then(function(blueprints) {
        var facilityType = blueprints[facility.blueprint];
        var canList = facilityType.production[job.action];
        var target = blueprints[req.body.target];

        if (!canList.some(function(e) { return e.item == job.target; })) {
            console.log(canList);
            console.log(job.target);

            res.status(400).send("facility is unable to produce that");
        }

        var promises = [];

        if (job.action == "refine") {
            job.outputs = target.refine.outputs;

            // verify space in the attached inventory after target is removed
            promises.push(consume(job.facility, job.inventory, job.target, job.quantity));
            duration = target.refine.time;
        } else {
            duration = target.build.time;

            for (var key in target.build.resources) {
                var count = target.build.resources[key];
                promises.push(consume(job.facility, job.inventory, key, count*job.quantity));
            }

            if (job.action == "construct") {
                job.quantity = 1;
            }
        }

        Q.all(promises).then(function() {
            job.finishAt = (new Date().getTime() + duration*1000*job.quantity);
            buildJobs[uuid] = job;

            res.sendStatus(201);
        }).fail(function() {
            res.sendStatus(500);
        });
    });
});

app.get('/facilities', function(req, res) {
    res.send(facilities);
});

// spodb tells us when facilities come into existance
app.post('/facilities/:uuid', function(req, res) {
    getBlueprints().then(function(blueprints) {
        var blueprint = blueprints[req.body.blueprint];

        if (blueprint) {
            var uuid = req.param('uuid');
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
    res.send(spodb);
});

function updateInventory(uuid, slice, type, quantity) {
    return qhttp.request({
        method: "POST",
        url: process.env.INVENTORY_URL + '/inventory',
        headers: { "Content-Type": "application/json" },
        body: [ JSON.stringify([{
            inventory: uuid,
            slice: slice,
            blueprint: type,
            quantity: quantity
        }]) ]
    }).then(function(resp) {
        if (resp.status !== 204) {
            throw new Error("inventory responded with " +resp.status);
        }
    }).done();
}

function consume(uuid, slice, type, quantity) {
    return updateInventory(uuid, slice, type, quantity * -1);
}

function produce(uuid, slice, type, quantity) {
    return updateInventory(uuid, slice, type, quantity);
}

var buildWorker = setInterval(function() {
    var timestamp = new Date().getTime();

    for(var uuid in buildJobs) {
        var job = buildJobs[uuid];
        if (job.finishAt < timestamp && job.finished !== true) {
            debug(job);
            job.finished = true;

            switch (job.action) {
                case "manufacture":
                    produce(job.facility, job.inventory, job.target, job.quantity);
                    break;
                case "refine":
                    for (var key in job.outputs) {
                        var count = job.outputs[key];
                        produce(job.inventory, key, count*job.quantity);
                    }
                    break;
                case "construct":
                    // in the end this will notify spodb something
                    // was changed and spodb will notify us
                    spodb[job.facility].blueprint = job.target;

                    break;
            }
        
        }
    }
}, 1000);

var server = http.createServer(app);
server.listen(port);
console.log("server ready");
