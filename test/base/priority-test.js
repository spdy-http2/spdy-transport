/* eslint-env mocha */

var assert = require('assert')

var transport = require('../../')

describe('Stream Priority tree', function () {
  var tree
  beforeEach(function () {
    tree = transport.Priority.create({})
  })

  it('should create basic tree', function () {
    //                   0
    //     [1 p=2]    [2 p=4]    [3 p=2]
    // [4 p=2] [5 p=2]

    tree.add({ id: 1, parent: 0, weight: 2 })
    tree.add({ id: 5, parent: 1, weight: 2 })
    tree.add({ id: 2, parent: 0, weight: 4 })
    tree.add({ id: 3, parent: 0, weight: 2 })
    tree.add({ id: 4, parent: 1, weight: 2 })

    assert.deepStrictEqual([ 1, 2, 3, 4, 5 ].map(function (id) {
      return tree.get(id).priority
    }), [ 0.25, 0.5, 0.25, 0.125, 0.125 ])

    // Ranges
    assert.deepStrictEqual([ 1, 2, 3, 4, 5 ].map(function (id) {
      return tree.get(id).getPriorityRange()
    }), [
      // First level
      { from: 0.0, to: 0.25 },
      { from: 0.5, to: 1.0 },
      { from: 0.25, to: 0.5 },

      // Second level
      { from: 0, to: 0.125 },
      { from: 0.125, to: 0.25 }
    ])
  })

  it('should create default node on error', function () {
    var node1 = tree.add({ id: 1, parent: 1 })
    assert.strictEqual(node1.parent.id, 0)
    assert.strictEqual(node1.weight, tree.defaultWeight)

    var node2 = tree.add({ id: 1, parent: 3 })
    assert.strictEqual(node2.parent.id, 0)
    assert.strictEqual(node2.weight, tree.defaultWeight)
  })

  it('should remove empty node', function () {
    var node = tree.add({ id: 1, parent: 0, weight: 1 })
    assert(tree.get(1) !== undefined)
    assert.strictEqual(tree.count, 2)
    node.remove()
    assert(tree.get(1) === undefined)
    assert.strictEqual(tree.count, 1)
  })

  it('should move children to parent node on removal', function () {
    // Tree from the first test
    var one = tree.add({ id: 1, parent: 0, weight: 2 })
    tree.add({ id: 5, parent: 1, weight: 2 })
    tree.add({ id: 2, parent: 0, weight: 4 })
    tree.add({ id: 3, parent: 0, weight: 2 })
    tree.add({ id: 4, parent: 1, weight: 2 })

    assert.strictEqual(tree.count, 6)
    one.remove()
    assert(tree.get(1) === undefined)
    assert.strictEqual(tree.count, 5)

    assert.deepStrictEqual([ 2, 3, 4, 5 ].map(function (id) {
      return tree.get(id).priority
    }), [ 0.4, 0.2, 0.2, 0.19999999999999996 ])
  })

  it('should move children on exclusive addition', function () {
    //            0
    //          /   \
    //        1       2
    //      / | \
    //    3   4    5
    tree.add({ id: 1, parent: 0, weight: 2 })
    tree.add({ id: 2, parent: 0, weight: 2 })
    tree.add({ id: 3, parent: 1, weight: 4 })
    tree.add({ id: 4, parent: 1, weight: 2 })
    tree.add({ id: 5, parent: 1, weight: 2 })

    assert.deepStrictEqual([ 1, 2, 3, 4, 5 ].map(function (id) {
      return tree.get(id).priority
    }), [ 0.5, 0.5, 0.25, 0.125, 0.125 ])

    //            0
    //          /   \
    //        1       2
    //        |
    //        6
    //      / | \
    //    3   4    5
    tree.add({ id: 6, parent: 1, exclusive: true, weight: 2 })

    assert.deepStrictEqual([ 1, 2, 3, 4, 5, 6 ].map(function (id) {
      return tree.get(id).priority
    }), [ 0.5, 0.5, 0.25, 0.125, 0.125, 0.5 ])
  })

  it('should remove excessive nodes on hitting maximum', function () {
    tree = transport.Priority.create({
      maxCount: 6
    })

    //            0
    //          /   \
    //        1       2
    //      / | \
    //    3   4    5
    tree.add({ id: 1, parent: 0, weight: 2 })
    tree.add({ id: 2, parent: 0, weight: 2 })
    tree.add({ id: 3, parent: 1, weight: 4 })
    tree.add({ id: 4, parent: 1, weight: 2 })
    tree.add({ id: 5, parent: 1, weight: 2 })

    //            0
    //          /   \
    //        6       2
    //      / | \
    //    3   4    5
    tree.add({ id: 6, parent: 1, exclusive: true, weight: 2 })

    assert.strictEqual(tree.get(1), undefined)
    assert.deepStrictEqual([ 2, 3, 4, 5, 6 ].map(function (id) {
      return tree.get(id).priority
    }), [ 0.5, 0.25, 0.125, 0.125, 0.5 ])

    // This should not throw when removing ex-child of node swapped by
    // exclusive one
    tree.add({ id: 7, parent: 5, exclusive: false, weight: 2 })
    tree.add({ id: 8, parent: 5, exclusive: false, weight: 2 })
  })

  it('should use default weight', function () {
    tree.add({ id: 1, parent: 0 })

    assert.strictEqual(tree.get(1).weight, 16)
  })

  it('should create default node', function () {
    tree.addDefault(1)

    assert.strictEqual(tree.get(1).weight, 16)
  })

  it('Removing a node should remove it from the tree\'s list', function () {
    tree.addDefault(1)

    tree.get(1).remove()

    assert.strictEqual(tree.list[0], undefined)
  })
})
