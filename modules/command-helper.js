var vscode = require('vscode');

var _store = new WeakMap();

module.exports = {
	executeSync: function(syncHelper, sync, options) {
		var syncInfoMessage = null;

		// garante que um cancelamento anterior não “vaze” pra este sync
		if (syncHelper && typeof syncHelper.resetCancel === "function") {
			syncHelper.resetCancel();
		}
		
		syncHelper.onSyncProgress(function(done, of) {
			if(syncInfoMessage) syncInfoMessage.dispose();
			syncInfoMessage = vscode.window.setStatusBarMessage("Ftp-sync: sync progress: " + done + " of " + of + " operations done")
		});

		return vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Ftp-sync: sincronizando…",
			cancellable: true
		}, function(_progress, token) {
			token.onCancellationRequested(function() {
				if (syncInfoMessage) {
					syncInfoMessage.dispose(); // limpa o status imediatamente
					syncInfoMessage = null;
				}
				if (syncHelper && typeof syncHelper.cancel === "function") {
					syncHelper.cancel();
				}
				vscode.window.setStatusBarMessage("Ftp-sync: sync cancelado.", STATUS_TIMEOUT);
			});

			return new Promise(function(resolve) {
				syncHelper.executeSync(sync, options, function(err) {
					if(syncInfoMessage) syncInfoMessage.dispose();
					if(err && err.code === "FTP_SYNC_CANCELLED") {
						// cancelamento já informou/limpou status
						resolve();
						return;
					}
					if(err)
						vscode.window.showErrorMessage("Ftp-sync: sync error: " + err);
					else
						vscode.window.setStatusBarMessage("Ftp-sync: sync-complete!", STATUS_TIMEOUT);
					resolve();
				});
			});
		});
	},
	getStore: function(key) {
		if (!_store.has(key))
			_store.set(key, {});
		return _store.get(key);
	}
}
