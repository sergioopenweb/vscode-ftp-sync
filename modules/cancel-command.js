var vscode = require("vscode");
var syncCancel = require("./sync-cancel");

module.exports = function(getSyncHelper) {
  getSyncHelper().cancel();
  vscode.window.showInformationMessage("Ftp-sync: " + syncCancel.CANCELLED_MSG);
};
