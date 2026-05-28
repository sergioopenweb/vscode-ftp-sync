var fs = require("fs");
var path = require("path");
var upath = require("upath");
var mkdirp = require("mkdirp");
var fswalk = require("fs-walk");
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

    // Overwrite original callback to execute only if all open request are finish
    var oldCallback = callback;
    callback = function(error, result) {
      if (openListRemoteFilesRequests === 0) {
        oldCallback(error, result);
      }
    };
  }

  // Add a new open request
  openListRemoteFilesRequests += 1;

  ftp.list(remotePath, function(err, remoteFiles) {
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

    if (remoteFiles.length == 0) callback(null, result);

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

    if (subdirs.length == 0) finish();
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
  ftp.list(remotePath, function(err, remoteFiles) {
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
//add options
var listLocalFiles = function(localPath, rootPath, callback, options) {
  if (isCancelled()) {
    callback(makeCancelledError());
    return;
  }
  output(getCurrentTime() + " > [ftp-sync] listLocalFiles:" + localPath);

  var files = [];

  // if (localPath != rootPath) {
  //   fswalk.dirs(
  //     localPath,
  //     function(basedir, filename, stat, next) {
  //       var dirPath = path.join(basedir, filename);
  //       if (isIgnored(dirPath, ftpConfig.allow, ftpConfig.ignore))
  //         return next();
  //       dirPath = dirPath.replace(localPath, "");
  //       dirPath = upath.toUnix(dirPath);
  //       if (dirPath[0] == "/") dirPath = dirPath.substr(1);
  //       if (onPrepareLocalProgress) onPrepareLocalProgress(dirPath);
  //       files.push({
  //         name: dirPath,
  //         size: stat.size,
  //         isDir: stat.isDirectory()
  //       });
  //       next();
  //     },
  //     function(err) {
  //       callback(err, files);
  //     }
  //   );
  //   fswalk.files(
  //     localPath,
  //     function(basedir, filename, stat, next) {
  //       var filePath = path.join(basedir, filename);
  //       //when listing localFiles by onPrepareLocalProgress, ignore localfile
  //       if (isIgnored(filePath, ftpConfig.allow, ftpConfig.ignore))
  //         return next();
  //       filePath = filePath.replace(localPath, "");
  //       filePath = upath.toUnix(filePath);
  //       if (filePath[0] == "/") filePath = filePath.substr(1);

  //       if (onPrepareLocalProgress) onPrepareLocalProgress(filePath);
  //       files.push({
  //         name: filePath,
  //         size: stat.size,
  //         isDir: stat.isDirectory()
  //       });
  //       next();
  //     },
  //     function(err) {
  //       callback(err, files);
  //     }
  //   );
  // }
  // if (localPath === rootPath) {
    fswalk.walk(
      localPath,
      function(basedir, filename, stat, next) {
        if (isCancelled()) {
          callback(makeCancelledError());
          return;
        }
        var filePath = path.join(basedir, filename);
        //when listing localFiles by onPrepareLocalProgress, ignore localfile
        if (isIgnored(filePath, ftpConfig.allow, ftpConfig.ignore))
          return next();
        filePath = filePath.replace(localPath, "");
        filePath = upath.toUnix(filePath);
        if (filePath[0] == "/") filePath = filePath.substr(1);

        if (onPrepareLocalProgress) onPrepareLocalProgress(filePath);
        files.push({
          name: filePath,
          size: stat.size,
          isDir: stat.isDirectory()
        });
        next();
      },
      function(err) {
        if (isCancelled()) {
          callback(makeCancelledError());
          return;
        }
        callback(err, files);
      }
    );
  }
//};

var prepareSyncObject = function(remoteFiles, localFiles, options, callback) {
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

  var filesToUpdate = [];
  var filesToAdd = [];
  var dirsToAdd = [];
  var filesToRemove = [];
  var dirsToRemove = [];

  if (options.mode == "force")
    from.forEach(function(fromFile) {
      var toEquivalent = to.find(function(toFile) {
        return toFile.name == fromFile.name;
      });
      if (toEquivalent && !fromFile.isDir) filesToUpdate.push(fromFile.name);
      if (!toEquivalent) {
        if (fromFile.isDir) dirsToAdd.push(fromFile.name);
        else filesToAdd.push(fromFile.name);
      }
    });
  else
    from.forEach(function(fromFile) {
      var toEquivalent = to.find(function(toFile) {
        return toFile.name == fromFile.name;
      });
      if (!toEquivalent && !fromFile.isDir) filesToAdd.push(fromFile.name);
      if (!toEquivalent && fromFile.isDir) dirsToAdd.push(fromFile.name);
      if (toEquivalent) toEquivalent.wasOnFrom = true;
      if (toEquivalent && toEquivalent.size != fromFile.size && !fromFile.isDir)
        filesToUpdate.push(fromFile.name);
    });

  if (options.mode == "full")
    to.filter(function(toFile) {
      return !toFile.wasOnFrom;
    }).forEach(function(toFile) {
      if (toFile.isDir) dirsToRemove.push(toFile.name);
      else filesToRemove.push(toFile.name);
    });

  callback(null, {
    _readMe:
      "Review list of sync operations, then use Ftp-sync: Commit command to accept changes. Note that if you're not in your root directory then all the parent directories will also be uploaded",
    _warning: "This file should not be saved, reopened review file won't work!",
    filesToUpdate: filesToUpdate,
    filesToAdd: filesToAdd,
    dirsToAdd: dirsToAdd,
    filesToRemove: filesToRemove,
    dirsToRemove: dirsToRemove
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

  client.connect(ftpConfig);
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
  if (connected == false) {
    // If password and private key path are required but missing from the
    // config file, prompt the user for a password and then connect
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
          ftpConfig.password = password;
          ftp.connect(
            Object.assign({}, ftpConfig, {
              password: password
            })
          );
        });
    } else {
      // Otherwise just connect
      ftp.connect(ftpConfig);
    }

    ftp.onready(function() {
      connected = true;
      if (!ftpConfig.passive && ftpConfig.protocol != "sftp") callback();
      else if (ftpConfig.protocol == "sftp") ftp.goSftp(callback);
      else if (ftpConfig.passive) ftp.pasv(callback);
    });
    ftp.onerror(callback);
    ftp.onclose(function(err) {
      output(getCurrentTime() + " > [ftp-sync] connection closed");
      connected = false;
    });
  } else callback();
};

var prepareSync = function(options, callback) {
  connect(function(err) {
    if (err) callback(err);
    else
      listRemoteFiles(
        options.remotePath,
        function(err, remoteFiles) {
          if (err) callback(err);
          else
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
          var client = transferPool ? transferPool[rr++ % transferPool.length] : ftp;

          output(getCurrentTime() + " > [ftp-sync] syncLocal replace: " + remote);
          client.get(remote, local, function(e) {
            done(e);
          });
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
          var client = transferPool ? transferPool[rr++ % transferPool.length] : ftp;

          output(getCurrentTime() + " > [ftp-sync] syncRemote replace: " + local);
          client.put(local, remote, function(e) {
            done(e);
          });
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
        err => {
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
      var client = transferPool ? transferPool[0] : ftp;
      var putFile = function() {
        client.put(localPath, remotePath, function(e) {
          endTransferPool();
          callback(e);
        });
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
      var client = transferPool ? transferPool[0] : ftp;
      var getFile = function() {
        client.get(remotePath, localPath, function(e) {
          endTransferPool();
          callback(e);
        });
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
    try {
      if (ftp) ftp.end();
      endTransferPool();
    } catch (e) {
      // ignore
    }
  },
  resetCancel: function() {
    cancelled = false;
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
