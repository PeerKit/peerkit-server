var express = require('express');
var http = require('http');
var WebSocketServer = require('ws').Server;
var EventEmitter = require('events').EventEmitter;
var util = require('./util');
var url = require('url');

function PeerKitServer(options) {
  if (!(this instanceof PeerKitServer)) return new PeerKitServer(options);
  EventEmitter.call(this);

  this._app = express();
  this._httpServer = http.createServer(this._app);

  this._options = util.extend({
    port: 80,
    debug: false,
    multiplicity: 5
  }, options);

  util.debug = this._options.debug;

  // Connected clients
  this._clients = {};
  this._resources = {};

  this._initializeWSS();

  this._initializeHTTP();


};

util.inherits(PeerKitServer, EventEmitter);

PeerKitServer.prototype._initializeWSS = function(){

  var self = this;

  // Create WebSocket server as well.
  this._wss = new WebSocketServer({ path: '/ws', server: this._httpServer });

  this._wss.on('connection', function(socket) {
    //var query = url.parse(socket.upgradeReq.url, true).query;
    var client = {
      id: self.generateId(),
      socket: socket,
      resources: {},
      conns: []
    };
    this._clients[client.id] = client;
    socket.on('message', function(data){
      var message;
      try {
        message = JSON.parse(data);
        if (!message.type) {
          throw new Error('Invalid message format: missing type');
        }
      } catch(e) {
        if (self.debug) {
          throw e;
        }
        util.log('Invalid message', data);
        return;
      }
      switch (message.type) {
        case 'RESPONSE':
          // Response to offer with ICE and answer
          //
          // message.id   (String, id of destination)
          // message.data (String, JSON of ice and answer)
          //
          var resp = self._forward(message.id, message.data);
          /*if (resp.error) {
            socket.send(JSON.stringify(
              type: 'ERROR-CLIENT-DEAD',

            ));
          }*/
          break;
        case 'RESOURCE':
          // New resource available
          //
          // message.url (String, resource absolute url)
          //
          if (!client.resources[message.url]) {
            client.resources[message.url] = true;
            if (!self._resources[message.url]) {
              self._resources[message.url] = {};
            }
            self._resources[message.url][client.id] = true;
          }
          break;
        case 'CONN':
          // Connection information to store
          //
          // message.conn (mixed data)
          //
          client.conns.push(message.conn);
          break;
        case 'SERVED':
          // Served a file, increment analytics
          break;
        default:
          util.log('Message unrecognized');
      }
    });
    socket.on('close', function() {
      util.log('Socket closed:', client.id);
      var resources = client.resources;
      var hashes = Object.keys(resources);
      var ii = hashes.length;
      for (var i = 0; i < ii; i++) {
        delete self._resources[hashes[i]][client.id];
      }
      delete self._clients[client.id];
    });
  });
};

PeerKitServer.prototype._initializeHTTP = function(){
  var self = this;

  /*this._app.post('/response', function(req, res){
    // Responding to an offer with ICE and answer
    //
    // params.id    (String, id of destination)
    // body.data    (String, JSON of ice and answer
    //
    var resp = self._forward(req.params.id, req.body.data);
    res.send(resp);
  });*/

  this._app.get('/resource', function(req, res) {
    var urls = req.query.urls;
    if (!Array.isArray(urls)) {
        res.send("need array", 401);
    }
    var data = {};
    for (var i = 0, ii = urls.length; i < ii; i++) {
      data[urls[i]] = self._resourcePeerConn(url);
    }
    res.send('PeerKitJSONP('+JSON.stringify(data)+');');
    // Get Javascript library along with necessary data
  });
  this._app.listen(8080);
};

PeerKitServer.prototype._resourcePeerConn = function(url) {
  var clients = Object.keys(this._resources[url]);
  var conns = [];
  if (clients.length <= this._options.multiplicity) {
    // Add each client
    for (var i = 0; i < clients.length; i++) {
      conns.push(this._clients[clients[i]].conns.pop());
    }
  } else {
    var rand;
    var seen = {};
    while (conns.length < this._options.multiplicity) {
      rand = Math.floor(Math.random() * messages.length);
      if (!seen[rand]) {
        // Add a connect from that client
        conns.push(this._clients[clients[rand]].conns.pop());
        seen[rand] = true;
      }
    }
  }
  return conns;
};

PeerKitServer.prototype._forward = function(dest, data) {
  if (!this._clients[dest]) {
    return {error: 'Client gone'};
  }
  this._client[dest].socket.send(data);
  return {success: true};
};

PeerKitServer.prototype._generateId = function(key) {
  var clientId = util.randomId();
  while (!!this._clients[clientId]) {
    clientId = util.randomId();
  }
  return clientId;
};

module.exports = PeerKitServer;
