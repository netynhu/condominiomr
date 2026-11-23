const { createClient } = require('@supabase/supabase-js');
const { env } = require('./config');

// Com tempo limite: se o banco cair, a página mostra um erro em vez de ficar carregando para sempre
const fetchComLimite = (url, opts = {}) => fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(8000) })
  .catch((e) => { throw new Error(e.name === 'TimeoutError' || e.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ? 'O banco de dados (Supabase) não está respondendo.' : e.message); });

const cliente = createClient(env.SUPABASE_URL || 'http://localhost', env.SUPABASE_SERVICE_ROLE_KEY || 'x', {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: fetchComLimite },
});

// ---------- Vários condomínios ----------
// Tabelas que pertencem a um condomínio. Pelo "db", toda consulta nelas é filtrada pelo condomínio da vez
// (contexto.js) e todo registro novo recebe o condominio_id. Para olhar todos os condomínios de propósito
// (ex.: achar de qual prédio é um telefone), use "dbGlobal".
const { condominioAtual } = require('./contexto');
const DO_CONDOMINIO = new Set(['unidades', 'moradores', 'mensagens', 'chamados', 'reclamacoes', 'eventos', 'lembretes', 'avisos',
  'fila_envio', 'documentos', 'manutencoes', 'grupo_mensagens', 'config', 'duvidas', 'contatos_pendentes', 'encomendas', 'espacos', 'reservas', 'manutencao_registros']);
// Podem ser gravadas sem condomínio (ex.: mensagem de quem ainda está se cadastrando)
const SEM_CONDOMINIO_PERMITIDO = new Set(['mensagens', 'contatos_pendentes']);

const comCondominio = (valores, id) => (Array.isArray(valores) ? valores.map((v) => ({ ...v, condominio_id: id })) : { ...valores, condominio_id: id });

function tabela(nome) {
  const real = cliente.from(nome);
  if (!DO_CONDOMINIO.has(nome)) return real;
  const id = condominioAtual();
  if (!id) {
    if (SEM_CONDOMINIO_PERMITIDO.has(nome)) return real;
    throw new Error(`Consulta em "${nome}" sem condomínio definido.`);
  }
  return {
    select: (...a) => real.select(...a).eq('condominio_id', id),
    update: (...a) => real.update(...a).eq('condominio_id', id),
    delete: (...a) => real.delete(...a).eq('condominio_id', id),
    insert: (valores, opts) => real.insert(comCondominio(valores, id), opts),
    upsert: (valores, opts) => real.upsert(comCondominio(valores, id), opts),
  };
}

const db = { from: tabela, rpc: (...a) => cliente.rpc(...a) };
const dbGlobal = cliente;

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
  grupo_convite: '',
  horario_administracao: 'segunda a sexta, das 9h às 18h',
  instrucoes_extras: '',
  grupo_chamar_privado: '1',
  horario_obras: 'segunda a sexta, das 9h às 17h; sábado, das 9h às 13h; domingo e feriado: não pode',
  horario_mudancas: 'segunda a sábado, das 8h às 17h; domingo e feriado: não pode',
  horario_silencio: 'das 22h às 8h de domingo a quinta; das 23h às 9h na sexta, no sábado e em véspera de feriado',
  sindico_reclamacoes: 'todas',       // todas | reincidencia | nenhuma
  sindico_reincidencia_minima: '3',
  autocadastro: '1',                        // morador que está no grupo pode se cadastrar pelo WhatsApp
  unidades_validas: '',                     // ex.: "101-110, 201-210" ou "A/101-104" (vazio = aceita qualquer número)
  autocadastro_reclamacao_conferido: '1',   // reclamação só depois que a administração conferir o cadastro
  fora_assunto_limite: '3',                 // perguntas fora do assunto (em 24h) até pausar o atendimento; 0 desliga
  encomenda_prazo_dias: '7',               // dias parada na portaria até avisar a administração
  fora_assunto_horas: '12',                 // por quantas horas o atendimento fica pausado
  // Administradora do condomínio (boletos, 2ª via, acordos)
  adm_nome: '', adm_contato: '', adm_telefone: '', adm_whatsapp: '', adm_email: '', adm_portal: '', adm_horario: '', adm_observacoes: '',
};

// Ajustes do condomínio da vez. O nome do prédio vem da tabela de condomínios quando não foi ajustado.
async function getConfig() {
  const id = condominioAtual();
  const cfg = { ...PADRAO, condominio_id: id };
  if (!id) return cfg;
  const [linhas, cond] = await Promise.all([
    db.from('config').select('chave, valor').then(ok),
    cliente.from('condominios').select('nome').eq('id', id).maybeSingle().then(ok),
  ]);
  if (cond?.nome) cfg.nome_predio = cond.nome;
  for (const l of linhas) cfg[l.chave] = l.valor ?? '';
  return cfg;
}

async function setConfig(valores) {
  const linhas = Object.entries(valores).map(([chave, valor]) => ({ chave, valor: valor == null ? '' : String(valor) }));
  if (linhas.length) ok(await db.from('config').upsert(linhas, { onConflict: 'condominio_id,chave' }));
  // O nome do prédio também fica na tabela de condomínios (aparece no seletor do painel)
  if (valores.nome_predio && condominioAtual()) ok(await cliente.from('condominios').update({ nome: String(valores.nome_predio) }).eq('id', condominioAtual()));
}

// Todos os condomínios ativos (para rotinas e para achar de onde é um telefone)
async function listarCondominios() {
  return ok(await cliente.from('condominios').select('id, nome').eq('ativo', true).order('nome'));
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

module.exports = { db, dbGlobal, ok, contar, getConfig, setConfig, inserirMensagem, listarCondominios, PADRAO };
