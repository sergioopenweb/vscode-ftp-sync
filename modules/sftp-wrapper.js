module.exports = function() {
    var self = this;
    
    var Mode = require('stat-mode');
    var path = require('path');
    var Client = require('ssh2').Client;
    var client = new Client();
    var sftp;
    
    self.connect = function(ftpConfig) {
        
        try {
            var privateKey = ftpConfig.privateKeyPath ? require('fs').readFileSync(ftpConfig.privateKeyPath) : undefined;
        }
        catch(err) {
            process.nextTick(function() { onErrorHandler(err); });
            return;
        }
        
        client.connect({
            host: ftpConfig.host,
            port: ftpConfig.port,
            username: ftpConfig.user,
            password: ftpConfig.password,
            privateKey: privateKey,
            passphrase: ftpConfig.passphrase,
            agent: ftpConfig.agent,
            readyTimeout: ftpConfig.connTimeout || 10000,
            keepaliveInterval: ftpConfig.keepalive || 10000
        });
    }
    
    self.onready = function(callback) {
        client.once('ready', callback);
    }  
    
    var onErrorHandler;
    self.onerror = function(callback) {
        onErrorHandler = callback;
        client.once('error', callback);
    }
    
    self.pasv = function(callback) {
        callback();
    }
    
    self.goSftp = function(callback) {
        client.sftp(function(err, sftpClient) {
            if(!err) sftp = sftpClient;
            callback(err);
        })
    }
    
    self.end = function() {
        client.end();
    }
    
    self.onclose = function(callback) {
        client.once('close', callback);
    }
    
    self.list = function(remote, callback) {
        sftp.readdir(remote, function(err, result) {
            if(!err) result = result.map(f => {
                return { 
                    name: f.filename,
                    type: new Mode(f.attrs).isDirectory() ? "d" : "f", //TODO: determine if it's a file or not
                    size: f.attrs.size
                }
            });
            callback(err, result);
        });
    }
    
    self.get = function(remote, local, callback) {
        sftp.fastGet(remote, local, callback);
    }
    
    self.put = function(local, remote, callback) {
        sftp.fastPut(local, remote, callback)
    }
    
    self.mkdir = function(remote, callback, recursive) {
        if (!recursive) {
            sftp.mkdir(remote, callback);
            return;
        }

        // mkdir -p: descobre os ancestrais que faltam e cria de cima para baixo.
        // Tolera diretorios ja criados (por outra conexao do pool em paralelo).
        var missing = [];
        var walk = function(dir) {
            sftp.stat(dir, function(err) {
                if (!err) {
                    createAll();
                    return;
                }
                missing.push(dir);
                var parent = path.posix.dirname(dir);
                if (!parent || parent === dir || parent === "." || parent === "/") {
                    createAll();
                } else {
                    walk(parent);
                }
            });
        };
        var createAll = function() {
            missing.reverse();
            var i = 0;
            var next = function() {
                if (i >= missing.length) {
                    callback();
                    return;
                }
                var dir = missing[i++];
                sftp.mkdir(dir, function(err) {
                    if (!err) {
                        next();
                        return;
                    }
                    // pode ter sido criado em paralelo: confirma via stat
                    sftp.stat(dir, function(statErr) {
                        if (!statErr) next();
                        else callback(err);
                    });
                });
            };
            next();
        };
        walk(path.posix.normalize(remote));
    }
    
    self.delete = function(remote, callback) {
        sftp.unlink(remote, callback)
    }
    
    self.rmdir = function(remote, callback) {    
        sftp.rmdir(remote, callback)
    }
   
}