// Dúvidas que o assistente não soube responder.
// O assistente é sincero com o morador, registra a pergunta e avisa a administração.
// A administração responde no painel (ou pelo WhatsApp): o morador recebe a resposta e,
// se marcado "ensinar", o assistente passa a usar essa resposta para as próximas perguntas.
const { db, ok, getConfig } = require('./db');
const { env } = require('./config');
const sv = require('./servicos');
const { normalizarTelefone, primeiroNome, rotuloUnidade } = require('./util');

// Quem recebe o aviso de pergunta nova: o síndico das Configurações e quem é Síndico/Administração com WhatsApp
async function telefonesDaAdministracao() {
  const equipe = await sv.telefonesDaEquipe(['sindico', 'admin']);
  const tels = equipe.length ? equipe : await sv.telefonesDoPapel('sindico'); // sem equipe: telefone antigo dos Ajustes
  return [...new Set(tels.map(normalizarTelefone).filter(Boolean))];
}

async function registrar({ morador, pergunta, contexto }) {
  const d = ok(await db.from('duvidas').insert({
    morador_id: morador?.id || null, telefone: morador?.telefone || null,
    pergunta: String(pergunta).slice(0, 500), contexto: contexto ? String(contexto).slice(0, 800) : null,
  }).select().single());
  const quem = morador ? `${morador.nome} (${rotuloUnidade(morador.unidade)})` : 'Um morador';
  const link = env.APP_URL ? `${env.APP_URL}/duvidas` : '';
  const texto = `❓ *Pergunta sem resposta nº ${d.id}*\n${quem} perguntou:\n"${d.pergunta}"\n\nO assistente não encontrou a resposta nos documentos e disse que ia verificar com a administração.\n\nResponda pelo painel${link ? `: ${link}` : ''}, ou aqui mesmo, escrevendo: *resposta ${d.id}:* e o texto. O morador recebe a resposta e o assistente aprende para as próximas vezes.`;
  for (const tel of await telefonesDaAdministracao()) await sv.enviar(tel, texto, null, 'síndico');
  return d;
}

// Responde a dúvida: avisa o morador e, se "ensinar", guarda para o assistente usar nas próximas conversas
async function responder(id, resposta, { ensinar = true, enviarMorador = true, usuarioNome = 'Administração' } = {}) {
  const atual = ok(await db.from('duvidas').select('*, morador:moradores(id, nome, telefone)').eq('id', id).single());
  const d = ok(await db.from('duvidas').update({
    status: 'respondida', resposta: String(resposta).trim(), ensinar, respondida_por: usuarioNome, respondida_em: new Date().toISOString(),
  }).eq('id', id).select().single());
  let enviado = false;
  if (enviarMorador && atual.morador?.telefone && atual.status === 'aberta') {
    enviado = await sv.enviar(atual.morador.telefone,
      `Oi, ${primeiroNome(atual.morador.nome)}! A administração respondeu a sua pergunta (nº ${d.id}):\n\n"${d.pergunta}"\n\n${d.resposta}\n\nSe ficou alguma dúvida, é só me chamar.`,
      atual.morador.id);
  }
  return { duvida: d, enviado };
}

async function descartar(id, usuarioNome) {
  return ok(await db.from('duvidas').update({ status: 'descartada', respondida_por: usuarioNome, respondida_em: new Date().toISOString() }).eq('id', id).select().single());
}

// O que a administração já ensinou: vai na parte fixa do prompt do assistente
async function conhecimento() {
  const r = await db.from('duvidas').select('pergunta, resposta').eq('status', 'respondida').eq('ensinar', true).order('respondida_em', { ascending: true }).limit(200);
  if (r.error) return []; // tabela ainda não criada (migração 008)
  return r.data.filter((x) => x.resposta);
}

module.exports = { registrar, responder, descartar, conhecimento, telefonesDaAdministracao };
