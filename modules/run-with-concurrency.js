/**
 * Executa tasks com limite de concorrência. Para maxConcurrent <= 1, comportamento sequencial.
 */
module.exports = function runWithConcurrency(tasks, maxConcurrent, runner, callback) {
  if (!tasks || tasks.length === 0) {
    return callback();
  }

  maxConcurrent = Math.max(1, maxConcurrent || 1);
  if (maxConcurrent === 1) {
    var index = 0;
    var next = function(err) {
      if (err) return callback(err);
      if (index >= tasks.length) return callback();
      runner(tasks[index++], next);
    };
    return next();
  }

  var nextIndex = 0;
  var active = 0;
  var finished = false;
  var error = null;

  function startOne() {
    if (finished || error) return;
    if (nextIndex >= tasks.length) {
      if (active === 0) {
        finished = true;
        callback(error);
      }
      return;
    }
    var task = tasks[nextIndex++];
    active += 1;
    runner(task, function(err) {
      active -= 1;
      if (err && !error) error = err;
      if (error) {
        if (active === 0 && !finished) {
          finished = true;
          callback(error);
        }
        return;
      }
      startOne();
      if (nextIndex >= tasks.length && active === 0 && !finished) {
        finished = true;
        callback();
      }
    });
  }

  var initial = Math.min(maxConcurrent, tasks.length);
  for (var i = 0; i < initial; i++) {
    startOne();
  }
};
