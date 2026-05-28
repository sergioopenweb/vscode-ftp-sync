var vscode = require("vscode");
var syncCancel = require("./sync-cancel");
var statusMessages = require("./status-messages");

module.exports = function(getSyncHelper) {
  getSyncHelper().cancel();
  statusMessages.clearAll();
  vscode.window.showInformationMessage("Ftp-sync: " + syncCancel.CANCELLED_MSG);
};
