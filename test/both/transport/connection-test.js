var assert = require('assert');
var async = require('async');
var fixtures = require('./fixtures');

var expectData = fixtures.expectData;
var everyProtocol = fixtures.everyProtocol;

var transport = require('../../../');

describe('Transport/Connection', function() {
  everyProtocol(function(name, version) {
    var server;
    var client;
    var pair;

    beforeEach(function() {
      server = fixtures.server;
      client = fixtures.client;
      pair = fixtures.pair;
    });

    it('should send SETTINGS frame on both ends', function(done) {
      async.map([ server, client ], function(side, callback) {
        side.on('frame', function(frame) {
          if (frame.type !== 'SETTINGS')
            return;

          callback();
        });
      }, done);
    });

    it('should emit `close` after GOAWAY', function(done) {
      client.request({
        path: '/hello-split'
      }, function(err, stream) {
        assert(!err);

        stream.resume();
        stream.end();
      });

      var once = false;
      server.on('stream', function(stream) {
        assert(!once);
        once = true;

        stream.respond(200, {});
        stream.resume();
        stream.end();

        pair.destroySoon = done;
        server.end();
      });
    });

    it('should send and receive ping', function(done) {
      client.ping(function() {
        server.ping(done);
      });
    });

    it('should ignore request after GOAWAY', function(done) {
      client.request({
        path: '/hello-split'
      }, function(err, stream) {
        assert(!err);

        client.request({
          path: '/second'
        }, function(err, stream) {
        });
      });

      var once = false;
      server.on('stream', function(stream) {
        assert(!once);
        once = true;

        // Send GOAWAY
        server.end();
      });

      var waiting = 2;
      server.on('frame', function(frame) {
        if (frame.type === 'HEADERS' && --waiting === 0)
          setImmediate(done);
      });
    });

    it('should timeout when sending request', function(done) {
      server.setTimeout(50, function() {
        server.end();
        setTimeout(done, 50);
      });

      setTimeout(function() {
        client.request({
          path: '/hello-with-data'
        }, function(err, stream) {
          assert(!err);

          stream.end('ok');
        });
      }, 100);

      server.on('stream', function(stream) {
        assert(false);
      });
    });

    it('should not timeout when sending request', function(done) {
      server.setTimeout(100, function() {
        assert(false);
      });

      setTimeout(function() {
        client.request({
          path: '/hello-with-data'
        }, function(err, stream) {
          assert(!err);

          stream.end('ok');
        });
      }, 50);

      setTimeout(function() {
        client.request({
          path: '/hello-with-data'
        }, function(err, stream) {
          assert(!err);

          stream.end('ok');
        });
      }, 100);

      setTimeout(function() {
        client.ping(function() {
          server.end();
          setTimeout(done, 50);
        });
      }, 100);

      server.on('stream', function(stream) {
        stream.respond(200, {});
        stream.end();
        expectData(stream, 'ok', function() {});
      });
    });
  });
});
