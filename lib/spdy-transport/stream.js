'use strict';

// var transport = require('../spdy-transport');

var assert = require('assert');
var util = require('util');
var debug = {
  client: require('debug')('spdy:stream:client'),
  server: require('debug')('spdy:stream:server')
};
var Buffer = require('buffer').Buffer;
var Duplex = require('stream').Duplex;

function Stream(connection, options) {
  Duplex.call(this);

  var connectionState = connection._spdyState;

  var state = {};
  this._spdyState = state;

  this.id = options.id;
  this.method = options.method;
  this.path = options.path;
  this.host = options.host;
  this.headers = options.headers;

  state.socket = null;
  state.protocol = connectionState.protocol;
  state.constants = state.protocol.constants;

  // See _initPriority()
  state.priority = null;

  state.connection = connection;
  state.version = state.connection.version;
  state.isServer = state.connection.isServer();
  state.debug = state.isServer ? debug.server : debug.client;

  state.framer = connectionState.framer;
  state.parser = connectionState.parser;

  state.request = options.request;
  state.needResponse = options.request;
  state.window = connectionState.streamWindow.clone(options.id);
  state.sessionWindow = connectionState.window;

  state.aborted = false;

  this.on('finish', this._onFinish);
  this.on('end', this._onEnd);

  this._initPriority(options.priority);
}
util.inherits(Stream, Duplex);
exports.Stream = Stream;

Stream.prototype._init = function _init(socket) {
  this.socket = socket;
};

Stream.prototype._initPriority = function _initPriority(priority) {
  var state = this._spdyState;
  var connectionState = state.connection._spdyState;
  var root = connectionState.priorityRoot;

  if (!priority) {
    state.priority = root.addDefault(this.id);
    return;
  }

  state.priority = root.add({
    id: this.id,
    parent: priority.parent,
    weight: priority.weight,
    exclusive: priority.exclusive
  });
};

Stream.prototype._handleFrame = function _handleFrame(frame) {
  var state = this._spdyState;

  // Ignore any kind of data after abort
  if (state.aborted) {
    state.debug('id=%d ignoring frame=%s after abort', this.id, frame.type);
    return;
  }

  if (frame.type === 'DATA')
    this._handleData(frame);
  else if (frame.type === 'HEADERS')
    this._handleHeaders(frame);
  else if (frame.type === 'RST')
    this._handleRST(frame);
  else if (frame.type === 'WINDOW_UPDATE')
    this._handleWindowUpdate(frame);
  else if (frame.type === 'PRIORITY')
    this._handlePriority(frame);
  else if (frame.type === 'PUSH_PROMISE')
    this._handlePushPromise(frame);

  if (frame.fin) {
    state.debug('id=%d end', this.id);
    this.push(null);
  }
};

function checkAborted(stream, state, callback) {
  if (state.aborted) {
    state.debug('id=%d abort write', stream.id);
    process.nextTick(function() {
      callback(new Error('Stream write aborted'));
    });
    return true;
  }

  return false;
}

function _send(stream, state, data, callback) {
  if (checkAborted(stream, state, callback))
    return;

  state.debug('id=%d presend=%d', stream.id, data.length);

  state.window.send.update(-data.length, function() {
    if (checkAborted(stream, state, callback))
      return;

    state.debug('id=%d send=%d', stream.id, data.length);

    state.framer.dataFrame({
      id: stream.id,
      priority: state.priority.getPriority(),
      fin: false,
      data: data
    }, function(err) {
      state.debug('id=%d postsend=%d', stream.id, data.length);
      callback(err);
    });
  });
}

Stream.prototype._write = function _write(data, enc, callback) {
  // TODO(indutny): split into smaller chunks using max chunk size
  // Split DATA in chunks to prevent window from going negative
  this._splitStart(data, _send, callback);
};

Stream.prototype._splitStart = function _splitStart(data, onChunk, callback) {
  return this._split(data, 0, onChunk, callback);
};

Stream.prototype._split = function _split(data, offset, onChunk, callback) {
  if (offset === data.length)
    return process.nextTick(callback);

  var state = this._spdyState;
  var local = state.window.send;
  var session = state.sessionWindow.send;

  var availSession = Math.max(0, session.getCurrent());
  if (availSession === 0)
    availSession = session.getMax();
  var availLocal = Math.max(0, local.getCurrent());
  if (availLocal === 0)
    availLocal = local.getMax();

  var avail = Math.min(availSession, availLocal);

  // Split data in chunks in a following way:
  // 1. Try to fill `this.current` first
  // 2. If it is empty - fill `this.max`
  var limit = avail === 0 ? this.max : avail;
  var size = Math.min(data.length - offset, limit);

  var chunk = data.slice(offset, offset + size);

  var self = this;
  onChunk(this, state, chunk, function(err) {
    if (err)
      return callback(err);

    // Get the next chunk
    self._split(data, offset + size, onChunk, callback);
  });
};

Stream.prototype._read = function _read() {
  var state = this._spdyState;

  if (!state.window.recv.isDraining())
    return;

  var delta = state.window.recv.getDelta();

  state.debug('id=%d window emptying, update by %d', this.id, delta);

  state.window.recv.update(delta);
  state.framer.windowUpdateFrame({
    id: this.id,
    delta: delta
  });
};

Stream.prototype._handleData = function _handleData(frame) {
  var state = this._spdyState;

  state.debug('id=%d recv=%d', this.id, frame.data.length);
  state.window.recv.update(-frame.data.length);

  this.push(frame.data);
};

Stream.prototype._handleRST = function _handleRST(frame) {
  this.emit('error', new Error('Got RST: ' + frame.code));
};

Stream.prototype._handleWindowUpdate = function _handleWindowUpdate(frame) {
  var state = this._spdyState;

  state.window.send.update(frame.delta);
};

Stream.prototype._handlePriority = function _handlePriority(frame) {
  var state = this._spdyState;

  state.priority.remove();
  state.priority = null;
  this._initPriority(frame.priority);

  // Mostly for testing purposes
  this.emit('priority', frame.priority);
};

Stream.prototype._handleHeaders = function _handleHeaders(frame) {
  var state = this._spdyState;

  if (state.needResponse)
    return this._handleResponse(frame);

  this.emit('headers', frame.headers);
};

Stream.prototype._handleResponse = function _handleResponse(frame) {
  var state = this._spdyState;

  if (frame.headers[':status'] === undefined) {
    state.framer.rstFrame({ id: this.id, code: 'PROTOCOL_ERROR' });
    return;
  }

  state.needResponse = false;
  this.emit('response', frame.headers[':status'], frame.headers);
};

Stream.prototype._onFinish = function _onFinish() {
  var state = this._spdyState;

  state.framer.dataFrame({
    id: this.id,
    priority: state.priority.getPriority(),
    fin: true,
    data: new Buffer(0)
  });

  this._maybeClose();
};

Stream.prototype._onEnd = function _onEnd() {
  this._maybeClose();
};

Stream.prototype._maybeClose = function _maybeClose() {
  var state = this._spdyState;

  // .abort() emits `close`
  if (state.aborted)
    return;

  if (this._readableState.ended && this._writableState.finished)
    this.emit('close');
};

Stream.prototype._handlePushPromise = function _handlePushPromise(frame) {
  var state = this._spdyState;

  var push = state.connection._createStream({
    id: frame.promisedId,
    request: false,
    method: frame.headers[':method'],
    path: frame.headers[':path'],
    host: frame.headers[':authority'],
    priority: frame.priority,
    headers: frame.headers
  });

  // GOAWAY
  if (!push)
    return;

  this.emit('pushPromise', push);
};

// Public API

Stream.prototype.respond = function respond(status, headers, callback) {
  var state = this._spdyState;
  assert(!state.request, 'Can\'t respond on request');

  state.framer.responseFrame({
    id: this.id,
    status: status,
    headers: headers
  }, callback);
};

Stream.prototype.setWindow = function setWindow(size) {
  var state = this._spdyState;

  state.debug('id=%d force window max=%d', this.id, size);
  state.window.recv.setMax(size);

  var delta = state.window.recv.getDelta();
  state.framer.windowUpdateFrame({
    id: this.id,
    delta: delta
  });
  state.window.recv.update(delta);
};

Stream.prototype.sendHeaders = function sendHeaders(headers) {
  var state = this._spdyState;

  state.framer.headersFrame({
    id: this.id,
    headers: headers
  });
};

Stream.prototype.abort = function abort(code, callback) {
  var state = this._spdyState;

  // .abort(callback)
  if (typeof code === 'function') {
    callback = code;
    code = null;
  }

  if (this._readableState.ended && this._writableState.finished) {
    state.debug('id=%d already closed');
    if (callback)
      process.nextTick(callback);
    return;
  }

  if (state.aborted) {
    state.debug('id=%d already aborted');
    if (callback)
      process.nextTick(callback);
    return;
  }

  state.aborted = true;
  state.debug('id=%d abort');

  var abortCode = code || 'CANCEL';

  state.framer.rstFrame({
    id: this.id,
    code: abortCode
  });

  var self = this;
  process.nextTick(function() {
    if (callback)
      callback(null);
    self.emit('close', new Error('Aborted, code: ' + abortCode));
  });
};

Stream.prototype.setPriority = function setPriority(info) {
  var state = this._spdyState;

  state.debug('id=%d priority change', this.id, info);

  var frame = { id: this.id, priority: info };

  // Change priority on this side
  this._handlePriority(frame);

  // And on the other too
  state.framer.priorityFrame(frame);
};

Stream.prototype.pushPromise = function pushPromise(uri, callback) {
  var state = this._spdyState;

  return state.connection.pushPromise(this, uri, callback);
};
