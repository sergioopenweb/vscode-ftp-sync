/**
 * Converte erros de rede/FTP/SFTP em mensagens legíveis para o usuário.
 */
function formatConnectionError(err) {
  if (!err) {
    return "Erro desconhecido de conexão.";
  }

  if (typeof err === "string") {
    return err;
  }

  var code = err.code;
  var message = (err.message || String(err)).replace(/^Error:\s*/i, "");

  if (
    code === 421 ||
    /no transfer timeout|closing control connection/i.test(message)
  ) {
    return (
      "O servidor FTP encerrou a conexão por falta de transferência de arquivos " +
      '(ex.: FileZilla "No transfer timeout"). Isso ocorre ao listar muitas pastas ou criar diretórios sem enviar arquivos. ' +
      "No servidor: aumente ou desative esse limite (0 = desligado). " +
      'Na extensão: mantenha "transferKeepaliveInterval" em ftp-sync.json (padrão 45000 ms).'
    );
  }

  if (code === "ECONNREFUSED") {
    return (
      "Conexão recusada pelo servidor. Verifique host, porta e se o serviço FTP/SFTP está ativo."
    );
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "Host não encontrado. Verifique o valor de \"host\" em ftp-sync.json.";
  }
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    code === "ETIMEOUT" ||
    /timed out/i.test(message)
  ) {
    return (
      "Tempo de conexão esgotado. Aumente \"timeout\" em ftp-sync.json ou verifique rede/firewall."
    );
  }
  if (code === "ECONNRESET") {
    return "Conexão fechada pelo servidor. Tente de novo ou verifique modo passivo (passive).";
  }
  if (code === "EPERM" || code === "EACCES") {
    return "Permissão negada no servidor: " + message;
  }

  if (err.level === "client-authentication") {
    return "Falha de autenticação SFTP/SCP. Verifique usuário, senha ou chave privada.";
  }

  if (/authentication|login|password|530/i.test(message)) {
    return "Falha de autenticação. Verifique usuário e senha em ftp-sync.json.";
  }

  if (/private key|passphrase/i.test(message)) {
    return "Erro na chave privada SFTP: " + message;
  }

  if (code) {
    return message + " (" + code + ")";
  }

  return message;
}

module.exports = {
  formatConnectionError: formatConnectionError
};
