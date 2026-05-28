/**
 * Servidores como FileZilla fecham a conexão se não houver STOR/RETR por X segundos
 * ("No transfer timeout"). LIST e NOOP não contam — este módulo envia um arquivo
 * mínimo periodicamente durante operações longas só de listagem/mkdir.
 */
var fs = require("fs");
var os = require("os");
var path = require("path");
var upath = require("upath");

var lastActivityAt = Date.now();
var keepaliveInProgress = false;
var localKeepalivePath = path.join(os.tmpdir(), "ftp-sync-keepalive.tmp");

function markActivity() {
  lastActivityAt = Date.now();
}

function ensure(ftp, ftpConfig, callback) {
  callback = callback || function() {};

  if (!ftp || !ftpConfig) {
    return callback();
  }

  var protocol = (ftpConfig.protocol || "ftp").toLowerCase();
  if (protocol === "sftp" || protocol === "scp") {
    return callback();
  }

  var interval = ftpConfig.transferKeepaliveInterval;
  if (interval === 0 || interval === false) {
    return callback();
  }
  if (interval === undefined || interval === null || interval === "") {
    interval = 45000;
  } else {
    interval = Number(interval);
    if (isNaN(interval) || interval < 0) {
      interval = 45000;
    }
  }

  if (interval === 0) {
    return callback();
  }

  if (keepaliveInProgress) {
    return callback();
  }

  if (Date.now() - lastActivityAt < interval) {
    return callback();
  }

  keepaliveInProgress = true;
  var remotePath = upath.toUnix(
    path.posix.join(ftpConfig.remote || "/", ".ftp-sync-keepalive")
  );

  fs.writeFile(localKeepalivePath, String(Date.now()), function(writeErr) {
    if (writeErr) {
      keepaliveInProgress = false;
      return callback();
    }

    ftp.put(localKeepalivePath, remotePath, function(putErr) {
      keepaliveInProgress = false;
      if (!putErr) {
        markActivity();
      }
      callback();
    });
  });
}

module.exports = {
  ensure: ensure,
  markActivity: markActivity
};
