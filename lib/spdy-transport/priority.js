'use strict';

var debug = require('debug')('spdy:priority');

function PriorityNode(options) {
  this.id = options.id;
  this.parent = options.parent;
  this.weight = options.weight;

  // To be calculated in `addChild`
  this.priority = 1;

  this.children = {
    list: [],
    weight: 0
  };

  if (this.parent !== null)
    this.parent.addChild(this);
}

PriorityNode.prototype.addChild = function addChild(child) {
  this.children.list.push(child);
  this.children.weight += child.weight;

  this._updatePriority(this.priority);
};

PriorityNode.prototype._updatePriority = function _updatePriority(priority) {
  this.priority = priority;
  for (var i = 0; i < this.children.list.length; i++) {
    var node = this.children.list[i];
    node._updatePriority(priority * node.weight / this.children.weight);
  }
};

// TODO(indutny): limit number of nodes in tree
function PriorityTree() {
  this.map = {};
  this.defaultWeight = 16;

  // Root
  this.root = this.add({
    id: 0,
    parent: null,
    weight: 1
  });
}
module.exports = PriorityTree;

PriorityTree.create = function create() {
  return new PriorityTree();
};

PriorityTree.prototype.add = function add(options) {
  // NOTE: Should be handled by parser
  if (options.id === options.parent)
    return this._createDefault(options.id);

  var parent = options.parent === null ? null : this.map[options.parent];
  if (parent === undefined)
    return this._createDefault(options.id);

  debug('add node=%d parent=%d',
        options.id,
        options.parent === null ? -1 : options.parent);

  var node = new PriorityNode({
    id: options.id,
    parent: parent,
    weight: options.weight
  });
  this.map[options.id] = node;

  return node;
};

PriorityTree.prototype.remove = function remove(node) {
  delete this.map[node.id];
};

// Only for testing, should use `node`'s methods
PriorityTree.prototype.get = function get(id) {
  return this.map[id];
};

PriorityTree.prototype._createDefault = function _createDefault(id) {
  debug('creating default node');
  return this.add({ id: id, parent: 0, weight: this.defaultWeight });
};
