'use strict';

var utils = exports;

var util = require('util');

function ProtocolError(code, message) {
  this.code = code;
  this.message = message;
}
util.inherits(ProtocolError, Error);
utils.ProtocolError = ProtocolError;

utils.error = function error(code, message) {
  return new ProtocolError(code, message);
};

utils.reverse = function reverse(object) {
  var result = []

  Object.keys(object).forEach(function(key) {
    result[object[key] | 0] = key;
  });

  return result;
};

// weight [1, 36] <=> priority [0, 7]
// This way weight=16 is preserved and has priority=3
utils.weightToPriority = function weightToPriority(weight) {
  return ((Math.min(35, (weight - 1)) / 35) * 7) | 0;
};

utils.priorityToWeight = function priorityToWeight(priority) {
  return (((priority / 7) * 35) | 0) + 1;
};
