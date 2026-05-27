var fs = require("fs");
var vscode = require("vscode");
var path = require("path");
var _ = require("lodash");
var upath = require("upath");

module.exports = {
  rootPath: function() {
    return vscode.workspace.workspaceFolders[0].uri;
  },
  getConfigPath: function() {
    return this.getConfigDir() + "/ftp-sync.json";
  },
  getConfigDir: function() {
    return this.rootPath().fsPath + "/.vscode";
  },
  isUploadOnSaveEnabled: function(config) {
    config = config || this.getConfig();
    var value = config.uploadOnSave;
    if (value === false || value === 0 || value === null) return false;
    if (typeof value === "string") {
      return value.trim().toLowerCase() === "true";
    }
    return !!value;
  },
  isGeneratedFilesWatchEnabled: function(config) {
    config = config || this.getConfig();
    var gen = config.generatedFiles;
    if (!gen || !gen.extensionsToInclude || gen.extensionsToInclude.length === 0) {
      return false;
    }
    var watchPath = gen.path;
    return (
      watchPath !== undefined &&
      watchPath !== null &&
      String(watchPath).length > 0
    );
  },
  getGeneratedDir: function(config) {
    var fullConfig = config;
    if (!fullConfig || !fullConfig.generatedFiles) {
      fullConfig =
        this && this.generatedFiles ? this : module.exports.getConfig();
    }
    return upath.join(
      module.exports.rootPath().fsPath,
      fullConfig.generatedFiles.path
    );
  },
  getTransferKeepaliveInterval: function(config) {
    config = config || this.getConfig();
    if (!config) {
      return 30000;
    }
    var value = config.transferKeepaliveInterval;
    if (value === 0 || value === false) {
      return 0;
    }
    if (value === undefined || value === null || value === "") {
      return 30000;
    }
    var ms = Number(value);
    if (isNaN(ms) || ms < 0) {
      return 30000;
    }
    return ms;
  },
  getMaxConnections: function(config) {
    config = config || this.getConfig();
    if (!config) {
      return 1;
    }
    var value = config.maxConnections;
    if (value === undefined || value === null || value === "") {
      return 1;
    }
    var n = parseInt(value, 10);
    if (isNaN(n) || n < 1) {
      return 1;
    }
    return n;
  },
  getTimeoutMs: function(config) {
    config = config || this.getConfig();
    var value = config.timeout;
    if (value === undefined || value === null || value === "") {
      return 120000;
    }
    var ms = Number(value);
    if (isNaN(ms) || ms < 0) {
      return 120000;
    }
    return ms;
  },
  getConnectionTimeouts: function(config) {
    var ms = this.getTimeoutMs(config);
    return {
      timeout: ms,
      connTimeout: ms,
      pasvTimeout: ms,
      keepalive: ms,
      readyTimeout: ms
    };
  },
  defaultConfig: {
    remotePath: "./",
    host: "host",
    username: "username",
    password: "password",
    port: 21,
    secure: false,
    protocol: "ftp",
    uploadOnSave: false,
    passive: false,
    timeout: 120000,
    transferKeepaliveInterval: 30000,
    maxConnections: 1,
    debug: false,
    privateKeyPath: null,
    passphrase: null,
    agent: null,
    allow: [],
    ignore: ["\\.vscode", "\\.git", "\\.DS_Store"],
    generatedFiles: {
      extensionsToInclude: [],
      path: ""
    }
  },
  configExists: function() {
    return fs.existsSync(this.getConfigPath());
  },
  getConfig: function() {
    if (!this.configExists()) {
      return null;
    }
    var configjson = fs.readFileSync(this.getConfigPath()).toString();
    var configObject;

    try {
      configObject = JSON.parse(configjson);
    } catch (err) {
      vscode.window.showErrorMessage(
        "Ftp-sync: Config file is not a valid JSON document. - " + err.message
      );
      return null;
    }
    return _.defaults(configObject, this.defaultConfig);
  },
  getConfigValidationErrors: function(config) {
    var errors = [];
    var defaults = this.defaultConfig;

    if (!config) {
      errors.push("Arquivo de configuração ausente ou JSON inválido.");
      return errors;
    }

    if (!config.host || String(config.host).trim() === "") {
      errors.push('Campo obrigatório "host" não está definido.');
    } else if (config.host === defaults.host) {
      errors.push(
        '"host" ainda está com o valor de exemplo. Edite .vscode/ftp-sync.json.'
      );
    }

    if (!config.username || String(config.username).trim() === "") {
      errors.push('Campo obrigatório "username" não está definido.');
    } else if (config.username === defaults.username) {
      errors.push(
        '"username" ainda está com o valor de exemplo. Edite .vscode/ftp-sync.json.'
      );
    }

    var port = Number(config.port);
    if (config.port === "" || config.port === null || config.port === undefined) {
      errors.push('Campo obrigatório "port" não está definido.');
    } else if (isNaN(port) || port < 1 || port > 65535) {
      errors.push('"port" deve ser um número entre 1 e 65535.');
    }

    var protocol = (config.protocol || "ftp").toLowerCase();
    if (["ftp", "sftp", "scp"].indexOf(protocol) < 0) {
      errors.push('"protocol" deve ser "ftp", "sftp" ou "scp".');
    }

    if (
      config.maxConnections !== undefined &&
      config.maxConnections !== null &&
      config.maxConnections !== ""
    ) {
      var maxConn = parseInt(config.maxConnections, 10);
      if (isNaN(maxConn) || maxConn < 1) {
        errors.push('"maxConnections" deve ser um inteiro maior ou igual a 1.');
      }
    }

    if (
      (protocol === "sftp" || protocol === "scp") &&
      config.privateKeyPath &&
      !fs.existsSync(config.privateKeyPath)
    ) {
      errors.push(
        'Arquivo de chave privada não encontrado: "' + config.privateKeyPath + '"'
      );
    }

    return errors;
  },
  getRelativePathFromResource: function(fileUrl) {
    if (!fileUrl || !fileUrl.fsPath) {
      return null;
    }
    if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) {
      return null;
    }
    var rel = path.relative(this.rootPath().fsPath, fileUrl.fsPath);
    if (!rel || rel.indexOf("..") === 0 || path.isAbsolute(rel)) {
      return null;
    }
    return rel.split(path.sep).join("/") || ".";
  },
  validateConfig: function(options) {
    options = options || {};

    if (!this.configExists()) {
      if (options.silent) {
        return false;
      }
      var initOptions = [
        "Create ftp-sync config now...",
        "Nah, forget about it..."
      ];
      var pick = vscode.window.showQuickPick(initOptions, {
        placeHolder: "No configuration file found. Run Init command first."
      });
      pick.then(function(answer) {
        if (answer == initOptions[0]) require("./init-command")();
      });
      return false;
    }

    var errors = this.getConfigValidationErrors(this.getConfig());
    if (errors.length === 0) {
      return true;
    }

    if (!options.silent) {
      vscode.window.showErrorMessage(
        "Ftp-sync: configuração inválida — " + errors.join(" ")
      );
    }
    return false;
  },
  getSyncConfig: function() {
    let config = this.getConfig();
    if (!config) {
      return null;
    }
    var timeouts = this.getConnectionTimeouts(config);
    return {
      getGeneratedDir: this.getGeneratedDir,
      local: config.localPath,
      root: config.rootPath,
      remote: upath.toUnix(config.remotePath),
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      passphrase: config.passphrase,
      allow: config.allow,
      ignore: config.ignore,
      passive: config.passive,
      secure: config.secure,
      secureOptions: config.secureOptions,
      protocol: config.protocol || "ftp",
      privateKeyPath: config.privateKeyPath,
      passphrase: config.passphrase,
      agent: config.agent,
      generatedFiles: config.generatedFiles,
      debug: config.debug,
      timeout: timeouts.timeout,
      connTimeout: timeouts.connTimeout,
      pasvTimeout: timeouts.pasvTimeout,
      keepalive: timeouts.keepalive,
      readyTimeout: timeouts.readyTimeout,
      transferKeepaliveInterval: this.getTransferKeepaliveInterval(config),
      maxConnections: this.getMaxConnections(config),
      rootPath: this.rootPath
    };
  },
  connectionChanged: function(oldConfig) {
    var config = this.getSyncConfig();
    if (!oldConfig || !config) {
      return true;
    }
    return (
      config.host != oldConfig.host ||
      config.port != oldConfig.port ||
      config.user != oldConfig.user ||
      config.password != oldConfig.password ||
      config.timeout != oldConfig.timeout ||
      config.maxConnections != oldConfig.maxConnections ||
      config.protocol != oldConfig.protocol
    );
  }
};
