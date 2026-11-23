// Condomínio da vez: cada atendimento (página do painel, mensagem do WhatsApp, rotina) roda "dentro" de um condomínio.
// O banco (db.js) usa isso para filtrar e gravar o condominio_id sozinho, sem cada consulta precisar lembrar.
const { AsyncLocalStorage } = require('node:async_hooks');

const armazenamento = new AsyncLocalStorage();

// Roda fn dentro do condomínio informado
function noCondominio(condominioId, fn) {
  if (!condominioId) throw new Error('Condomínio não informado.');
  return armazenamento.run({ condominioId }, fn);
}

// Condomínio da vez (ou null fora de um atendimento)
function condominioAtual() {
  return armazenamento.getStore()?.condominioId || null;
}

module.exports = { noCondominio, condominioAtual, armazenamento };
