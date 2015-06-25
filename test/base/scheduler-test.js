var assert = require('assert');

var transport = require('../../');
var base = transport.protocol.base;

describe('Frame Scheduler', function() {
  var scheduler;
  var random = [];
  beforeEach(function() {
    scheduler = base.Scheduler.create({
      random: function() {
        if (random.length === 0)
          return Math.random();
        else
          return random.shift();
      }
    });
  });

  function range(from, to) {
    return { from: from, to: to };
  }

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
    scheduler.write(chunk(0, range(0, 1), [ 'hello', ' ', 'world' ]));

    expect('hello world', done);
  });

  it('should schedule and emit two frames', function(done) {
    scheduler.write(chunk(0, range(0, 1), [ 'hello', ' ' ]));
    scheduler.write(chunk(0, range(0, 1), [ 'world' ]));

    expect('hello world', done);
  });

  it('should interleave between two streams', function(done) {
    random.push(0.25, 0.75, 0.25, 0.75);

    scheduler.write(chunk(0, range(0, 0.5), [ 'hello ' ]));
    scheduler.write(chunk(0, range(0, 0.5), [ ' hello ' ]));
    scheduler.write(chunk(1, range(0.5, 1), [ 'world!' ]));
    scheduler.write(chunk(1, range(0.5, 1), [ 'world' ]));

    expect('hello world! hello world', done);
  });

  it('should interleave between two shuffled streams', function(done) {
    random.push(0.25, 0.75, 0.25, 0.75);

    scheduler.write(chunk(0, range(0, 0.5), [ 'hello ' ]));
    scheduler.write(chunk(1, range(0.5, 1), [ 'world!' ]));
    scheduler.write(chunk(1, range(0.5, 1), [ 'world' ]));
    scheduler.write(chunk(0, range(0, 0.5), [ ' hello ' ]));

    expect('hello world! hello world', done);
  });

  it('should interleave between three streams', function(done) {
    random.push(0.25, 0.5, 0.8, 0.25, 0.5);

    scheduler.write(chunk(0, range(0, 0.33), [ 'hello ' ]));
    scheduler.write(chunk(1, range(0.33, 0.66), [ 'world!' ]));
    scheduler.write(chunk(1, range(0.33, 0.66), [ 'world' ]));
    scheduler.write(chunk(0, range(0, 0.33), [ ' hello ' ]));
    scheduler.write(chunk(2, range(0.66, 1), [ ' (yes)' ]));

    expect('hello world! (yes) hello world', done);
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
