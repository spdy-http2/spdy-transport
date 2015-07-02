'use strict';

var util = require('util');
var transport = require('../spdy-transport');

var debug = {
  server: require('debug')('spdy:connection:server'),
  client: require('debug')('spdy:connection:client')
};
var EventEmitter = require('events').EventEmitter;

var Stream = transport.Stream;

function Connection(socket, options) {
  EventEmitter.call(this);

  var state = {};
  this._spdyState = state;

  // NOTE: There's a big trick here. Connection is used as a `this` argument
  // to the wrapped `connection` event listener.
  // socket end doesn't necessarly mean connection drop
  this.httpAllowHalfOpen = true;

  // Socket timeout
  this.timeout = options.server && options.server.timeout || 0;

  // Protocol info
  state.protocol = transport.protocol[options.protocol];
  state.version = null;
  state.constants = state.protocol.constants;
  state.pair = null;
  state.isServer = options.isServer;

  // Root of priority tree (i.e. stream id = 0)
  state.priorityRoot = new transport.Priority({
    defaultWeight: state.constants.DEFAULT_WEIGHT,
    maxCount: transport.protocol.base.constants.MAX_PRIORITY_STREAMS
  });

  // Defaults
  state.maxStreams = options.maxStreams ||
                     state.constants.MAX_CONCURRENT_STREAMS;

  state.autoSpdy31 = options.protocol.name !== 'h2' && options.autoSpdy31;
  state.acceptPush = options.acceptPush === undefined ?
      !state.isServer :
      options.acceptPush;

  if (options.maxChunk === false)
    state.maxChunk = Infinity;
  else if (options.maxChunk === undefined)
    state.maxChunk = transport.protocol.base.constants.DEFAULT_MAX_CHUNK;
  else
    state.maxChunk = options.maxChunk;

  // Connection-level flow control
  var windowSize = options.windowSize || 1 << 20;
  state.window = new transport.Window({
    id: 0,
    isServer: state.isServer,
    recv: { size: state.constants.DEFAULT_WINDOW },
    send: { size: state.constants.DEFAULT_WINDOW }
  });

  // It starts with DEFAULT_WINDOW, update must be sent to change it on client
  state.window.recv.setMax(windowSize);

  // Boilerplate for Stream constructor
  state.streamWindow = new transport.Window({
    id: -1,
    isServer: state.isServer,
    recv: { size: windowSize },
    send: { size: state.constants.DEFAULT_WINDOW }
  });

  // Interleaving configuration
  state.maxChunk = options.maxChunk === undefined ? 8 * 1024 : options.maxChunk;

  // Various state info
  state.pool = state.protocol.compressionPool.create(options.headerCompression);
  state.counters = {
    push: 0,
    stream: 0
  };

  // Init streams list
  state.stream = {
    map: {},
    count: 0,
    nextId: state.isServer ? 2 : 1,
    lastId: 0
  };
  state.ping = {
    nextId: state.isServer ? 2 : 1,
    map: {}
  };
  state.goaway = false;

  // Debug
  state.debug = state.isServer ? debug.server : debug.client;

  // X-Forwarded feature
  state.xForward = null;

  // Create parser and hole for framer
  state.parser = state.protocol.parser.create({
    // NOTE: needed to distinguish ping from ping ACK in SPDY
    isServer: state.isServer,
    window: state.window
  });
  state.framer = state.protocol.framer.create({
    window: state.window
  });

  // SPDY has PUSH enabled on servers
  if (state.protocol.name === 'spdy')
    state.framer.enablePush(state.isServer);

  if (!state.isServer)
    state.parser.skipPreface();

  this.socket = socket;
  this.encrypted = socket.encrypted;

  this._init();
}
util.inherits(Connection, EventEmitter);
exports.Connection = Connection;

Connection.create = function create(socket, options) {
  return new Connection(socket, options);
};

Connection.prototype._init = function init() {
  var self = this;
  var state = this._spdyState;
  var pool = state.pool;

  // Initialize session window
  state.window.recv.on('drain', function() {
    self._onSessionWindowDrain();
  });

  // Initialize parser
  state.parser.on('data', function(frame) {
    self._handleFrame(frame);
  });
  state.parser.once('version', function(version) {
    self._onVersion(version);
  });

  // Propagate parser errors
  state.parser.on('error', function(err) {
    self._onParserError(err);
  });

  // Propagate framer errors
  state.framer.on('error', function(err) {
    self.emit('error', err);
  });

  this.socket.pipe(state.parser);
  state.framer.pipe(this.socket);

  // 2 minutes socket timeout
  if (this.socket.setTimeout)
    this.socket.setTimeout(this.timeout);
  this.socket.once('timeout', function ontimeout() {
    if (self.socket.destroy)
      self.socket.destroy();
  });

  // Allow high-level api to catch socket errors
  this.socket.on('error', function onSocketError(e) {
    self.emit('error', e);
  });

  this.socket.once('close', function onclose() {
    var err = new Error('socket hang up');
    err.code = 'ECONNRESET';
    self.destroyStreams(err);
    self.emit('close', err);

    if (state.pair)
      pool.put(state.pair);
  });

  // Do not allow half-open connections
  this.socket.allowHalfOpen = false;
};

Connection.prototype._onVersion = function _onVersion(version) {
  var state = this._spdyState;
  var prev = state.version;
  var parser = state.parser;
  var framer = state.framer;
  var pool = state.pool;

  state.version = version;

  // Ignore transition to 3.1
  if (!prev) {
    state.pair = pool.get(version);
    parser.setCompression(state.pair);
    framer.setCompression(state.pair);
  }
  framer.setVersion(version);

  if (!state.isServer)
    framer.prefaceFrame();

  // Send preface+settings frame (once)
  framer.settingsFrame({
    max_header_list_size: state.constants.DEFAULT_MAX_HEADER_LIST_SIZE,
    max_concurrent_streams: state.maxStreams,
    enable_push: state.acceptPush ? 1 : 0,
    initial_window_size: state.window.recv.max
  });

  // Update session window
  if (state.version >= 3.1 || (state.isServer && state.autoSpdy31))
    this._onSessionWindowDrain();

  this.emit('version', version);
};

Connection.prototype._onParserError = function _onParserError(err) {
  var state = this._spdyState;

  // Prevent further errors
  this.socket.unpipe(this.parser);

  // Send GOAWAY
  if (err instanceof transport.protocol.base.utils.ProtocolError) {
    this._goaway({
      lastId: state.stream.lastId,
      code: err.code,
      extra: err.message,
      send: true
    });
  }

  this.emit('error', err);
};

Connection.prototype._handleFrame = function _handleFrame(frame) {
  var state = this._spdyState;

  state.debug('id=0 frame', frame);

  // For testing purposes
  this.emit('frame', frame);

  var stream;

  // Session window update
  if (frame.type === 'WINDOW_UPDATE' && frame.id === 0) {
    if (state.version < 3.1 && state.autoSpdy31) {
      state.debug('id=0 switch version to 3.1');
      state.version = 3.1;
      this.emit('version', 3.1);
    }
    state.window.send.update(frame.delta);
    return;
  }

  if (!stream && frame.id !== undefined) {
    // Load created one
    stream = state.stream.map[frame.id];

    // RST maybe out of sync
    if (!stream && frame.type === 'RST')
      return;

    // Fail if not found
    if (!stream && frame.type !== 'HEADERS') {
      state.debug('id=0 stream=%d not found', frame.id);
      state.framer.rstFrame({ id: frame.id, code: 'INVALID_STREAM' });
      return;
    }
  }

  // Create new stream
  if (!stream && frame.type === 'HEADERS') {
    this._handleHeaders(frame);
    return;
  }

  if (stream) {
    stream._handleFrame(frame);
  } else if (frame.type === 'SETTINGS') {
    this._handleSettings(frame.settings);
  } else if (frame.type === 'PING') {
    this._handlePing(frame);
  } else if (frame.type === 'GOAWAY') {
    this._handleGoaway(frame);
  } else if (frame.type === 'X_FORWARDED') {
    state.xForward = frame.host;
  } else {
    console.error('Unknown type: ', frame.type);
  }
};

Connection.prototype._isGoaway = function _isGoaway(id) {
  var state = this._spdyState;
  if (state.goaway && state.goaway < id)
    return true;
  return false;
};

Connection.prototype._getId = function _getId() {
  var state = this._spdyState;

  var id = state.stream.nextId;
  state.stream.nextId += 2;
  return id;
};

Connection.prototype._createStream = function _createStream(uri) {
  var state = this._spdyState;
  var id = uri.id;
  if (id === undefined)
    id = this._getId();

  if (this._isGoaway(id))
    return false;

  if (uri.push && !state.acceptPush) {
    state.debug('id=0 push disabled promisedId=%d', id);

    // Fatal error
    this._goaway({
      lastId: state.stream.lastId,
      code: 'PROTOCOL_ERROR',
      send: true
    });
    return false;
  }

  var stream = new Stream(this, {
    id: id,
    request: uri.request !== false,
    method: uri.method,
    path: uri.path,
    host: uri.host,
    priority: uri.priority,
    headers: uri.headers
  });
  var self = this;

  state.stream.lastId = Math.max(state.stream.lastId, id);

  state.debug('id=0 add stream=%d', stream.id);
  state.stream.map[stream.id] = stream;
  state.stream.count++;
  state.counters.stream++;

  stream.once('close', function() {
    self._removeStream(stream);
  });

  return stream;
};

Connection.prototype._handleHeaders = function _handleHeaders(frame) {
  var stream = this._createStream({
    id: frame.id,
    request: false,
    method: frame.headers[':method'],
    path: frame.headers[':path'],
    host: frame.headers[':authority'],
    priority: frame.priority,
    headers: frame.headers,
    writable: frame.writable
  });

  // GOAWAY
  if (!stream)
    return;

  // TODO(indutny) handle stream limit
  this.emit('stream', stream);

  return stream;
};

Connection.prototype._onSessionWindowDrain = function _onSessionWindowDrain() {
  var state = this._spdyState;
  if (state.version < 3.1 && (!state.isServer || !state.autoSpdy31))
    return;

  var delta = state.window.recv.getDelta();
  state.debug('id=0 session window drain, update by %d', delta);

  state.framer.windowUpdateFrame({
    id: 0,
    delta: delta
  });
  state.window.recv.update(delta);
};

Connection.prototype.start = function start(version) {
  this._spdyState.parser.setVersion(version);
};

// Mostly for testing
Connection.prototype.getVersion = function getVersion() {
  return this._spdyState.version;
};

Connection.prototype._handleSettings = function _handleSettings(settings) {
  var state = this._spdyState;

  this._setDefaultWindow(settings);
  if (settings.max_frame_size)
    state.parser.setMaxFrameSize(settings.max_frame_size);
  if (settings.max_header_list_size)
    state.parser.setMaxHeaderListSize(settings.max_header_list_size);
  if (settings.header_table_size)
    state.decompress.updateTableSize(settings.header_table_size);
  if (settings.enable_push !== undefined)
    state.framer.enablePush(settings.enable_push === 1);

  // TODO(indutny): handle max_concurrent_streams
};

Connection.prototype._setDefaultWindow = function _setDefaultWindow(settings) {
  if (!settings.initial_window_size)
    return;

  var state = this._spdyState;

  // Update defaults
  var window = state.streamWindow;
  window.send.setMax(settings.initial_window_size);

  // Update existing streams
  Object.keys(state.stream.map).forEach(function(id) {
    var stream = state.stream.map[id];
    var window = stream._spdyState.window;

    window.send.updateMax(settings.initial_window_size);
  });
};

Connection.prototype._handlePing = function handlePing(frame) {
  var self = this;
  var state = this._spdyState;

  // Handle incoming PING
  if (!frame.ack) {
    state.framer.pingFrame({
      opaque: frame.opaque,
      ack: true
    });

    self.emit('ping', frame.opaque);
    return;
  }

  // Handle reply PING
  var hex = frame.opaque.toString('hex');
  if (!state.ping.map[hex])
    return;
  var ping = state.ping.map[hex];
  delete state.ping.map[hex];

  if (ping.cb)
    ping.cb(null);
};

Connection.prototype._handleGoaway = function handleGoaway(frame) {
  this._goaway({
    lastId: frame.lastId,
    code: frame.code,
    send: false
  });
};

Connection.prototype.ping = function ping(callback) {
  var state = this._spdyState;

  // HTTP2 is using 8-byte opaque
  var opaque = new Buffer(state.constants.PING_OPAQUE_SIZE);
  opaque.fill(0);
  opaque.writeUInt32BE(state.ping.nextId, opaque.length - 4);
  state.ping.nextId += 2;

  state.ping.map[opaque.toString('hex')] = { cb: callback };
  state.framer.pingFrame({
    opaque: opaque,
    ack: false
  });
};

Connection.prototype.getCounter = function getCounter(name) {
  return this._spdyState.counters[name];
};

Connection.prototype.request = function request(uri, callback) {
  var stream = this._createStream(uri);
  if (!stream) {
    process.nextTick(function() {
      callback(new Error('Can\'t send request after GOAWAY'));
    });
    return;
  }

  // TODO(indunty): ideally it should just take a stream object as an input
  this._spdyState.framer.requestFrame({
    id: stream.id,
    method: stream.method,
    path: stream.path,
    host: stream.host,
    priority: uri.priority,
    headers: stream.headers
  }, function(err) {
    if (err)
      return callback(err);

    callback(null, stream);
  });

  return stream;
};

Connection.prototype._removeStream = function _removeStream(stream) {
  var state = this._spdyState;

  state.debug('id=0 remove stream=%d', stream.id);
  delete state.stream.map[stream.id];
  state.stream.count--;

  if (state.stream.count === 0)
    this.emit('_streamDrain');
};

Connection.prototype._goaway = function _goaway(params) {
  var state = this._spdyState;

  state.goaway = params.lastId;

  if (params.send) {
    state.framer.goawayFrame({
      lastId: params.lastId,
      code: params.code,
      extra: params.extra
    });
  }

  // Destroy socket if there are no streams
  if (state.stream.count === 0 || params.code !== 'OK') {
    var self = this;

    // No further frames should be processed
    this.socket.unpipe(this.parser);

    process.nextTick(function() {
      var err = new Error('Fatal error: ' + params.code);
      self._onStreamDrain(err);
    });
    return;
  }

  this.on('_streamDrain', this._onStreamDrain);
};

Connection.prototype._onStreamDrain = function _onStreamDrain(error) {
  var state = this._spdyState;

  state.debug('id=0 _onStreamDrain');

  if (this.socket.destroySoon)
    this.socket.destroySoon();
  else
    this.emit('close', error);
};

Connection.prototype.end = function end(callback) {
  var state = this._spdyState;

  if (callback)
    this.once('close', callback);
  this._goaway({
    lastId: state.stream.lastId,
    code: 'OK',
    send: true
  });
};

Connection.prototype.destroyStreams = function destroyStreams(err) {
  var state = this._spdyState;
  Object.keys(state.stream.map).forEach(function(id) {
    var stream = state.stream.map[id];

    stream.emit('error', err);
  });
};

Connection.prototype.isServer = function isServer() {
  return this._spdyState.isServer;
};

Connection.prototype._onSessionWindowDrain = function _onSessionWindowDrain() {
  var state = this._spdyState;
  if (state.version < 3.1 && (!state.isServer || !state.autoSpdy31))
    return;

  var delta = state.window.recv.getDelta();
  state.debug('id=0 session window drain, update by %d', delta);

  state.framer.windowUpdateFrame({
    id: 0,
    delta: delta
  });
  state.window.recv.update(delta);
};

Connection.prototype.pushPromise = function pushPromise(parent, uri, callback) {
  var state = this._spdyState;

  var stream = this._createStream({
    request: false,
    parent: parent,
    method: uri.method,
    path: uri.path,
    host: uri.host,
    priority: uri.priority,
    headers: uri.headers,
    readable: false
  });

  if (!stream) {
    process.nextTick(function() {
      callback(new Error('Can\'t send PUSH_PROMISE after GOAWAY'));
    });
    return;
  }

  state.framer.pushFrame({
    id: parent.id,
    promisedId: stream.id,
    priority: uri.priority,
    path: uri.path,
    host: uri.host,
    method: uri.method,
    status: uri.status,
    headers: uri.headers
  }, function(err) {
    if (err)
      return callback(err);

    callback(null, stream);
  });

  return stream;
};
