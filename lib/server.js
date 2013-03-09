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
    port: 8080,
    debug: true,
    multiplicity: 5
  }, options);

  util.debug = this._options.debug;

  // Connected clients
  /**
   * A mapping of client id to client information object and ws information
   */
  this._clients = {};

  /**
   * A mapping of resource url to a mapping of clients and boolean if they have it or not
   */
  this._resources = {};

  /**
   * A mapping of a given resource url to its size
   */
  this._resourceSizes = {};

  this._initializeWSS();

  this._initializeHTTP();
  this._httpServer.listen(this._options.port);


};

util.inherits(PeerKitServer, EventEmitter);

PeerKitServer.prototype._initializeWSS = function(){

  var self = this;

  // Create WebSocket server as well.
  this._wss = new WebSocketServer({ path: '/ws', server: this._httpServer });

  this._wss.on('connection', function(socket) {
    //var query = url.parse(socket.upgradeReq.url, true).query;
    var client = {
      id: self._generateId(),
      socket: socket,
      resources: {},
      conns: []
    };
    self._clients[client.id] = client;
    socket.on('message', function(data){
      util.log(data);
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
        case 'REPORT':
          // New resource available
          //
          // message.url (String, resource absolute url)
          //
          self._reportResource(client, {'url' : message.url, size : message.size });
          break;
        case 'REQUEST':
          // Asking for resource
          //
          // message.url (String, resource absolute url)
          //
          var type = "RESOURCE";
          var conns = self._requestResource(message.url);
          socket.send(JSON.stringify({ type : type, file : {url: message.url, size: self._resourceSizes[message.url]}, peers : conns}));
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
  this._app.enable("jsonp callback");

  this._app.get('/requestResource', function(req, res) {
    var urls = req.query.urls;
    if (!urls && !Array.isArray(urls)) {
        res.send("need array", 401);
        return;
    }
    var data = {};
    var ii = urls.length;
    for (var i = 0; i < ii; i++) {
      data[urls[i]] = {file: {url: urls[i], size: self._resourceSizes[urls[i]]}, peers: self._requestResource(urls[i])};
    }
    res.jsonp(data);
    // Get Javascript library along with necessary data
  });
};

/**
 * Tells the server that we have the resource at given url
 * @param client the ws client
 * @param resource object with both the url and size of resource
 */
PeerKitServer.prototype._reportResource = function(client, resource) {
  util.log("Resource reported:", client, resource);
  var self = this;
  if (!client.resources[resource.url]) {
    client.resources[resource.url] = true;
    if (!self._resources[resource.url]) {
      self._resources[resource.url] = {};
    }
    self._resources[resource.url][client.id] = true;
    self._resourceSizes[resource.url] = resource.size;
  }
};

/**
 * Returns a list of connections that the server has for the given url
 */
PeerKitServer.prototype._requestResource = function(url) {
  util.log("Resource requested:", url);
  var resources = this._resources[url];
  if (!resources) {
    return [];
  }
  var clients = Object.keys(resources);
  var conns = [];
  if (clients.length <= this._options.multiplicity) {
    // Add each client
    for (var i = 0; i < clients.length; i++) {
      if (this._clients[clients[i]].conns.length > 0) {
        conns.push({data: this._clients[clients[i]].conns.pop(), id: clients[i]});
      }
    }
  } else {
    var rand;
    var seen = {};
    while (conns.length < this._options.multiplicity) {
      rand = Math.floor(Math.random() * messages.length);
      if (!seen[rand]) {
        // Add a connect from that client
        conns.push({data: this._clients[clients[rand]].conns.pop(), id: clients[rand]});
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
  this._client[dest].socket.send(JSON.stringify({type: 'RESPONSE', data: data}));
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
