var fs = require("fs");
var path = require("path");
var upath = require("upath");
var mkdirp = require("mkdirp");
var fswalk = require("fs-walk");
var _ = require("lodash");
var isIgnored = require("./is-ignored");
var output = require("./output");
var formatError = require("./connection-errors").formatConnectionError;
var transferKeepalive = require("./transfer-keepalive");
var syncCancel = require("./sync-cancel");
var ConnectionPool = require("./connection-pool").ConnectionPool;
var runWithConcurrency = require("./run-with-concurrency");

var pool;

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
  if (syncCancel.callbackIfCancelled(callback)) {
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

  pool.withClient(function(connErr, ftp, release) {
    if (connErr) {
      openListRemoteFilesRequests -= 1;
      callback(syncCancel.normalizeError(connErr, formatError));
      return;
    }

    transferKeepalive.ensure(ftp, ftpConfig, function() {
      ftp.list(remotePath, function(err, remoteFiles) {
        openListRemoteFilesRequests -= 1;

        if (err) {
          release();
          if (syncCancel.isRequested()) {
            callback(syncCancel.CANCELLED_MSG);
            return;
          }
          if (err.code == 450) callback(null, []);
          else callback(syncCancel.normalizeError(err, formatError));
          return;
        }

        if (syncCancel.callbackIfCancelled(callback)) {
          release();
          return;
        }

        var result = [];
        var subdirs = [];

        if (remoteFiles.length == 0) {
          release();
          callback(null, result);
          return;
        }

        remoteFiles.forEach(function(fileInfo) {
          if (
            isIgnored(
              path.join(remotePath, fileInfo.name),
              ftpConfig.allow,
              ftpConfig.ignore
            )
          )
            return;

          if (fileInfo.name == "." || fileInfo.name == "..") return;
          var remoteItemPath = upath.toUnix(
            path.join(remotePath, fileInfo.name)
          );
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
          release();
          callback(null, result);
        };

        if (subdirs.length == 0) {
          finish();
          return;
        }

        runWithConcurrency(
          subdirs.slice(),
          pool.getMaxConnections(),
          function(subdir, subCb) {
            var subPath = upath.toUnix(path.join(remotePath, subdir.name));
            listRemoteFiles(
              subPath,
              function(err, subResult) {
                if (err) {
                  subCb(err);
                  return;
                }
                if (syncCancel.callbackIfCancelled(callback)) {
                  subCb(syncCancel.CANCELLED_MSG);
                  return;
                }
                result = _.union(result, subResult);
                subCb();
              },
              originalRemotePath,
              options
            );
          },
          function(err) {
            if (err) {
              release();
              callback(syncCancel.normalizeError(err, formatError));
            } else {
              finish();
            }
          }
        );
      });
    });
  });
};
// list remote files, deep = 1
const listOneDeepRemoteFiles = function(remotePath, callback) {
  if (syncCancel.callbackIfCancelled(callback)) {
    return;
  }

  output(getCurrentTime() + " > [ftp-sync] listRemoteFiles: " + remotePath);
  remotePath = upath.toUnix(remotePath);
  pool.withClient(function(connErr, ftp, release) {
    if (connErr) {
      callback(syncCancel.normalizeError(connErr, formatError));
      return;
    }

    transferKeepalive.ensure(ftp, ftpConfig, function() {
      ftp.list(remotePath, function(err, remoteFiles) {
        release();

        if (err) {
          if (syncCancel.isRequested()) {
            callback(syncCancel.CANCELLED_MSG);
            return;
          }
          if (err.code == 450) callback(null, []);
          else callback(syncCancel.normalizeError(err, formatError));
          return;
        }

        if (syncCancel.callbackIfCancelled(callback)) {
          return;
        }

        let result = [];

        if (remoteFiles.length == 0) {
          callback(null, result);
          return;
        }

        remoteFiles.forEach(function(fileInfo) {
          if (
            isIgnored(
              path.join(remotePath, fileInfo.name),
              ftpConfig.allow,
              ftpConfig.ignore
            )
          )
            return;

          if (fileInfo.name == "." || fileInfo.name == "..") return;
          var remoteItemPath = upath.toUnix(
            path.join(remotePath, fileInfo.name)
          );
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
      });
    });
  });
};
// the entry of list request
const ListRemoteFilesByPath = function(remotePath, callback) {
  syncCancel.reset();
  connect(function(err) {
    if (err) {
      callback(syncCancel.normalizeError(err, formatError));
      return;
    }
    if (syncCancel.callbackIfCancelled(callback)) {
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
      pool.withClient(function(connErr, ftp, release) {
        if (connErr) {
          reject(connErr);
          return;
        }
        output(
          getCurrentTime() + " > [ftp-sync] deletRemoteFile: " + remoteFilePath
        );
        ftp.delete(remoteFilePath, function(delErr) {
          release();
          if (delErr) reject(delErr);
          else
            resolve({
              success: true,
              path: remoteFilePath
            });
        });
      });
    });
  });
};
//add options
var listLocalFiles = function(localPath, rootPath, callback, options) {
  if (syncCancel.callbackIfCancelled(callback)) {
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
        if (syncCancel.isRequested()) {
          return callback(syncCancel.CANCELLED_MSG, files);
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
        if (syncCancel.isRequested()) {
          callback(syncCancel.CANCELLED_MSG, files);
        } else {
          callback(err, files);
        }
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

var connect = function(callback) {
  output(getCurrentTime() + " > [sync-helper] connect");
  pool.ensureReady(function(err) {
    if (err) callback(typeof err === "string" ? err : formatError(err));
    else callback();
  });
};

var reportSyncProgress = function(sync) {
  if (onSyncProgress != null) {
    onSyncProgress(
      sync.startTotal - totalOperations(sync),
      sync.startTotal
    );
  }
};

var prepareSync = function(options, callback) {
  syncCancel.reset();
  connect(function(err) {
    if (err) callback(syncCancel.normalizeError(err, formatError));
    else if (syncCancel.callbackIfCancelled(callback)) {
    } else
      listRemoteFiles(
        options.remotePath,
        function(err, remoteFiles) {
          if (err) callback(syncCancel.normalizeError(err, formatError));
          else if (syncCancel.callbackIfCancelled(callback)) {
          } else
            listLocalFiles(
              options.localPath,
              options.rootPath,
              function(err, localFiles) {
                if (err) callback(syncCancel.normalizeError(err, formatError));
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
  if (syncCancel.callbackIfCancelled(callback)) {
    return;
  }

  reportSyncProgress(sync);

  if (sync.dirsToAdd.length > 0) {
    var dirToAdd = sync.dirsToAdd.pop();
    var localPath = path.join(options.localPath, dirToAdd);

    output(getCurrentTime() + " > [ftp-sync] syncLocal createDir: " + dirToAdd);

    mkdirp(localPath, function(err) {
      if (err) callback(err);
      else executeSyncLocal(sync, options, callback);
    });
    return;
  }

  var fileTransfers = sync.filesToAdd
    .concat(sync.filesToUpdate)
    .map(function(name) {
      return { name: name };
    });

  if (fileTransfers.length > 0) {
    runWithConcurrency(
      fileTransfers,
      pool.getMaxConnections(),
      function(item, done) {
        var local = path.join(options.localPath, item.name);
        var remote = upath.toUnix(
          path.join(options.remotePath, item.name)
        );

        output(
          getCurrentTime() + " > [ftp-sync] syncLocal replace: " + remote
        );

        pool.withClient(function(connErr, ftp, release) {
          if (connErr) {
            done(connErr);
            return;
          }
          ftp.get(remote, local, function(err) {
            release();
            if (!err) transferKeepalive.markActivity();
            _.pull(sync.filesToAdd, item.name);
            _.pull(sync.filesToUpdate, item.name);
            reportSyncProgress(sync);
            done(err);
          });
        });
      },
      function(err) {
        if (err) callback(err);
        else executeSyncLocal(sync, options, callback);
      }
    );
    return;
  }

  if (sync.filesToRemove.length > 0) {
    var filesToRemove = sync.filesToRemove.slice();
    runWithConcurrency(
      filesToRemove,
      pool.getMaxConnections(),
      function(fileToRemove, done) {
        var localPath = path.join(options.localPath, fileToRemove);

        output(
          getCurrentTime() +
            " > [ftp-sync] syncLocal removeFile: " +
            fileToRemove
        );

        fs.unlink(localPath, function(err) {
          _.pull(sync.filesToRemove, fileToRemove);
          reportSyncProgress(sync);
          done(err);
        });
      },
      function(err) {
        if (err) callback(err);
        else executeSyncLocal(sync, options, callback);
      }
    );
    return;
  }

  if (sync.dirsToRemove.length > 0) {
    var dirToRemove = sync.dirsToRemove.pop();
    var localPath = path.join(options.localPath, dirToRemove);

    output(
      getCurrentTime() + " > [ftp-sync] syncLocal removeDir: " + dirToRemove
    );

    fs.rmdir(localPath, function(err) {
      if (err) callback(err);
      else executeSyncLocal(sync, options, callback);
    });
    return;
  }

  callback();
};

var executeSyncRemote = function(sync, options, callback) {
  if (syncCancel.callbackIfCancelled(callback)) {
    return;
  }

  reportSyncProgress(sync);

  if (sync.dirsToAdd.length > 0) {
    var dirToAdd = sync.dirsToAdd.shift();
    var remotePath = upath.toUnix(path.join(options.remotePath, dirToAdd));

    output(
      getCurrentTime() + " > [ftp-sync] syncRemote createDir: " + dirToAdd
    );

    pool.withClient(function(connErr, ftp, release) {
      if (connErr) {
        callback(connErr);
        return;
      }
      transferKeepalive.ensure(ftp, ftpConfig, function() {
        ftp.mkdir(
          remotePath,
          function(err) {
            release();
            if (err) callback(err);
            else executeSyncRemote(sync, options, callback);
          },
          true
        );
      });
    });
    return;
  }

  var fileTransfers = sync.filesToAdd
    .concat(sync.filesToUpdate)
    .map(function(name) {
      return { name: name };
    });

  if (fileTransfers.length > 0) {
    runWithConcurrency(
      fileTransfers,
      pool.getMaxConnections(),
      function(item, done) {
        var local = path.join(options.localPath, item.name);
        var remote = upath.toUnix(
          path.join(options.remotePath, item.name)
        );

        output(
          getCurrentTime() + " > [ftp-sync] syncRemote replace: " + local
        );

        pool.withClient(function(connErr, ftp, release) {
          if (connErr) {
            done(connErr);
            return;
          }
          ftp.put(local, remote, function(err) {
            release();
            if (!err) transferKeepalive.markActivity();
            _.pull(sync.filesToAdd, item.name);
            _.pull(sync.filesToUpdate, item.name);
            reportSyncProgress(sync);
            done(err);
          });
        });
      },
      function(err) {
        if (err) callback(err);
        else executeSyncRemote(sync, options, callback);
      }
    );
    return;
  }

  if (sync.filesToRemove.length > 0) {
    var filesToRemove = sync.filesToRemove.slice();
    runWithConcurrency(
      filesToRemove,
      pool.getMaxConnections(),
      function(fileToRemove, done) {
        var remotePath = upath.toUnix(
          path.join(options.remotePath, fileToRemove)
        );

        output(
          getCurrentTime() +
            " > [ftp-sync] syncRemote removeFile: " +
            fileToRemove
        );

        pool.withClient(function(connErr, ftp, release) {
          if (connErr) {
            done(connErr);
            return;
          }
          ftp.delete(remotePath, function(err) {
            release();
            _.pull(sync.filesToRemove, fileToRemove);
            reportSyncProgress(sync);
            done(err);
          });
        });
      },
      function(err) {
        if (err) callback(err);
        else executeSyncRemote(sync, options, callback);
      }
    );
    return;
  }

  if (sync.dirsToRemove.length > 0) {
    var dirToRemove = sync.dirsToRemove.pop();
    var remotePath = upath.toUnix(path.join(options.remotePath, dirToRemove));

    output(
      getCurrentTime() + " > [ftp-sync] syncRemote removeDir: " + dirToRemove
    );

    pool.withClient(function(connErr, ftp, release) {
      if (connErr) {
        callback(connErr);
        return;
      }
      ftp.rmdir(remotePath, function(err) {
        release();
        if (err) callback(err);
        else executeSyncRemote(sync, options, callback);
      });
    });
    return;
  }

  callback();
};

var ensureDirExists = function(ftp, remoteDir, callback) {
  transferKeepalive.ensure(ftp, ftpConfig, function() {
    ftp.list(path.posix.join(remoteDir, ".."), function(err, list) {
      if (err) {
        ensureDirExists(ftp, path.posix.join(remoteDir, ".."), function() {
          ensureDirExists(ftp, remoteDir, callback);
        });
      } else if (
        _.some(list, function(f) {
          return f.name == path.basename(remoteDir);
        })
      ) {
        callback();
      } else {
        ftp.mkdir(
          remoteDir,
          function(mkErr) {
            if (mkErr) callback(mkErr);
            else callback();
          },
          true
        );
      }
    });
  });
};

var uploadFile = function(localPath, rootPath, callback) {
  syncCancel.reset();
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
    if (syncCancel.callbackIfCancelled(callback)) {
      return;
    }
    if (err) {
      callback(syncCancel.normalizeError(err, formatError));
      return;
    }
    pool.withClient(function(connErr, ftp, release) {
      if (connErr) {
        callback(syncCancel.normalizeError(connErr, formatError));
        return;
      }
      var putFile = function() {
        if (syncCancel.callbackIfCancelled(callback)) {
          release();
          return;
        }
        ftp.put(localPath, remotePath, function(putErr) {
          release();
          if (!putErr) transferKeepalive.markActivity();
          callback(syncCancel.normalizeError(putErr, formatError));
        });
      };
      if (remoteDir != ".")
        ensureDirExists(ftp, remoteDir, function(dirErr) {
          if (dirErr) {
            release();
            callback(syncCancel.normalizeError(dirErr, formatError));
          } else putFile();
        });
      else putFile();
    });
  });
};

var downloadFile = function(localPath, rootPath, callback) {
  syncCancel.reset();
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
    if (syncCancel.callbackIfCancelled(callback)) {
      return;
    }
    if (err) {
      callback(syncCancel.normalizeError(err, formatError));
      return;
    }
    pool.withClient(function(connErr, ftp, release) {
      if (connErr) {
        callback(syncCancel.normalizeError(connErr, formatError));
        return;
      }
      var getFile = function() {
        if (syncCancel.callbackIfCancelled(callback)) {
          release();
          return;
        }
        ftp.get(remotePath, localPath, function(getErr) {
          release();
          if (!getErr) transferKeepalive.markActivity();
          callback(syncCancel.normalizeError(getErr, formatError));
        });
      };
      if (remoteDir != ".")
        ensureDirExists(ftp, remoteDir, function(dirErr) {
          if (dirErr) {
            release();
            callback(syncCancel.normalizeError(dirErr, formatError));
          } else getFile();
        });
      else getFile();
    });
  });
};

var executeSync = function(sync, options, callback) {
  syncCancel.reset();
  output(getCurrentTime() + " > [ftp-sync] sync starting");
  sync.startTotal = totalOperations(sync);
  connect(function(err) {
    if (err) callback(syncCancel.normalizeError(err, formatError));
    else if (syncCancel.callbackIfCancelled(callback)) {
    } else if (options.upload) {
      executeSyncRemote(sync, options, callback);
    } else {
      executeSyncLocal(sync, options, callback);
    }
  });
};

var ftpConfig;
var helper = {
  useConfig: function(config) {
    var recreate =
      !pool ||
      !ftpConfig ||
      ftpConfig.protocol != config.protocol ||
      ftpConfig.maxConnections != config.maxConnections;
    if (recreate) {
      if (pool) pool.disconnect();
      pool = new ConnectionPool(config);
    } else {
      pool.updateConfig(config);
    }
    ftpConfig = config;
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
  cancel: function() {
    syncCancel.request();
    openListRemoteFilesRequests = 0;
    output(getCurrentTime() + " > [ftp-sync] cancel requested");
    if (pool) pool.cancel();
  },
  isCancelledError: syncCancel.isCancelledError,
  disconnect: function() {
    if (pool) pool.disconnect();
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
