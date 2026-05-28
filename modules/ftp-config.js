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
  defaultConfig: {
    remotePath: "./",
    host: "host",
    username: "username",
    password: "password",
    port: 21,
    secure: false,
    protocol: "ftp",
    maxConnections: 2,
    uploadOnSave: false,
    passive: true,
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
  getConfig: function() {
    var configjson = fs.readFileSync(this.getConfigPath()).toString();
    var configObject;

    try {
      configObject = JSON.parse(configjson);
    } catch (err) {
      vscode.window.showErrorMessage(
        "Ftp-sync: Config file is not a valid JSON document. - " + err.message
      );
    }
    return _.defaults(configObject, this.defaultConfig);
  },
  validateConfig: function() {
    if (!fs.existsSync(this.getConfigPath())) {
      var options = [
        "Create ftp-sync config now...",
        "Nah, forget about it..."
      ];
      var pick = vscode.window.showQuickPick(options, {
        placeHolder: "No configuration file found. Run Init command first."
      });
      pick.then(function(answer) {
        if (answer == options[0]) require("./init-command")();
      });
      return false;
    }

    return true;
  },
  getSyncConfig: function() {
    let config = this.getConfig();
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
      maxConnections: config.maxConnections,
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
      rootPath: this.rootPath
    };
  },
  connectionChanged: function(oldConfig) {
    var config = this.getSyncConfig();
    return (
      config.host != oldConfig.host ||
      config.port != oldConfig.port ||
      config.user != oldConfig.user ||
      config.password != oldConfig.password
    );
  }
};
