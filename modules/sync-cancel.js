var CANCELLED_MSG = "Operação cancelada pelo usuário.";
var cancelRequested = false;

module.exports = {
  CANCELLED_MSG: CANCELLED_MSG,
  request: function() {
    cancelRequested = true;
  },
  reset: function() {
    cancelRequested = false;
  },
  isRequested: function() {
    return cancelRequested;
  },
  isCancelledError: function(err) {
    return err === CANCELLED_MSG;
  },
  callbackIfCancelled: function(callback) {
    if (cancelRequested && callback) {
      callback(CANCELLED_MSG);
      return true;
    }
    return false;
  },
  normalizeError: function(err, formatErrorFn) {
    if (cancelRequested) {
      return CANCELLED_MSG;
    }
    if (!err) {
      return err;
    }
    if (typeof err === "string") {
      return err;
    }
    return formatErrorFn(err);
  }
};
