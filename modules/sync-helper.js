var fs = require("fs");
var path = require("path");
var upath = require("upath");
var mkdirp = require("mkdirp");
var _ = require("lodash");
var isIgnored = require("./is-ignored");
var output = require("./output");
var FtpWrapper = require("./ftp-wrapper");
var SftpWrapper = require("./sftp-wrapper");
var ScpWrapper = require("./scp-wrapper");
var vscode = require("vscode");

var ftp;
var cancelled = false;
var transferPool = null;
var transferPoolReady = false;
var syncProgressDone = 0;
var syncProgressTotal = 0;
var connectionOpenedAt = 0;
var lastTransferAt = 0;
var activeTransfers = 0;
var pendingPoolReset = false;
var connecting = false;
var connectCallbacks = [];
var connectTimeoutId = null;

var makeCancelledError = function() {
  var err = new Error("cancelled");
  err.code = "FTP_SYNC_CANCELLED";
  return err;
};

var isCancelled = function() {
  return cancelled === true;
};

// This are the uncompleted requests.
var openListRemoteFilesRequests = 0;
var preparingRemoteFileList = false;

// get timestamp
var getCurrentTime = function() {
  var currentdate = new Date();

  return (
    currentdate.getDate() +
    "/" +
    (currentdate.getMonth() + 1) +
    "/" +
    currentdate.getFullYear() +
    " @ " +
    currentdate.getHours() +
    ":" +
    currentdate.getMinutes() +
    ":" +
    currentdate.getSeconds()
  );
};

//add options
var listRemoteFiles = function(
  remotePath,
  callback,
  originalRemotePath,
  options
) {
  if (isCancelled()) {
    callback(makeCancelledError());
    return;
  }
  output(getCurrentTime() + " > [ftp-sync] listRemoteFiles: " + remotePath);
  remotePath = upath.toUnix(remotePath);
  if (!originalRemotePath) {
    originalRemotePath = remotePath;
    preparingRemoteFileList = true;

    // Overwrite original callback to execute only if all open request are finish
    var oldCallback = callback;
    callback = function(error, result) {
      if (error) {
        preparingRemoteFileList = false;
        oldCallback(error, result);
        return;
      }
      if (openListRemoteFilesRequests === 0) {
        preparingRemoteFileList = false;
        oldCallback(error, result);
      }
    };
  }

  // Add a new open request
  openListRemoteFilesRequests += 1;

  ftpListWithRetry(remotePath, function(err, remoteFiles) {
    // The request is finish so remove it
    openListRemoteFilesRequests -= 1;

    if (isCancelled()) {
      callback(makeCancelledError());
      return;
    }

    if (err) {
      if (err.code == 450) callback(null, []);
      else callback(err);
      return;
    }

    var result = [];
    var subdirs = [];

    remoteFiles.forEach(function(fileInfo) {
      //when listing remoteFiles by onPrepareRemoteProgress, ignore remoteFiles
      if (
        isIgnored(
          path.join(remotePath, fileInfo.name),
          ftpConfig.allow,
          ftpConfig.ignore
        )
      )
        return;

      if (fileInfo.name == "." || fileInfo.name == "..") return;
      var remoteItemPath = upath.toUnix(path.join(remotePath, fileInfo.name));
      if (fileInfo.type != "d")
        result.push({
          name: remoteItemPath,
          size: fileInfo.size,
          isDir: false
        });
      else if (fileInfo.type == "d") {
        subdirs.push(fileInfo);
        result.push({
          name: remoteItemPath,
          isDir: true
        });
      }
    });
    var finish = function() {
      result.forEach(function(item) {
        if (_.startsWith(item.name, originalRemotePath))
          item.name = item.name.replace(originalRemotePath, "");
        if (item.name[0] == "/") item.name = item.name.substr(1);
        if (onPrepareRemoteProgress) onPrepareRemoteProgress(item.name);
      });
      result = _.sortBy(result, function(item) {
        return item.name;
      });
      callback(null, result);
    };

    var listNextSubdir = function() {
      var subdir = subdirs.shift();
      var subPath = upath.toUnix(path.join(remotePath, subdir.name));
      listRemoteFiles(
        subPath,
        function(err, subResult) {
          if (err) {
            callback(err);
            return;
          }
          result = _.union(result, subResult);
          if (subdirs.length == 0) finish();
          else listNextSubdir();
        },
        originalRemotePath,
        options
      );
    };

    if (remoteFiles.length == 0 || subdirs.length == 0) finish();
    else listNextSubdir();
  });
};
// list remote files, deep = 1
const listOneDeepRemoteFiles = function(remotePath, callback) {
  if (isCancelled()) {
    callback(makeCancelledError());
    return;
  }
  output(getCurrentTime() + " > [ftp-sync] listRemoteFiles: " + remotePath);
  remotePath = upath.toUnix(remotePath);
  ftpListWithRetry(remotePath, function(err, remoteFiles) {
    if (isCancelled()) {
      callback(makeCancelledError());
      return;
    }
    if (err) {
      if (err.code == 450) callback(null, []);
      else callback(err);
      return;
    }

    let result = [];

    if (remoteFiles.length == 0) {
      callback(null, result);
      return;
    }

    remoteFiles.forEach(function(fileInfo) {
      // when listing remoteFiles by onPrepareRemoteProgress, ignore remoteFiles
      if (
        isIgnored(
          path.join(remotePath, fileInfo.name),
          ftpConfig.allow,
          ftpConfig.ignore
        )
      )
        return;

      if (fileInfo.name == "." || fileInfo.name == "..") return;
      var remoteItemPath = upath.toUnix(path.join(remotePath, fileInfo.name));
      if (fileInfo.type != "d")
        result.push({
          name: remoteItemPath,
          size: fileInfo.size,
          isDir: false
        });
      else if (fileInfo.type == "d") {
        result.push({
          name: remoteItemPath,
          isDir: true
        });
      }
    });
    const finish = function() {
      result.forEach(function(item) {
        if (_.startsWith(item.name, remotePath)) {
          item.path = item.name;
          item.name = item.name.replace(remotePath, "");
        }
      });
      result = _.sortBy(result, function(item) {
        return item.name;
      });
      callback(null, result);
    };
    finish();
  });
};
// the entry of list request
const ListRemoteFilesByPath = function(remotePath, callback) {
  connect(function(err) {
    if (err) {
      callback(err);
      return;
    }
    listOneDeepRemoteFiles(remotePath, callback);
  });
};
const deleteRemoteFile = function(remoteFilePath) {
  return new Promise(function(resolve, reject) {
    connect(function(err) {
      if (err) {
        reject(err);
        return;
      }
      if (isCancelled()) {
        reject(makeCancelledError());
        return;
      }
      output(
        getCurrentTime() + " > [ftp-sync] deletRemoteFile: " + remoteFilePath
      );
      ftp.delete(remoteFilePath, function(err) {
        if (isCancelled()) {
          reject(makeCancelledError());
          return;
        }
        if (err) reject(err);
        else
          resolve({
            success: true,
            path: remoteFilePath
          });
      });
    });
  });
};
var walkLocalDir = function(dir, localPath, files, done) {
  if (isCancelled()) {
    done(makeCancelledError());
    return;
  }
  fs.readdir(dir, function(err, names) {
    if (err) {
      done(err);
      return;
    }
    if (!names || names.length === 0) {
      done(null);
      return;
    }

    var pending = names.length;
    var hadError = null;

    var next = function(err) {
      if (err && !hadError) hadError = err;
      pending -= 1;
      if (pending === 0) done(hadError);
    };

    names.forEach(function(name) {
      var fullPath = path.join(dir, name);
      if (isIgnored(fullPath, ftpConfig.allow, ftpConfig.ignore)) {
        next(null);
        return;
      }

      fs.stat(fullPath, function(statErr, stat) {
        if (isCancelled()) {
          next(makeCancelledError());
          return;
        }
        if (statErr) {
          next(statErr);
          return;
        }

        var relPath = path.relative(localPath, fullPath);
        relPath = upath.toUnix(relPath);
        if (relPath[0] == "/") relPath = relPath.substr(1);

        if (onPrepareLocalProgress) onPrepareLocalProgress(relPath);
        files.push({
          name: relPath,
          size: stat.size,
          isDir: stat.isDirectory()
        });

        if (stat.isDirectory()) walkLocalDir(fullPath, localPath, files, next);
        else next(null);
      });
    });
  });
};

//add options
var listLocalFiles = function(localPath, rootPath, callback, options) {
  if (isCancelled()) {
    callback(makeCancelledError());
    return;
  }
  output(getCurrentTime() + " > [ftp-sync] listLocalFiles:" + localPath);

  var files = [];

  walkLocalDir(localPath, localPath, files, function(err) {
    if (isCancelled()) {
      callback(makeCancelledError());
      return;
    }
    if (err) callback(err);
    else {
      output(
        getCurrentTime() +
          " > [ftp-sync] listLocalFiles done: " +
          files.length +
          " entries"
      );
      callback(null, files);
    }
  });
};

var prepareSyncObject = function(remoteFiles, localFiles, options, callback) {
  output(
    getCurrentTime() +
      " > [ftp-sync] comparing " +
      remoteFiles.length +
      " remote and " +
      localFiles.length +
      " local entries..."
  );

  setImmediate(function() {
    if (isCancelled()) {
      callback(makeCancelledError());
      return;
    }

    try {
      var from = options.upload ? localFiles : remoteFiles;
      var to = options.upload ? remoteFiles : localFiles;

      var skipIgnores = function(file) {
        return isIgnored(
          path.join(options.remotePath, file.name),
          ftpConfig.allow,
          ftpConfig.ignore
        );
      };

      _.remove(from, skipIgnores);
      _.remove(to, skipIgnores);

      var toByName = {};
      to.forEach(function(toFile) {
        toByName[toFile.name] = toFile;
      });

      var filesToUpdate = [];
      var filesToAdd = [];
      var dirsToAdd = [];
      var filesToRemove = [];
      var dirsToRemove = [];

      if (options.mode == "force")
        from.forEach(function(fromFile) {
          var toEquivalent = toByName[fromFile.name];
          if (toEquivalent && !fromFile.isDir) filesToUpdate.push(fromFile.name);
          if (!toEquivalent) {
            if (fromFile.isDir) dirsToAdd.push(fromFile.name);
            else filesToAdd.push(fromFile.name);
          }
        });
      else
        from.forEach(function(fromFile) {
          var toEquivalent = toByName[fromFile.name];
          if (!toEquivalent && !fromFile.isDir) filesToAdd.push(fromFile.name);
          if (!toEquivalent && fromFile.isDir) dirsToAdd.push(fromFile.name);
          if (toEquivalent) toEquivalent.wasOnFrom = true;
          if (
            toEquivalent &&
            toEquivalent.size != fromFile.size &&
            !fromFile.isDir
          )
            filesToUpdate.push(fromFile.name);
        });

      if (options.mode == "full")
        to.filter(function(toFile) {
          return !toFile.wasOnFrom;
        }).forEach(function(toFile) {
          if (toFile.isDir) dirsToRemove.push(toFile.name);
          else filesToRemove.push(toFile.name);
        });

      var sync = {
        _readMe:
          "Review list of sync operations, then use Ftp-sync: Commit command to accept changes. Note that if you're not in your root directory then all the parent directories will also be uploaded",
        _warning:
          "This file should not be saved, reopened review file won't work!",
        filesToUpdate: filesToUpdate,
        filesToAdd: filesToAdd,
        dirsToAdd: dirsToAdd,
        filesToRemove: filesToRemove,
        dirsToRemove: dirsToRemove
      };

      output(
        getCurrentTime() +
          " > [ftp-sync] compare done: " +
          totalOperations(sync) +
          " operations"
      );
      callback(null, sync);
    } catch (e) {
      callback(e);
    }
  });
};

var totalOperations = function(sync) {
  return (
    sync.filesToUpdate.length +
    sync.filesToAdd.length +
    sync.dirsToAdd.length +
    sync.filesToRemove.length +
    sync.dirsToRemove.length
  );
};

var onPrepareRemoteProgress, onPrepareLocalProgress, onSyncProgress;
var connected = false;

var createWrapper = function(config) {
  return config.protocol == "sftp"
    ? new SftpWrapper()
    : config.protocol == "scp"
    ? new ScpWrapper()
    : new FtpWrapper();
};

var normalizeMaxConnections = function(config) {
  var n = Number(config && config.maxConnections);
  if (!Number.isFinite(n)) return 1;
  n = Math.floor(n);
  if (n < 1) return 1;
  if (n > 20) return 20;
  return n;
};

var buildConnectOptions = function(extra) {
  var cfg = Object.assign({}, ftpConfig, extra || {});
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    secure: cfg.secure,
    secureOptions: cfg.secureOptions,
    connTimeout: cfg.connTimeout,
    pasvTimeout: cfg.pasvTimeout,
    keepalive: cfg.keepalive,
    debug: cfg.debug
  };
};

var getNoTransferReconnectMs = function() {
  var ms = Number(ftpConfig && ftpConfig.noTransferReconnectMs);
  if (!Number.isFinite(ms) || ms < 10000) ms = 45000;
  if (ms > 300000) ms = 300000;
  return Math.floor(ms);
};

var markConnectionOpened = function() {
  connectionOpenedAt = Date.now();
};

var markTransferActivity = function() {
  lastTransferAt = Date.now();
};

var getNoTransferIdleMs = function() {
  var since = lastTransferAt || connectionOpenedAt;
  if (!since) return 0;
  return Date.now() - since;
};

var safeResetForRetry = function() {
  if (activeTransfers > 0) {
    pendingPoolReset = true;
    return;
  }
  resetConnection();
};

var flushPendingPoolReset = function() {
  if (activeTransfers === 0 && pendingPoolReset) {
    resetConnection();
    pendingPoolReset = false;
  }
};

var getConnectTimeoutMs = function() {
  var ms = Number(ftpConfig && ftpConfig.connTimeout);
  if (!Number.isFinite(ms) || ms < 1000) ms = 10000;
  if (ms > 120000) ms = 120000;
  return Math.floor(ms);
};

var flushConnectCallbacks = function(err) {
  if (connectTimeoutId) {
    clearTimeout(connectTimeoutId);
    connectTimeoutId = null;
  }
  connecting = false;
  var cbs = connectCallbacks.slice();
  connectCallbacks = [];
  cbs.forEach(function(cb) {
    try {
      cb(err);
    } catch (e) {}
  });
};

var finishConnectReady = function(err) {
  if (connectTimeoutId) {
    clearTimeout(connectTimeoutId);
    connectTimeoutId = null;
  }
  if (err) {
    connected = false;
    flushConnectCallbacks(err);
    return;
  }
  connected = true;
  markConnectionOpened();
  flushConnectCallbacks(null);
};

var beginConnectionAttempt = function() {
  if (!ftp) {
    flushConnectCallbacks(new Error("FTP client not initialized"));
    return;
  }

  var timedOut = false;
  connectTimeoutId = setTimeout(function() {
    if (!connecting) return;
    timedOut = true;
    output(
      getCurrentTime() +
        " > [sync-helper] connect timeout after " +
        getConnectTimeoutMs() +
        "ms"
    );
    try {
      if (ftp) ftp.end();
    } catch (e) {}
    connected = false;
    flushConnectCallbacks(
      new Error("Connection timed out after " + getConnectTimeoutMs() + "ms")
    );
  }, getConnectTimeoutMs());

  ftp.onready(function() {
    if (timedOut || !connecting) return;
    if (!ftpConfig.passive && ftpConfig.protocol != "sftp") finishConnectReady();
    else if (ftpConfig.protocol == "sftp") ftp.goSftp(finishConnectReady);
    else if (ftpConfig.passive) ftp.pasv(finishConnectReady);
    else finishConnectReady();
  });

  ftp.onerror(function(err) {
    if (timedOut) return;
    connected = false;
    finishConnectReady(err);
  });

  ftp.onclose(function() {
    output(getCurrentTime() + " > [ftp-sync] connection closed");
    connected = false;
  });

  ftp.connect(buildConnectOptions());
};

var isRetryableError = function(err) {
  return isTransferRetryableError(err);
};

var runNonTransferWithRetry = function(label, attemptFn, callback) {
  withRetry(
    label,
    function(done) {
      if (isCancelled()) {
        done(makeCancelledError());
        return;
      }
      connect(function(err) {
        if (err) {
          done(err);
          return;
        }
        attemptFn(done);
      });
    },
    callback
  );
};

var ftpListWithRetry = function(remotePath, callback) {
  runNonTransferWithRetry(
    "list " + remotePath,
    function(done) {
      ftp.list(remotePath, function(err, remoteFiles) {
        if (err) {
          if (err.code == 450) {
            callback(null, []);
            done();
          } else {
            done(err);
          }
          return;
        }
        callback(null, remoteFiles);
        done();
      });
    },
    function(err) {
      if (err) callback(err);
    }
  );
};

var getRetrySettings = function() {
  var n = Number(ftpConfig && ftpConfig.retryCount);
  if (!Number.isFinite(n) || n < 0) n = 3;
  n = Math.floor(n);
  if (n > 10) n = 10;
  var delay = Number(ftpConfig && ftpConfig.retryDelayMs);
  if (!Number.isFinite(delay) || delay < 0) delay = 2000;
  return { count: n, delay: Math.floor(delay) };
};

var isTransferRetryableError = function(err) {
  if (!err) return false;
  if (err.code === "FTP_SYNC_CANCELLED") return false;
  var msg = String(err.message || err).toLowerCase();
  if (/no transfer|no-transfer/.test(msg)) return true;
  if (err.code === 421 || /421/.test(msg)) return true;
  if (/timeout|timed out|econnrefused|enetunreach|enotfound/.test(msg)) return true;
  return (
    err.code === "ECONNRESET" ||
    err.code === "ETIMEDOUT" ||
    err.code === "EPIPE" ||
    err.code === "ECONNREFUSED" ||
    err.code === "ENOTFOUND" ||
    /connection closed|connection lost|socket hang up|broken pipe/.test(msg)
  );
};

var resetConnection = function() {
  connected = false;
  connecting = false;
  if (connectTimeoutId) {
    clearTimeout(connectTimeoutId);
    connectTimeoutId = null;
  }
  connectionOpenedAt = 0;
  lastTransferAt = 0;
  endTransferPool();
  try {
    if (ftp) ftp.end();
  } catch (e) {}
  if (ftpConfig) ftp = createWrapper(ftpConfig);
};

var withRetry = function(label, attemptFn, callback) {
  var settings = getRetrySettings();
  if (settings.count === 0) {
    attemptFn(callback);
    return;
  }
  var maxAttempts = settings.count + 1;
  var attempt = 0;
  var retryStatus = null;

  var cleanupStatus = function() {
    if (retryStatus) {
      retryStatus.dispose();
      retryStatus = null;
    }
  };

  var run = function() {
    if (isCancelled()) {
      cleanupStatus();
      callback(makeCancelledError());
      return;
    }
    attempt += 1;
    attemptFn(function(err) {
      if (!err) {
        cleanupStatus();
        callback.apply(null, arguments);
        return;
      }
      if (!isTransferRetryableError(err) || attempt >= maxAttempts) {
        cleanupStatus();
        callback(err);
        return;
      }
      output(
        getCurrentTime() +
          " > [ftp-sync] retry " +
          attempt +
          "/" +
          settings.count +
          " (" +
          label +
          "): " +
          err.message
      );
      safeResetForRetry();
      retryStatus = vscode.window.setStatusBarMessage(
        "Ftp-sync: tentativa " +
          (attempt + 1) +
          "/" +
          maxAttempts +
          " (" +
          label +
          ")..."
      );
      setTimeout(run, settings.delay);
    });
  };

  run();
};

var runTransferWithRetry = function(label, runWithClient, callback) {
  withRetry(label, function(done) {
    var needsReconnect =
      !connected || getNoTransferIdleMs() >= getNoTransferReconnectMs();
    if (needsReconnect && activeTransfers === 0) {
      resetConnection();
    }

    var execute = function() {
      activeTransfers += 1;
      runWithClient(function(err) {
        activeTransfers -= 1;
        if (!err) markTransferActivity();
        flushPendingPoolReset();
        done(err);
      });
    };

    if (transferPoolReady && connected && !needsReconnect) {
      execute();
      return;
    }
    connect(function(err) {
      if (err) {
        done(err);
        return;
      }
      ensureTransferPool(function(poolErr) {
        if (poolErr) {
          done(poolErr);
          return;
        }
        execute();
      });
    });
  }, callback);
};

var connectClient = function(client, callback) {
  if (isCancelled()) {
    callback(makeCancelledError());
    return;
  }

  var done = false;
  var finishOnce = function(err) {
    if (done) return;
    done = true;
    callback(err);
  };

  client.onready(function() {
    if (!ftpConfig.passive && ftpConfig.protocol != "sftp") finishOnce();
    else if (ftpConfig.protocol == "sftp") client.goSftp(finishOnce);
    else if (ftpConfig.passive) client.pasv(finishOnce);
    else finishOnce();
  });
  client.onerror(finishOnce);
  client.onclose(function() {});

  client.connect(buildConnectOptions());
};

var ensureTransferPool = function(callback) {
  if (transferPoolReady) {
    callback();
    return;
  }

  var max = normalizeMaxConnections(ftpConfig);
  if (max <= 1) {
    transferPool = null;
    transferPoolReady = true;
    callback();
    return;
  }

  transferPoolReady = false;
  transferPool = [];

  var remaining = max;
  var failed = false;
  var finishOnce = function(err) {
    if (failed) return;
    if (err) {
      failed = true;
      try {
        if (transferPool) {
          transferPool.forEach(function(c) {
            try {
              c.end();
            } catch (e) {}
          });
        }
      } finally {
        transferPool = null;
        transferPoolReady = false;
      }
      callback(err);
      return;
    }
    remaining -= 1;
    if (remaining === 0) {
      transferPoolReady = true;
      callback();
    }
  };

  for (var i = 0; i < max; i++) {
    (function() {
      var client = createWrapper(ftpConfig);
      connectClient(client, function(err) {
        if (failed) {
          try {
            client.end();
          } catch (e) {}
          return;
        }
        if (err) {
          finishOnce(err);
          return;
        }
        transferPool.push(client);
        finishOnce();
      });
    })();
  }
};

var endTransferPool = function() {
  if (!transferPool) return;
  transferPool.forEach(function(c) {
    try {
      c.end();
    } catch (e) {}
  });
  transferPool = null;
  transferPoolReady = false;
};

var runLimited = function(items, limit, iterator, callback) {
  if (!items || items.length === 0) {
    callback();
    return;
  }
  if (limit < 1) limit = 1;
  var idx = 0;
  var running = 0;
  var finished = 0;
  var ended = false;
  var total = items.length;

  var pump = function() {
    if (ended) return;
    if (isCancelled()) {
      ended = true;
      callback(makeCancelledError());
      return;
    }
    while (running < limit && idx < total) {
      (function(item) {
        running += 1;
        iterator(item, function(err) {
          running -= 1;
          if (ended) return;
          if (err) {
            ended = true;
            callback(err);
            return;
          }
          finished += 1;
          if (onSyncProgress != null)
            onSyncProgress(syncProgressDone + finished, syncProgressTotal);
          if (finished === total) {
            ended = true;
            callback();
          } else {
            pump();
          }
        });
      })(items[idx++]);
    }
  };

  pump();
};

var connect = function(callback) {
  output(getCurrentTime() + " > [sync-helper] connect");
  if (isCancelled()) {
    callback(makeCancelledError());
    return;
  }
  if (connected) {
    callback();
    return;
  }

  connectCallbacks.push(callback);
  if (connecting) return;

  connecting = true;

  var startAttempt = function() {
    if (isCancelled()) {
      flushConnectCallbacks(makeCancelledError());
      return;
    }
    beginConnectionAttempt();
  };

  if (
    ((ftpConfig.protocol == "sftp" || ftpConfig.protocol == "scp") &&
      !ftpConfig.password &&
      !ftpConfig.privateKeyPath) ||
    !ftpConfig.password
  ) {
    vscode.window
      .showInputBox({
        prompt: '[ftp-sync] Password for "' + ftpConfig.host + '"',
        password: true
      })
      .then(function(password) {
        if (isCancelled()) {
          flushConnectCallbacks(makeCancelledError());
          return;
        }
        if (!password) {
          flushConnectCallbacks(new Error("Password required"));
          return;
        }
        ftpConfig.password = password;
        startAttempt();
      });
  } else {
    startAttempt();
  }
};

var prepareSync = function(options, callback) {
  connect(function(err) {
    if (err) callback(err);
    else
      listRemoteFiles(
        options.remotePath,
        function(err, remoteFiles) {
          if (err) callback(err);
          else {
            output(
              getCurrentTime() +
                " > [ftp-sync] listRemoteFiles done: " +
                remoteFiles.length +
                " entries"
            );
            listLocalFiles(
              options.localPath,
              options.rootPath,
              function(err, localFiles) {
                if (err) callback(err);
                else
                  prepareSyncObject(remoteFiles, localFiles, options, callback);
              },
              options
            );
          }
        },
        null,
        options
      );
  });
};

var executeSyncLocal = function(sync, options, callback) {
  if (isCancelled()) {
    callback(makeCancelledError());
    return;
  }
  if (onSyncProgress != null) onSyncProgress(syncProgressDone, syncProgressTotal);

  if (sync.dirsToAdd.length > 0) {
    var dirToAdd = sync.dirsToAdd.pop();
    var localPath = path.join(options.localPath, dirToAdd);

    output(getCurrentTime() + " > [ftp-sync] syncLocal createDir: " + dirToAdd);

    mkdirp(localPath, function(err) {
      if (isCancelled()) {
        callback(makeCancelledError());
        return;
      }
      if (err) callback(err);
      else {
        syncProgressDone += 1;
        executeSyncLocal(sync, options, callback);
      }
    });
  } else if (sync.filesToAdd.length > 0 || sync.filesToUpdate.length > 0) {
    var files = sync.filesToAdd.concat(sync.filesToUpdate);
    sync.filesToAdd = [];
    sync.filesToUpdate = [];

    ensureTransferPool(function(err) {
      if (err) {
        callback(err);
        return;
      }

      var limit = transferPool ? transferPool.length : 1;
      var rr = 0;

      runLimited(
        files,
        limit,
        function(fileToReplace, done) {
          var local = path.join(options.localPath, fileToReplace);
          var remote = upath.toUnix(path.join(options.remotePath, fileToReplace));
          output(getCurrentTime() + " > [ftp-sync] syncLocal replace: " + remote);
          runTransferWithRetry(
            "download " + fileToReplace,
            function(attemptDone) {
              var client = transferPool
                ? transferPool[rr++ % transferPool.length]
                : ftp;
              client.get(remote, local, attemptDone);
            },
            done
          );
        },
        function(e) {
          if (e) {
            callback(e);
            return;
          }
          syncProgressDone += files.length;
          executeSyncLocal(sync, options, callback);
        }
      );
    });
  } else if (sync.filesToRemove.length > 0) {
    var fileToRemove = sync.filesToRemove.pop();
    var localPath = path.join(options.localPath, fileToRemove);

    output(
      getCurrentTime() + " > [ftp-sync] syncLocal removeFile: " + fileToRemove
    );

    fs.unlink(localPath, function(err) {
      if (isCancelled()) {
        callback(makeCancelledError());
        return;
      }
      if (err) callback(err);
      else {
        syncProgressDone += 1;
        executeSyncLocal(sync, options, callback);
      }
    });
  } else if (sync.dirsToRemove.length > 0) {
    var dirToRemove = sync.dirsToRemove.pop();
    var localPath = path.join(options.localPath, dirToRemove);

    output(getCurrentTime() + " > [ftp-sync] syncLocal removeDir: " + dirToAdd);

    fs.rmdir(localPath, function(err) {
      if (isCancelled()) {
        callback(makeCancelledError());
        return;
      }
      if (err) callback(err);
      else {
        syncProgressDone += 1;
        executeSyncLocal(sync, options, callback);
      }
    });
  } else {
    callback();
  }
};

var executeSyncRemote = function(sync, options, callback) {
  if (isCancelled()) {
    callback(makeCancelledError());
    return;
  }
  if (onSyncProgress != null) onSyncProgress(syncProgressDone, syncProgressTotal);

  if (sync.dirsToAdd.length > 0) {
    var dirToAdd = sync.dirsToAdd.shift();
    var remotePath = upath.toUnix(path.join(options.remotePath, dirToAdd));

    output(
      getCurrentTime() + " > [ftp-sync] syncRemote createDir: " + dirToAdd
    );

    ftp.mkdir(
      remotePath,
      function(err) {
        if (isCancelled()) {
          callback(makeCancelledError());
          return;
        }
        if (err) callback(err);
        else {
          syncProgressDone += 1;
          executeSyncRemote(sync, options, callback);
        }
      },
      true
    );
  } else if (sync.filesToAdd.length > 0 || sync.filesToUpdate.length > 0) {
    var files = sync.filesToAdd.concat(sync.filesToUpdate);
    sync.filesToAdd = [];
    sync.filesToUpdate = [];

    ensureTransferPool(function(err) {
      if (err) {
        callback(err);
        return;
      }

      var limit = transferPool ? transferPool.length : 1;
      var rr = 0;

      runLimited(
        files,
        limit,
        function(fileToReplace, done) {
          var local = path.join(options.localPath, fileToReplace);
          var remote = upath.toUnix(path.join(options.remotePath, fileToReplace));
          output(getCurrentTime() + " > [ftp-sync] syncRemote replace: " + local);
          runTransferWithRetry(
            "upload " + fileToReplace,
            function(attemptDone) {
              var client = transferPool
                ? transferPool[rr++ % transferPool.length]
                : ftp;
              client.put(local, remote, attemptDone);
            },
            done
          );
        },
        function(e) {
          if (e) {
            callback(e);
            return;
          }
          syncProgressDone += files.length;
          executeSyncRemote(sync, options, callback);
        }
      );
    });
  } else if (sync.filesToRemove.length > 0) {
    var fileToRemove = sync.filesToRemove.pop();
    var remotePath = upath.toUnix(path.join(options.remotePath, fileToRemove));

    output(
      getCurrentTime() + " > [ftp-sync] syncRemote removeFile: " + fileToRemove
    );

    ftp.delete(remotePath, function(err) {
      if (isCancelled()) {
        callback(makeCancelledError());
        return;
      }
      if (err) callback(err);
      else {
        syncProgressDone += 1;
        executeSyncRemote(sync, options, callback);
      }
    });
  } else if (sync.dirsToRemove.length > 0) {
    var dirToRemove = sync.dirsToRemove.pop();
    var remotePath = upath.toUnix(path.join(options.remotePath, dirToRemove));

    output(
      getCurrentTime() + " > [ftp-sync] syncRemote removeDir: " + dirToRemove
    );

    ftp.rmdir(remotePath, function(err) {
      if (isCancelled()) {
        callback(makeCancelledError());
        return;
      }
      if (err) callback(err);
      else {
        syncProgressDone += 1;
        executeSyncRemote(sync, options, callback);
      }
    });
  } else {
    callback();
  }
};

var ensureDirExists = function(remoteDir, callback) {
  ftp.list(path.posix.join(remoteDir, ".."), function(err, list) {
    if (err) {
      ensureDirExists(path.posix.join(remoteDir, ".."), function() {
        ensureDirExists(remoteDir, callback);
      });
    } else if (_.some(list, f => {
      return f.name == path.basename(remoteDir);
    })) {
      callback();
    } else {
      ftp.mkdir(
        remoteDir,
        function(err) {
          if (err) callback(err);
          else callback();
        },
        true
      );
    }
  });
};

var uploadFile = function(localPath, rootPath, callback) {
  output(
    getCurrentTime() +
      " > [sync-helper] uploading: " +
      path.parse(localPath).base
  );
  var remotePath = upath.toUnix(
    path.join(ftpConfig.remote, localPath.replace(rootPath, ""))
  );
  var remoteDir = upath.toUnix(path.dirname(remotePath));
  connect(function(err) {
    if (err) {
      callback(err);
      return;
    }
    ensureTransferPool(function(poolErr) {
      if (poolErr) {
        callback(poolErr);
        return;
      }
      var putFile = function() {
        runTransferWithRetry(
          "upload " + path.parse(localPath).base,
          function(attemptDone) {
            var client = transferPool ? transferPool[0] : ftp;
            client.put(localPath, remotePath, attemptDone);
          },
          function(e) {
            endTransferPool();
            callback(e);
          }
        );
      };
      if (remoteDir != ".")
        ensureDirExists(remoteDir, function(e) {
          if (e) {
            endTransferPool();
            callback(e);
          }
          else putFile();
        });
      else putFile();
    });
  });
};

var downloadFile = function(localPath, rootPath, callback) {
  output(
    getCurrentTime() +
      " > [sync-helper] downloading: " +
      path.parse(localPath).base
  );
  var remotePath = upath.toUnix(
    path.join(ftpConfig.remote, localPath.replace(rootPath, ""))
  );
  var remoteDir = upath.toUnix(path.dirname(remotePath));
  connect(function(err) {
    if (err) callback(err);
    ensureTransferPool(function(poolErr) {
      if (poolErr) {
        callback(poolErr);
        return;
      }
      var getFile = function() {
        runTransferWithRetry(
          "download " + path.parse(localPath).base,
          function(attemptDone) {
            var client = transferPool ? transferPool[0] : ftp;
            client.get(remotePath, localPath, attemptDone);
          },
          function(e) {
            endTransferPool();
            callback(e);
          }
        );
      };
      if (remoteDir != ".")
        ensureDirExists(remoteDir, function(e) {
          if (e) {
            endTransferPool();
            callback(e);
          }
          else getFile();
        });
      else getFile();
    });
  });
};

var executeSync = function(sync, options, callback) {
  output(getCurrentTime() + " > [ftp-sync] sync starting");
  if (isCancelled()) {
    callback(makeCancelledError());
    return;
  }
  sync.startTotal = totalOperations(sync);
  syncProgressDone = 0;
  syncProgressTotal = sync.startTotal;
  connect(function(err) {
    if (err) {
      callback(err);
      return;
    }
    if (options.upload)
      executeSyncRemote(sync, options, function(e) {
        endTransferPool();
        callback(e);
      });
    else
      executeSyncLocal(sync, options, function(e) {
        endTransferPool();
        callback(e);
      });
  });
};

var ftpConfig;
var helper = {
  useConfig: function(config) {
    if (!ftpConfig || ftpConfig.protocol != config.protocol) ftp = createWrapper(config);
    ftpConfig = config;
    endTransferPool();
  },
  getConfig: function() {
    return ftpConfig;
  },
  prepareSync: prepareSync,
  ListRemoteFilesByPath: ListRemoteFilesByPath,
  deleteRemoteFile: deleteRemoteFile,
  executeSync: executeSync,
  totalOperations: totalOperations,
  uploadFile: uploadFile,
  downloadFile: downloadFile,
  disconnect: function() {
    ftp.end();
    endTransferPool();
  },
  cancel: function() {
    cancelled = true;
    activeTransfers = 0;
    pendingPoolReset = false;
    flushConnectCallbacks(makeCancelledError());
    try {
      if (ftp) ftp.end();
      endTransferPool();
    } catch (e) {
      // ignore
    }
    connected = false;
    connecting = false;
  },
  resetCancel: function() {
    cancelled = false;
    activeTransfers = 0;
    pendingPoolReset = false;
  },
  onPrepareRemoteProgress: function(callback) {
    onPrepareRemoteProgress = callback;
  },
  onPrepareLocalProgress: function(callback) {
    onPrepareLocalProgress = callback;
  },
  onSyncProgress: function(callback) {
    onSyncProgress = callback;
  }
};

module.exports = function(config) {
  return helper;
};
