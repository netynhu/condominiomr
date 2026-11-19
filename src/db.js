const { createClient } = require('@supabase/supabase-js');
const { env } = require('./config');

// Com tempo limite: se o banco cair, a página mostra um erro em vez de ficar carregando para sempre
const fetchComLimite = (url, opts = {}) => fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(8000) })
  .catch((e) => { throw new Error(e.name === 'TimeoutError' || e.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ? 'O banco de dados (Supabase) não está respondendo.' : e.message); });

const db = createClient(env.SUPABASE_URL || 'http://localhost', env.SUPABASE_SERVICE_ROLE_KEY || 'x', {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: fetchComLimite },
});

// Lança erro quando o Supabase devolve erro, para não esconder falhas.
function ok(res) {
  if (res.error) {
    const e = new Error(res.error.message || 'Erro no banco');
    e.detalhe = res.error;
    throw e;
  }
  return res.data;
}

async function contar(tabela, filtro) {
  let q = db.from(tabela).select('*', { count: 'exact', head: true });
  if (filtro) q = filtro(q);
  const res = await q;
  if (res.error) throw new Error(res.error.message);
  return res.count || 0;
}

// Configurações do prédio (tabela chave/valor)
const PADRAO = {
  nome_predio: 'Condomínio',
  nome_assistente: 'Assistente do Condomínio',
  telefone_sindico: '',
  telefone_zelador: '',
  telefone_portaria: '',
  grupo_jid: '',
  grupo_nome: '',
  horario_administracao: 'segunda a sexta, das 9h às 18h',
  instrucoes_extras: '',
  grupo_chamar_privado: '1',
};

async function getConfig() {
  const linhas = ok(await db.from('config').select('chave, valor'));
  const cfg = { ...PADRAO };
  for (const l of linhas) cfg[l.chave] = l.valor ?? '';
  return cfg;
}

async function setConfig(valores) {
  const linhas = Object.entries(valores).map(([chave, valor]) => ({ chave, valor: valor == null ? '' : String(valor) }));
  if (linhas.length) ok(await db.from('config').upsert(linhas, { onConflict: 'chave' }));
}

// Grava uma mensagem no histórico. Se a coluna wa_id ainda não existir (migração 004 não rodada), grava sem ela.
async function inserirMensagem(linha) {
  let r = await db.from('mensagens').insert(linha);
  if (r.error && linha.wa_id !== undefined && /wa_id/.test(r.error.message)) {
    const { wa_id, ...sem } = linha; // eslint-disable-line no-unused-vars
    r = await db.from('mensagens').insert(sem);
  }
  if (r.error) throw new Error(r.error.message);
}

module.exports = { db, ok, contar, getConfig, setConfig, inserirMensagem };
