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

          setTimeout(done, 10);
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
          setTimeout(done, 10);
      });
    });

    it('should return Stream after GOAWAY', function(done) {
      client.end(function() {
        var stream = client.request({
          path: '/hello-split'
        });
        assert(stream);

        stream.once('error', function() {
          done();
        });
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
          assert(err);
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

      var sent;
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

    it('should use last received id when killing streams', function(done) {
      var waiting = 2;
      function next() {
        if (--waiting === 0)
          return done();
      }
      client.once('stream', next);
      server.once('stream', next);

      server.request({
        path: '/hello'
      }, function() {
        client.request({
          path: '/hello'
        });
      });
    });

    it('should kill stream on wrong id', function(done) {
      client._spdyState.stream.nextId = 2;

      var stream = client.request({
        path: '/hello'
      });
      stream.once('error', function(err) {
        done();
      });
    });

    it('should handle SETTINGS', function(done) {
      client._spdyState.framer.settingsFrame({
        max_frame_size: 100,
        max_header_list_size: 1000,
        header_table_size: 32,
        enable_push: true
      }, function(err) {
        assert(!err);
      });

      var sent;
      client.request({
        path: '/hello'
      }, function(err, stream) {
        assert(!err);
        sent = true;

        stream.on('data', function(chunk) {
          assert(chunk.length <= 100 || version < 4);
        });

        stream.once('end', done);
      });

      var incoming = 0;
      server.on('stream', function(stream) {
        incoming++;
        assert(incoming <= 1);

        stream.resume();
        stream.end(new Buffer(1024));
      });
    });

    it('should send X_FORWARDED_FOR', function(done) {
      client.sendXForwardedFor('1.2.3.4');

      var sent;
      client.request({
        path: '/hello'
      }, function(err, stream) {
        assert(!err);
        sent = true;

        stream.resume();
        stream.once('end', done);
      });

      server.on('stream', function(stream) {
        assert.equal(server.getXForwardedFor(), '1.2.3.4');

        stream.resume();
        stream.end();
      });
    });
  });
});
