var express = require('express');
var http = require('http');
var https = require('https');
var WebSocket = require('ws');
var WebSocketServer = WebSocket.Server;
var EventEmitter = require('events').EventEmitter;
var util = require('./util');
var url = require('url');
var async = require('async');

function PeerKitServer(options) {
  if (!(this instanceof PeerKitServer)) return new PeerKitServer(options);
  EventEmitter.call(this);

  this._app = express();
  this._httpServer = http.createServer(this._app);

  this._options = util.extend({
    port: 8080,
    debug: true,
    multiplicity: 2,
    connExpiry: 20000,
    peerMaxConns: 10
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

  
  this._initializeWSS();

  this._initializeHTTP();
  this._httpServer.listen(this._options.port);

  util.log('Server started on '  + this._options.port);

  
  var self = this;
  setInterval(function(){
    console.log('=== ' + (new Date()).toString() + ' ===');
    console.log('Total clients: ' + Object.keys(self._clients).length);
    for ( var key in self._resources ) {
      console.log(key, ':', self._resources[key]);
    }
    /*(console.log('===========');
    for ( var key in self._clients ) {
      console.log(key, ':', self._clients[key].conns.length);
    }*/
  }, 30000);
};

util.inherits(PeerKitServer, EventEmitter);

PeerKitServer.VALID_HOSTNAMES = {'www.google.com': true, 'demo.peerkit.com': true};

PeerKitServer.prototype._initializeWSS = function(){

  var self = this;

  // Create WebSocket server as well.
  this._wss = new WebSocketServer({ path: '/ws', server: this._httpServer });

  this._wss.on('connection', function(socket) {
    //var query = url.parse(socket.upgradeReq.url, true).query;
    util.log('Got new connection');
    var client = {
      id: self._generateId(),
      socket: socket,
      resources: {},
      conns: [],
      send: function(msg){
        if (socket.readyState == WebSocket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      }
    };
    self._clients[client.id] = client;
    socket.on('message', function(data){
      var message;
      try {
        message = JSON.parse(data);
        if (!message.type) {
          throw new Error('Invalid message format: missing type');
        }
        util.log('Got message', message.type);
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
          break;
        case 'REPORT':
          // New resource available
          //
          // message.url (String, resource absolute url)
          //
          self._reportResource(client, {'url' : message.url});
          break;
        case 'REQUEST':
          // Asking for resource
          //
          // message.url (String, resource absolute url)
          //
          var resp = self._requestResource(message.url);
          resp.type = 'RESOURCE';
          client.send(resp);
          break;
        case 'CONN':
          // Connection information to store
          //
          // message.conn (mixed data)
          //
          if (client.conns.length < self._options.peerMaxConns) {
            client.conns.push({data: message.conn, expiry: (new Date()).getTime()});
          }
          break;
        case 'INVALID':
          // Invalid peer data received
          // .id
          // .url
          util.log('Invalid peer reported due to URL', message.url);
          self._killClient(message.id);
          break;
        case 'SERVED':
          // Served a file, increment analytics
          break;
        default:
          util.log('Message unrecognized');
      }
    });
    socket.on('close', function() {
      self._killClient(client.id);
    });
    socket.on('error', function() {
      self._killClient(client.id);
    });
  });
};

PeerKitServer.prototype._killClient = function(id){
  util.log('Socket closed:', id);
  if (this._clients[id]) {
    var resources = this._clients[id].resources;
    var hashes = Object.keys(resources);
    for (var i = 0, ii = hashes.length; i < ii; i++) {
      if (this._resources[hashes[i]]) {
        delete this._resources[hashes[i]].clients[id];
      }
    }
    delete this._clients[id];
  }
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
    util.log('Got resource request', req.query.urls);
    var urls = req.query.urls;
    if (!urls || !Array.isArray(urls)) {
      res.send("Need array", 401);
      return;
    }
    var data = {};
    var ii = urls.length;
    for (var i = 0; i < ii; i++) {
      if (urls[i] != "") {
        data[urls[i]] = self._requestResource(urls[i]);
      }
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
  util.log("Resource reported:", client.id, resource);
  var self = this;
  if (!client.resources[resource.url]) {
    client.resources[resource.url] = true;
    if (!this._resources[resource.url]) {
      this._getChunks(resource, function(err, size, chunks){
        if (err) {
          delete client.resources[resource.url];
          return;
        }
        resource.chunks = chunks;
        resource.size = size;
        self._resources[resource.url] = {clients: {}, resource: resource};
        self._resources[resource.url].clients[client.id] = true;
      });
    } else {
      this._resources[resource.url].clients[client.id] = true;
    }
  }
};


// TODO: Use a better memoize that expires after time
PeerKitServer.prototype._getChunks = async.memoize(function(resource, cb) {
  var parsedUrl = url.parse(resource.url);
  if (!PeerKitServer.VALID_HOSTNAMES[parsedUrl.hostname]) {
    util.log('Failed to get chunk due to invalid hostname', resource.url);
    cb('Invalid file hostname', null, null);
    return;
  }
  ((parsedUrl.protocol == 'https:') ? https : http).get(resource.url, function(res) {
    if (res.statusCode !== 200) {
      cb('Could not get file', null, null);
      return;
    }

    var len = parseInt(res.headers['content-length'], 10);
    if (!len || len < 1) {
      cb('Could not get file', null, null);
      return;
    }
    
    var chunkSize = Math.round(Math.max(500, Math.min(500000, len/10)));

    var index = 0;
    
    var chunks = [];
    
    var data;
    
    res.on('readable', function(){
      while((data = res.read(chunkSize)) != null) {
        //console.log('read');
        chunks.push({start: index, end: index + data.length, hash: util.hash(data)});
        index += data.length;
      }
    });
    res.on('end', function(){
      cb(null, len, chunks);
    });
  }).on('error', function(e) {
    cb('Could not get file', null, null);
    // Noop the callback
    cb = function(){};
  });
}, function(res){
  return res.url;
});

/**
 * Returns a list of connections that the server has for the given url
 */
PeerKitServer.prototype._requestResource = function(url) {
  util.log("Resource requested:", url);
  var resource = this._resources[url];
  if (!resource) {
    return {file : {url: url}, peers : []};
  }
  var response = {
    file : resource.resource,
    peers : []
  }
  var clients = Object.keys(resource.clients);
  var conns = [];
  var startIndex = 0, endIndex = clients.length;
  if (clients.length > this._options.multiplicity) {
    startIndex = Math.floor(Math.random() * (clients.length - this._options.multiplicity + 1));
    endIndex = startIndex + this._options.multiplicity;
  }
  for (var i = startIndex; i < endIndex; i++) {
    
    if (this._clients[clients[i]].conns.length > 0) {
      // Add a connect from that client
      var conn = this._clients[clients[i]].conns.pop();
      if (!this._options.connExpiry || (((new Date()).getTime() - conn.expiry) < this._options.connExpiry)) {        
        conns.push({data: conn.data, id: clients[i]});
      } else {
        this._clients[clients[i]].conns = [];
      }
      this._requestConns(clients[i], 1);
    }
  }

  response.peers = conns;
  //console.log('Found', conns.length, 'connections');
  return response;
};

PeerKitServer.prototype._requestConns = function(id, count) {
  this._clients[id].send({type: 'REPLENISH', count: count});
};

PeerKitServer.prototype._forward = function(dest, data) {
  //console.log('sending respones', dest);
  
  if (!this._clients[dest]) {
    return {error: 'Client gone'};
  }
  this._clients[dest].send({type: 'RESPONSE', data: data});
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
