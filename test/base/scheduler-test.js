var assert = require('assert');

var transport = require('../../');
var base = transport.protocol.base;

describe('Frame Scheduler', function() {
  var scheduler;
  beforeEach(function() {
    scheduler = base.Scheduler.create();
  });

  function chunk(stream, priority, chunks, callback) {
    return {
      stream: stream,
      priority: priority,
      chunks: chunks,
      callback: callback
    };
  }

  function expect(string, done) {
    var actual = '';
    var pending = scheduler.count;
    var got = 0;
    scheduler.on('data', function(chunk) {
      actual += chunk;
      if (++got !== pending)
        return;

      assert.equal(actual, string);
      done();
    });
  }

  it('should schedule and emit one frame', function(done) {
    scheduler.write(chunk(0, 0, [ 'hello', ' ', 'world' ]));

    expect('hello world', done);
  });

  it('should schedule and emit two frames', function(done) {
    scheduler.write(chunk(0, 0, [ 'hello', ' ' ]));
    scheduler.write(chunk(0, 0, [ 'world' ]));

    expect('hello world', done);
  });

  it('should interleave between two streams', function(done) {
    scheduler.write(chunk(0, 0, [ 'hello ' ]));
    scheduler.write(chunk(0, 0, [ ' hello ' ]));
    scheduler.write(chunk(1, 0, [ 'world!' ]));
    scheduler.write(chunk(1, 0, [ 'world' ]));

    expect('hello world! hello world', done);
  });

  it('should interleave between two shuffled streams', function(done) {
    scheduler.write(chunk(0, 0, [ 'hello ' ]));
    scheduler.write(chunk(1, 0, [ 'world!' ]));
    scheduler.write(chunk(1, 0, [ 'world' ]));
    scheduler.write(chunk(0, 0, [ ' hello ' ]));

    expect('hello world! hello world', done);
  });

  it('should interleave between three streams', function(done) {
    scheduler.write(chunk(0, 0, [ 'hello ' ]));
    scheduler.write(chunk(1, 0, [ 'world!' ]));
    scheduler.write(chunk(1, 0, [ 'world' ]));
    scheduler.write(chunk(0, 0, [ ' hello ' ]));
    scheduler.write(chunk(2, 0, [ ' (yes)' ]));

    expect('hello world! (yes) hello world', done);
  });

  it('should respect priority window', function(done) {
    scheduler.write(chunk(0, 0.5, [ 'a' ]));
    scheduler.write(chunk(1, 0.4, [ 'b' ]));
    scheduler.write(chunk(2, 0.3, [ 'c' ]));
    scheduler.write(chunk(3, 0.2, [ 'd' ]));
    scheduler.write(chunk(4, 0.1, [ 'f' ]));
    scheduler.write(chunk(0, 0.5, [ 'A' ]));
    scheduler.write(chunk(1, 0.4, [ 'B' ]));
    scheduler.write(chunk(2, 0.3, [ 'C' ]));

    expect('abcABCdf', done);
  });

  it('should not interleave sync data', function(done) {
    scheduler.write(chunk(0, false, [ 'hello ' ]));
    scheduler.write(chunk(1, false, [ 'world!' ]));
    scheduler.write(chunk(1, false, [ 'world' ]));
    scheduler.write(chunk(0, false, [ ' hello ' ]));
    scheduler.write(chunk(2, false, [ 'someone\'s ' ]));

    expect('hello world!world hello someone\'s ', done);
  });

  it('should not fail on big gap in priorities', function(done) {
    scheduler.write(chunk(255, false, [ 'hello' ]));

    expect('hello', done);
  });

  it('should invoke callback on push', function(done) {
    scheduler.write(chunk(0, 0, [ 'hello ' ], function() {
      assert.equal(scheduler.read().toString(), 'hello ');
      done();
    }));
  });
});
