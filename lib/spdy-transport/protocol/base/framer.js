'use strict';

var util = require('util');

var transport = require('../../../spdy-transport');
var base = require('./');
var Scheduler = base.Scheduler;

function Framer(options) {
  Scheduler.call(this);

  this.version = null;
  this.compress = null;
  this.window = options.window;
  this.timeout = options.timeout;
  this.pushEnabled = base.constants.DEFAULT_PUSH_ENABLED;
}
util.inherits(Framer, Scheduler);
module.exports = Framer;

Framer.prototype.setVersion = function setVersion(version) {
  this.version = version;
  this.emit('version');
};

Framer.prototype.setCompression = function setCompresion(pair) {
  this.compress = new transport.utils.LockStream(pair.compress);
};

Framer.prototype.enablePush = function enablePush(enable) {
  this.pushEnabled = enable;
};

Framer.prototype._checkPush = function _checkPush(callback) {
  if (this.pushEnabled)
    return true;

  var self = this;
  var err = new Error('PUSH_PROMISE disabled by other side');
  process.nextTick(function() {
    if (callback)
      return callback(err);
    else
      return self.emit('error', err);
  });

  return false;
};

Framer.prototype._resetTimeout = function _resetTimeout() {
  if (this.timeout)
    this.timeout.reset();
};
