var assert = require('assert');
var async = require('async');
var fixtures = require('./fixtures');

var expectData = fixtures.expectData;
var everyProtocol = fixtures.everyProtocol;

var transport = require('../../../');

describe('Transport/Push', function() {
  everyProtocol(function(name, version) {
    var server;
    var client;
    var pair;

    beforeEach(function() {
      server = fixtures.server;
      client = fixtures.client;
      pair = fixtures.pair;
    });

    it('should create PUSH_PROMISE', function(done) {
      client.request({
        path: '/parent'
      }, function(err, stream) {
        assert(!err);

        stream.on('pushPromise', function(push) {
          assert.equal(push.path, '/push');
          done();
        });
      });

      server.on('stream', function(stream) {
        assert.equal(stream.path, '/parent');

        stream.respond(200, {});
        stream.pushPromise({
          path: '/push',
          priority: {
            parent: 0,
            exclusive: false,
            weight: 42
          }
        }, function(err, stream) {
          assert(!err);
        });
      });
    });

    it('should cork PUSH_PROMISE on write', function(done) {
      client.request({
        path: '/parent'
      }, function(err, stream) {
        assert(!err);

        stream.on('pushPromise', function(push) {
          assert.equal(push.path, '/push');
          expectData(push, 'ok', done);
        });
      });

      server.on('stream', function(stream) {
        assert.equal(stream.path, '/parent');

        stream.respond(200, {});
        var push = stream.pushPromise({
          path: '/push',
          priority: {
            parent: 0,
            exclusive: false,
            weight: 42
          }
        }, function(err, stream) {
          assert(!err);
        });

        push.end('ok');
      });
    });

    it('should emit `close` on PUSH_PROMISE', function(done) {
      client.request({
        path: '/parent'
      }, function(err, stream) {
        assert(!err);

        stream.on('pushPromise', function(push) {
          assert.equal(push.path, '/push');

          push.on('close', next);
          push.resume();
        });
      });

      server.on('stream', function(stream) {
        assert.equal(stream.path, '/parent');

        stream.respond(200, {});
        stream.pushPromise({
          path: '/push',
          priority: {
            parent: 0,
            exclusive: false,
            weight: 42
          }
        }, function(err, stream) {
          assert(!err);
          stream.on('close', next);
          stream.end('ohai');
        });
      });

      var waiting = 2;
      function next() {
        if (--waiting === 0)
          return done();
      }
    });

    it('should ignore PUSH_PROMISE', function(done) {
      client.request({
        path: '/parent'
      }, function(err, stream) {
        assert(!err);
      });

      server.on('stream', function(stream) {
        assert.equal(stream.path, '/parent');

        stream.respond(200, {});
        stream.pushPromise({
          path: '/push',
          priority: {
            parent: 0,
            exclusive: false,
            weight: 42
          }
        }, function(err, stream) {
          assert(!err);
          stream.once('error', function(err) {
            assert(err);
            done();
          });
        });
      });
    });

    it('should fail on disabled PUSH_PROMISE', function(done) {
      client.request({
        path: '/parent'
      }, function(err, stream) {
        assert(!err);

        stream._spdyState.framer.enablePush(true);
        stream.pushPromise({
          path: '/push',
          priority: {
            parent: 0,
            exclusive: false,
            weight: 42
          }
        }, function(err, stream) {
          assert(!err);
          stream.on('error', function(err) {
            assert(err);
          });
        });

        client.on('close', function(err) {
          assert(err);
          done();
        });
      });

      server.on('stream', function(stream) {
        assert.equal(stream.path, '/parent');

        stream.respond(200, {});
        stream.on('pushPromise', function() {
          assert(false);
        });
      });
    });

    it('should get error on disabled PUSH_PROMISE', function(done) {
      client.request({
        path: '/parent'
      }, function(err, stream) {
        assert(!err);

        stream.pushPromise({
          path: '/push',
          priority: {
            parent: 0,
            exclusive: false,
            weight: 42
          }
        }, function(err, stream) {
          assert(err);
          done();
        });
      });

      server.on('stream', function(stream) {
        assert.equal(stream.path, '/parent');

        stream.respond(200, {});

        stream.on('pushPromise', function() {
          assert(false);
        });
      });
    });
  });
});
