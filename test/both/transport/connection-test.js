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

        var waiting = 2;
        function next() {
          if (--waiting === 0)
            done();
        }

        pair.destroySoon = next;
        server.once('close', next);
        server.end();
      });
    });

    it('should dump data on GOAWAY', function(done) {
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

        pair.destroySoon = function() {
          pair.end();
          server.ping();

          setImmediate(done);
        };
        server.end();
      });
    });

    it('should kill late streams on GOAWAY', function(done) {
      client.request({
        path: '/hello-split'
      }, function(err, stream) {
        assert(!err);

        stream.resume();
        stream.end();

        client.request({
          path: '/late'
        }, function(err, stream) {
          assert(!err);

          stream.on('error', function() {
            done();
          });
        });
      });

      var once = false;
      server.on('stream', function(stream) {
        assert(!once);
        once = true;

        stream.respond(200, {});
        stream.resume();
        stream.end();

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
          stream.on('error', function() {
            // Ignore
          });
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
          setTimeout(second, 50);
        });
      }, 50);

      function second() {
        client.request({
          path: '/hello-with-data'
        }, function(err, stream) {
          assert(!err);

          stream.end('ok');
          setTimeout(third, 50);
        });
      }

      function third() {
        client.ping(function() {
          server.end();
          setTimeout(done, 50);
        });
      }

      server.on('stream', function(stream) {
        stream.respond(200, {});
        stream.end();
        expectData(stream, 'ok', function() {});
      });
    });

    it('should ignore request without `stream` listener', function(done) {
      client.request({
        path: '/hello-split'
      }, function(err, stream) {
        assert(!err);

        stream.on('error', function(err) {
          assert(err);
          done();
        });
      });
    });

    it('should ignore HEADERS frame after FIN', function(done) {
      function sendHeaders() {
        client._spdyState.framer.requestFrame({
          id: 1,
          method: 'GET',
          path: '/',
          priority: null,
          headers: {},
          fin: true
        }, function(err) {
          assert(!err);
        });
      }

      client.request({
        path: '/hello'
      }, function(err, stream) {
        assert(!err);
        sent = true;

        stream.resume();
        stream.once('end', function() {
          stream.end(sendHeaders);
        });
      });

      var incoming = 0;
      server.on('stream', function(stream) {
        incoming++;
        assert(incoming <= 1);

        stream.resume();
        stream.end();
      });

      var waiting = 2;
      server.on('frame', function(frame) {
        if (frame.type === 'HEADERS' && --waiting === 0)
          process.nextTick(done);
      });
    });
  });
});
