var vscode = require("vscode");
var FtpWrapper = require("./ftp-wrapper");
var SftpWrapper = require("./sftp-wrapper");
var ScpWrapper = require("./scp-wrapper");
var output = require("./output");
var formatError = require("./connection-errors").formatConnectionError;

function createClient(protocol) {
  protocol = (protocol || "ftp").toLowerCase();
  if (protocol === "sftp") return new SftpWrapper();
  if (protocol === "scp") return new ScpWrapper();
  return new FtpWrapper();
}

function needsPasswordPrompt(ftpConfig) {
  if (
    (ftpConfig.protocol === "sftp" || ftpConfig.protocol === "scp") &&
    !ftpConfig.password &&
    !ftpConfig.privateKeyPath
  ) {
    return true;
  }
  return !ftpConfig.password;
}

function ConnectionPool(ftpConfig) {
  this.ftpConfig = ftpConfig;
  this.maxConnections = ftpConfig.maxConnections || 1;
  this.slots = [];
  this.waitQueue = [];
  this.resolvedConfig = null;
  this.passwordResolved = false;
  this.connecting = false;
  this.readyPromise = null;
}

ConnectionPool.prototype.getMaxConnections = function() {
  return this.maxConnections;
};

ConnectionPool.prototype.updateConfig = function(ftpConfig) {
  this.ftpConfig = ftpConfig;
  this.maxConnections = ftpConfig.maxConnections || 1;
};

ConnectionPool.prototype._resolveConfig = function(callback) {
  var self = this;
  if (self.resolvedConfig && self.passwordResolved) {
    return callback(null, self.resolvedConfig);
  }
  if (needsPasswordPrompt(self.ftpConfig)) {
    vscode.window
      .showInputBox({
        prompt: '[ftp-sync] Password for "' + self.ftpConfig.host + '"',
        password: true
      })
      .then(function(password) {
        if (password === undefined) {
          callback("Senha não informada.");
          return;
        }
        self.resolvedConfig = Object.assign({}, self.ftpConfig, {
          password: password
        });
        self.passwordResolved = true;
        callback(null, self.resolvedConfig);
      });
  } else {
    self.resolvedConfig = self.ftpConfig;
    self.passwordResolved = true;
    callback(null, self.resolvedConfig);
  }
};

ConnectionPool.prototype._connectClient = function(client, config, callback) {
  var finished = false;
  var done = function(err) {
    if (finished) return;
    finished = true;
    callback(err);
  };

  client.onerror(function(err) {
    done(formatError(err));
  });

  client.onclose(function() {
    output("[ftp-sync] connection closed");
  });

  client.connect(config);

  client.onready(function() {
    if (!config.passive && config.protocol !== "sftp" && config.protocol !== "scp") {
      done();
    } else if (config.protocol === "sftp" || config.protocol === "scp") {
      client.goSftp(done);
    } else if (config.passive) {
      client.pasv(done);
    } else {
      done();
    }
  });
};

ConnectionPool.prototype._trimSlots = function() {
  while (this.slots.length > this.maxConnections) {
    var slot = this.slots.pop();
    if (slot && slot.client && slot.client.end) {
      try {
        slot.client.end();
      } catch (e) {}
    }
  }
};

ConnectionPool.prototype.ensureReady = function(callback) {
  var self = this;
  self._trimSlots();

  if (
    self.slots.length === self.maxConnections &&
    self.slots.every(function(s) {
      return s.ready;
    })
  ) {
    return callback();
  }

  if (self.connecting && self.readyPromise) {
    return self.readyPromise.then(
      function() {
        callback();
      },
      function(err) {
        callback(err);
      }
    );
  }

  self.connecting = true;
  self.readyPromise = new Promise(function(resolve, reject) {
    self._resolveConfig(function(err, config) {
      if (err) {
        self.connecting = false;
        self.readyPromise = null;
        reject(err);
        return;
      }

      var toCreate = self.maxConnections - self.slots.length;
      if (toCreate <= 0) {
        self.connecting = false;
        resolve();
        return;
      }

      var pending = toCreate;
      var connectErr = null;

      for (var i = 0; i < toCreate; i++) {
        (function() {
          var client = createClient(config.protocol);
          var slot = { client: client, ready: false, busy: false };
          self.slots.push(slot);

          self._connectClient(client, config, function(err) {
            if (connectErr) return;
            if (err) {
              connectErr = err;
            } else {
              slot.ready = true;
            }
            pending -= 1;
            if (pending === 0) {
              self.connecting = false;
              if (connectErr) {
                self.readyPromise = null;
                reject(connectErr);
              } else {
                resolve();
              }
            }
          });
        })();
      }
    });
  });

  self.readyPromise.then(
    function() {
      callback();
    },
    function(err) {
      callback(err);
    }
  );
};

ConnectionPool.prototype._drainQueue = function() {
  if (this.waitQueue.length === 0) return;

  var slot = null;
  for (var i = 0; i < this.slots.length; i++) {
    if (this.slots[i].ready && !this.slots[i].busy) {
      slot = this.slots[i];
      break;
    }
  }
  if (!slot) return;

  var entry = this.waitQueue.shift();
  slot.busy = true;
  entry(null, slot.client, this._release.bind(this, slot));
};

ConnectionPool.prototype._release = function(slot) {
  slot.busy = false;
  this._drainQueue();
};

ConnectionPool.prototype.withClient = function(callback) {
  var self = this;
  self.ensureReady(function(err) {
    if (err) {
      callback(err);
      return;
    }

    var slot = null;
    for (var i = 0; i < self.slots.length; i++) {
      if (self.slots[i].ready && !self.slots[i].busy) {
        slot = self.slots[i];
        break;
      }
    }

    if (slot) {
      slot.busy = true;
      callback(null, slot.client, self._release.bind(self, slot));
      return;
    }

    self.waitQueue.push(callback);
  });
};

ConnectionPool.prototype.getPrimary = function(callback) {
  this.withClient(callback);
};

ConnectionPool.prototype.disconnect = function() {
  this.waitQueue = [];
  this.connecting = false;
  this.readyPromise = null;
  this.resolvedConfig = null;
  this.passwordResolved = false;

  this.slots.forEach(function(slot) {
    if (slot.client && slot.client.end) {
      try {
        slot.client.end();
      } catch (e) {}
    }
  });
  this.slots = [];
};

ConnectionPool.prototype.cancel = function() {
  this.waitQueue = [];
  this.connecting = false;
  this.readyPromise = null;

  this.slots.forEach(function(slot) {
    try {
      if (slot.client && slot.client.abort) {
        slot.client.abort(true, function() {});
      }
    } catch (e) {}
    try {
      if (slot.client && slot.client.end) {
        slot.client.end();
      }
    } catch (e) {}
  });
  this.slots = [];
  this.resolvedConfig = null;
  this.passwordResolved = false;
};

module.exports = {
  ConnectionPool: ConnectionPool,
  createClient: createClient
};
