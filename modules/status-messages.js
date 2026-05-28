var vscode = require("vscode");

var prepareMessage = null;
var prepareProgressMessage = null;

function _dispose(ref) {
  if (!ref) return;
  try {
    ref.dispose();
  } catch (e) {}
}

module.exports = {
  setPrepareMessage: function(text) {
    _dispose(prepareMessage);
    prepareMessage = vscode.window.setStatusBarMessage(text);
    return prepareMessage;
  },
  setPrepareProgressMessage: function(text) {
    _dispose(prepareProgressMessage);
    prepareProgressMessage = vscode.window.setStatusBarMessage(text);
    return prepareProgressMessage;
  },
  clearAll: function() {
    _dispose(prepareMessage);
    _dispose(prepareProgressMessage);
    prepareMessage = null;
    prepareProgressMessage = null;
  }
};

