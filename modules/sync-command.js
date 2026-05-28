/* global STATUS_TIMEOUT */
var vscode = require('vscode');
var ftpconfig = require('./ftp-config');
var dirpick = require('./dirpick');
var path = require('path');
var helper = require('./command-helper');
var formatError = require('./connection-errors').formatConnectionError;
var syncCancel = require('./sync-cancel');
var statusMessages = require("./status-messages");

function showSyncFailure(getSyncHelper, err) {
	if (syncCancel.isCancelledError(err)) {
		vscode.window.showInformationMessage("Ftp-sync: " + err);
	} else {
		vscode.window.showErrorMessage("Ftp-sync: sync error: " + formatError(err));
	}
}

module.exports = function(isUpload, getSyncHelper, initialDirPath) {
	
	if(!ftpconfig.validateConfig())
		return;
	
	var showSyncSummary = function(sync, options) {
		var syncJson = JSON.stringify(sync, null, 4);
		var filePath = path.normalize(ftpconfig.rootPath().fsPath + "/.vscode/sync-summary-" + Math.floor(Date.now() / 1000) + ".json");
		var uri = vscode.Uri.parse("untitled:" + filePath);
        var prepareSyncDocument = vscode.workspace.openTextDocument(uri);
		prepareSyncDocument.then(function(document) {
			var showSyncDocument = vscode.window.showTextDocument(document);
			showSyncDocument.then(function() {
				var edit = vscode.window.activeTextEditor.edit(function(editBuilder) {
					editBuilder.delete(new vscode.Range(
						new vscode.Position(0,0),
						new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
					));
				});
				edit.then(function () {
					vscode.window.activeTextEditor.edit(function (editBuilder) {
						editBuilder.insert(new vscode.Position(0, 0), syncJson);
					});
				});
				helper.getStore(vscode.window.activeTextEditor.document).syncOptions = options;
			}, function(err) {
            vscode.window.showErrorMessage("Ftp-sync: sync error: " + err)
            })
		}, function(err) {
            vscode.window.showErrorMessage("Ftp-sync: sync error: " + err)
        });
	}
	
	var prepareProgressMessage;
	getSyncHelper().onPrepareRemoteProgress(function(path) {
		prepareProgressMessage = statusMessages.setPrepareProgressMessage(
			"Ftp-sync: collecting remote files list (" + path + ")"
		);
	});
	getSyncHelper().onPrepareLocalProgress(function(path) {
		prepareProgressMessage = statusMessages.setPrepareProgressMessage(
			"Ftp-sync: collecting local files list (" + path + ")"
		);
	});
	
	var prepareSync = function(options) {
		var syncMessage = statusMessages.setPrepareMessage("Ftp-sync: sync prepare in progress...");
		getSyncHelper().prepareSync(options, function(err, sync) {
			statusMessages.clearAll();
			if(err) showSyncFailure(getSyncHelper, err);
			else {
				var pickOptions = [{
						label: "Run",
						description: "Run all " + getSyncHelper().totalOperations(sync) + " operations now",
						operation: "run"
					}, {
						label: "Review",
						description: "Let me review and change operations list",
						operation: "review"
					}, {
						label: "Cancel",
						description: "I've changed my mind, cancel sync"
					}];

				var pickResult = vscode.window.showQuickPick(pickOptions, {
					placeHolder: "There are " + getSyncHelper().totalOperations(sync) + " operations to perform"
				});
				
				pickResult.then(function(result) {
					if(result && result.operation == "run")
						helper.executeSync(getSyncHelper(), sync, options)
					else if(result && result.operation == "review")
						showSyncSummary(sync, options);
				})
				
			}
		});
	}
	
	var prepareoptions = function(dirPath) {
		
		var pickResult = vscode.window.showQuickPick([{
			label: "Full-sync",
			description: "Removes orphan files on " + (isUpload ? "remote" : "local"),
			mode: "full"
		}, {
			label: "Safe-sync",
			description: "Don't remove orphan files on " + (isUpload ? "remote" : "local"),
			mode: "safe"
		}, {
			label: isUpload ? "Force-upload" : "Force download",
			description: (isUpload ? "Uploads" : "Downloads") + " files, no matter changed or not",
			mode: "force"
		}], { placeHolder: "How do you like to sync your files?" });
		
		pickResult.then(function(result) {
			if(!result) return;
			var syncOptions = {
				remotePath: path.join(getSyncHelper().getConfig().remote, dirPath),
				localPath: path.join(ftpconfig.rootPath().fsPath, dirPath),
				rootPath: ftpconfig.rootPath().fsPath,
				upload: isUpload,
				mode: result.mode
			};
			
			prepareSync(syncOptions);
		})
		
	}
	
	var syncDir = function(dirPath) {
		if(dirPath) {
			prepareoptions(dirPath);
		}
	}
	
	if (initialDirPath != null) {
		syncDir(initialDirPath);
	} else {
		dirpick(syncDir);
	}
}
