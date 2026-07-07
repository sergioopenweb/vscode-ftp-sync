# FTP-Sync extension for VS Code

Fork mantido por [sergioopenweb](https://github.com/sergioopenweb/vscode-ftp-sync), baseado no projeto original [lukasz-wronski/vscode-ftp-sync](https://github.com/lukasz-wronski/vscode-ftp-sync).

This extension allows you to easily synchronise your local workspace (project files) with a remote **FTP**, **SFTP** or **SCP** server. It also has several advanced features such as **automatic upload on save**, **parallel connections** and **automatic retry/reconnect** on dropped connections.

![Demo of extension](https://i.imgur.com/W9h4pwW.gif)

## Usage

The main commands are available from the command palette (Ctrl+Shift+P on Windows/Linux):

- **Ftp-sync: Init** — create the config file.
- **Ftp-sync: Local to Remote** — upload sync wizard.
- **Ftp-sync: Remote to Local** — download sync wizard.
- **Ftp-sync: Commit** — apply a reviewed sync operation list.
- **Ftp-sync: Sync current file to Remote** — upload the active file.

You can also right-click a file in the Explorer to **Upload File**, **Download File** or **Browse Remote...**.

### Ftp-sync: Init

Initializes a default FTP-Sync configuration file in the `.vscode` directory. Options can be customised as follows:

- remotePath - This can be set to the path on the remote that you would like to upload to. The default is `./` i.e. the root.
- host - The hostname of the server you want to connect to.
- username - The username of the account you want to use.
- password - The password of the account you want to use. For `sftp`/`scp` you can leave it `null` and use `privateKeyPath`/`agent` instead. If omitted, you will be prompted for it.
- port - The port to connect to. The default is `21` for `ftp`. For `sftp`/`scp` (over SSH) use `22`.
- protocol - The protocol to be used. One of `"ftp"` (default), `"sftp"` or `"scp"` (the last two go over SSH).
- secure - Use FTPS (FTP over TLS). Only applies to `ftp`. The default is `false`.
- uploadOnSave - Whether files should automatically be uploaded on save. The default is `false`.
- passive - Specifies whether to use FTP passive mode. The default is `true` (recommended for most hosts behind NAT/firewalls). Ignored by `sftp`/`scp`.
- debug - Specifies whether to display debug information in an ftp-sync Output window. The default is `false`.
- privateKeyPath - Specifies the path to the private key for `sftp`/`scp`. The default is `null`.
- passphrase - Specifies the passphrase to use with the private key. The default is `null`.
- agent - Specifies the ssh-agent socket to use for `sftp`/`scp` (e.g. `process.env.SSH_AUTH_SOCK`). The default is `null`.
- allow - An array of escaped regular expression strings specifying paths which are allowed. If nonempty, unless a path matches any of these regular expressions it will not be included in the sync. Default value is empty, implying everything is allowed.
- ignore - An array of escaped regular expression strings specifying paths to ignore. If a path matches any of these regular expressions then it will not be included in the sync. Default values are `"\\.git"`, `"\\.vscode"` and `".DS_Store"`.

#### Connection & reliability options

- maxConnections - Number of parallel connections used for transfers and remote directory creation. The default is `2` (clamped to 1–20). Higher values speed up syncs with many files/folders, but some servers limit concurrent connections.
- retryCount - How many times a failed transfer/operation is retried before giving up. The default is `3` (clamped to 0–10).
- retryDelayMs - Delay in milliseconds between retries. The default is `2000`.
- keepalive - Keepalive interval in milliseconds to hold idle connections open. The default is `10000`.
- connTimeout - Connection timeout in milliseconds. The default is `10000`.
- pasvTimeout - Passive-mode data connection timeout in milliseconds (FTP). The default is `10000`.
- noTransferReconnectMs - If a pooled connection stays idle (no transfer) for this many milliseconds, it is reconnected before the next transfer to avoid stale sockets being dropped by the server. The default is `45000` (clamped to 10000–300000).
- generatedFiles: - Automatically upload freshly generated files. Also uploads files that are deleted. extensionsToInclude has to be set for this feature to work.
  - extensionsToInclude: [] e.g. [".js", ".css"] - Array of strings specifying what extensions to add for auto-upload. An empty array here means that generatedFiles feature is disabled. Setting it to [""] will cause it to upload files of all extensions.
  - path: "" - Directory to watch for generated output (e.g. `"dist"` or `"build"`). Must be non-empty for this feature to run; an empty path disables the watcher.

### Ftp-sync: Sync Local to Remote

Displays a synchronization wizard to configure a sync operation that changes FTP files and folders to match project files.

### Ftp-sync: Sync Remote to Local

Displays a synchronization wizard to configure a sync operation that changes project files and folders to match FTP files.

### Ftp-sync: Commit

Commits reviewed list of changes made with Sync Local to Remote or Sync Remote to Local command.

---

## To be added soon:

- Config validation (add minimal configuration requirement)
- More real life testing
- Bug fixes
- Context menu to sync folders (up/down)

## Future plans

- Integration with git-ftp

## Desenvolvimento e testes

1. `npm install`
2. Abra esta pasta no VS Code/Cursor e pressione **F5** (*Launch Extension*) — abre uma janela com a extensão carregada.
3. Na janela nova, abra um projeto e use **Ftp-sync: Init** para criar `.vscode/ftp-sync.json`.

### Empacotar e instalar (.vsix)

O `package.json` já traz os scripts:

- `npm run package` → gera o pacote `ftp-sync-<versão>.vsix` na raiz do projeto (usa `vsce package --dependencies`).
- `npm run install-ext` → instala o `.vsix` gerado via CLI do VS Code (`code --install-extension ftp-sync-*.vsix`).

Você também pode instalar manualmente com *Extensions: Install from VSIX...*. Depois de instalar/atualizar, rode **Developer: Reload Window** para carregar a nova versão.

> Observação: o `vsce package --dependencies` só termina quando imprime `DONE Packaged: ...`. O `.vsix` fica incompleto/inválido até essa linha aparecer — aguarde antes de instalar.

## Version history (fork)

- 0.5.14
  - Criação de diretórios remotos agora usa o pool de conexões em paralelo (antes era sequencial numa única conexão)
  - Aborta operações em andamento imediatamente quando a conexão cai, em vez de esperar o timeout de transferência (~2min) — o sync não trava mais em `connection closed`
  - Tolera "diretório já existe" durante criação paralela (corrida entre conexões do pool)
  - `ensureTransferPool` protegido contra builds concorrentes
  - `mkdir` do SFTP agora é recursivo (`mkdir -p`) e tolera diretórios já criados
- 0.5.12
  - Reconexão do pool FTP após `connection closed` durante o sync
- 0.5.11
  - Fila de conexão, timeout e cancelamento no `prepareSync`
- 0.5.10
  - Correção de travamento no `prepareSync` e retry em transferências
- 0.5.9
  - Retry e reconexão para o timeout "no-transfer" do FTP
- 0.5.7
  - Default de `maxConnections` reduzido de 4 para 2
- 0.5.6
  - Default `passive` alterado para `true` (modo passivo recomendado para FTP na internet)
- 0.5.0
  - VS Code 1.85+, Node 18+, dependências atualizadas
  - Correção: `uploadOnSave: false` era ignorado quando `generatedFiles` vigiava o projeto inteiro
  - Watcher de `generatedFiles` só ativa com `path` definido

### Found any bugs? Got any questions or ideas?

- Abra uma issue [no repositório do fork](https://github.com/sergioopenweb/vscode-ftp-sync/issues)

Please provide as much information as possible. We are dealing with diffrent ftp servers, file structures, file permissions, operating systems and it might be difficult to reproduce your error and fix it without detailed informations.

I'm looking forward to get any feedback from extension users! Contribution, especially on bug fixing is more than welcome!

Great thanks for suggestions and help with debugging for [Martin](https://github.com/kasik96), [Allan](https://github.com/EthraZa), [Maxime](https://github.com/maximedupre), [suuuunto](https://github.com/suuuunto) and all other folks who reported bugs or made improvement requests.

---

Use at your own risk - I do not guarantee that it will work correctly!

---

## Version history

- 0.4.0
  - [ Config fix ]()
- 0.3.9
  - Added [ Fix for autogenerated files not uploading correctly ](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/270)
- 0.3.8
  - Added [ Updated generatedFiles. Both of its properties are required to be set from now on. uploadOnSave works on every file now ](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/269)
- 0.3.7
  - Added [ Fix for broken uploadOnSave and subdirectories not adding properly ](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/264)
- 0.3.5
  - Added [ Various enhancements (SCP Support, bug fixes, list command)](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/237)
  - Added [ List commands](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/215)
  - Added [ Fix for broken ignore and allow regex](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/210)
  - [ Introduced separate store to store syncOption](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/200)
  - Added [ Prompt for password if no password was given in config](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/199)
  - Added [ Fix for config secureOptions being ignored](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/195)
  - [ Implemented allow config](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/170)
  - Added [ Fix for incorrect path for ignore of remote sync](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/163)
  - Added [ Ability to download a single file using the context menu](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/152)
  - Added [ Rudimentary ssh-agent support](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/134)
- 0.3.3
  - Added [ Support for generated files](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/118)
- 0.3.2
  - Added [FTP over SSL support](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/62)
  - Added [Sync current file to Remote](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/77)
  - Fixed bug #86 (by PR #84)
  - [Improved readme and fixed debug mode](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/67)
  - [Compatibility for vscode 1.5+](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/87)
  - [Improve Error handling around parsing config file](https://github.com/lukasz-wronski/vscode-ftp-sync/pull/102)
- 0.3.1
  - Added [SFTP private key support](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/28)
- 0.3.0
  - Added [SFTP protocol support](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/26)
  - Improvement of sync performance in environments with many nested directories
  - Fix for problems with upload on save on unsynced directories
- 0.2.9
  - Fix for [Running the contributed command:'extension.ftpsyncinit' failed](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/3)
  - Fix for [After some tryes the Review file stopped to work](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/7)
  - Added debug output option to config file
  - Error message for incorrect JSON like in [this issue](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/25)
  - Closing review file after commit (pointed out in [this issue](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/23))
  - Fix for [uploadOnSave will fail for files on new created folders](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/22)
  - Added ES6 support in extension source
- 0.2.8
  - Attempt to fix [uploadOnSave will fail for files on new created folders](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/22)
- 0.2.7
  - Fix for [Sync R2L does not delete folder](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/21)
  - Replace of deprecated method `TextEditor.hide` with command call
- 0.2.6
  - Fix for [Error: EXDEV: cross-device link not permitted on mounted drive](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/6)
- 0.2.5
  - Fix for [Local to remote "Full sync" error](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/20)
- 0.2.4
  - Fix for [Duplicate folder in folder we upload to](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/19)
- 0.2.3
  - Fix for [Cant download](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/14)
- 0.2.2
  - Fix for [Upload on save don't track ignored files](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/15)
  - Added support for [ftp passive mode](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/16)
- 0.2.1 - Fix for [Save on second try](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/12)
- 0.2.0 - Rewritten sync mechanism - Changes based on [this conversation](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/2): - New sync wizard - Reviewing changes before save - Choose to remove orphans or not (safe sync) - Fix for [uncontrolled number of ftp connections](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/4)
- 0.1.4 - Fix for [No handler found for the command: 'extension.ftpsyncdownload'](https://github.com/lukasz-wronski/vscode-ftp-sync/issues/1)
- 0.1.2 - Basic progress indication in sync process - Better error handling in sync command - Github links in package.json
- 0.1.1 - All information messages moved to status bar - Removed "alertOnSync" parameter from config - Addedd progress indication in download process - Fixes in download process
- 0.1.0 - First version containing all basic features
