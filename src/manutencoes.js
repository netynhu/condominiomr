// Histórico de manutenções: o que foi feito, quando e por quem.
// Usado pelo painel, pelo assistente do síndico (registrar) e pelo assistente do morador (consultar).
const { db, ok } = require('./db');
const { agoraBR } = require('./util');

// Grava no histórico e, se for um item programado, agenda a próxima a partir da data em que foi feita
async function registrar({ manutencaoId, titulo, feitaEm, empresa, observacao, por }) {
  let m = null;
  if (manutencaoId) m = ok(await db.from('manutencoes').select('*').eq('id', manutencaoId).maybeSingle());
  titulo = String(titulo || m?.titulo || '').trim();
  feitaEm = /^\d{4}-\d{2}-\d{2}$/.test(String(feitaEm || '')) ? feitaEm : agoraBR().dataISO;
  if (!titulo) return { erro: 'Informe o que foi feito.' };
  const r = await db.from('manutencao_registros').insert({
    manutencao_id: m?.id || null, titulo, feita_em: feitaEm, empresa: (empresa || '').trim() || null,
    observacao: (observacao || '').trim() || null, registrada_por: por || null,
  });
  if (r.error) return { erro: /manutencao_registros/.test(r.error.message) ? 'Falta rodar a migração 013 no banco.' : r.error.message };
  let proxima = null;
  if (m) {
    proxima = new Date(new Date(feitaEm + 'T12:00:00-03:00').getTime() + m.periodicidade_dias * 86400000).toISOString().slice(0, 10);
    ok(await db.from('manutencoes').update({ proxima_data: proxima, alerta_enviado_para: null }).eq('id', m.id));
  }
  return { titulo, feitaEm, proxima };
}

// Sem acento e minúsculo, para achar "caixa d'agua" em "Limpeza da caixa d’água"
const normal = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`]/g, '');
const PALAVRAS_VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'a', 'o', 'e', 'na', 'no', 'em', 'ultima', 'ultimo', 'manutencao', 'quando', 'foi', 'feita', 'qual']);

// Consulta para o assistente: histórico (o que combina com o assunto) e o que está programado
async function consultar(assunto) {
  const [hist, prog] = await Promise.all([
    db.from('manutencao_registros').select('titulo, feita_em, empresa, observacao').order('feita_em', { ascending: false }).limit(300),
    db.from('manutencoes').select('titulo, descricao, proxima_data, periodicidade_dias').order('proxima_data'),
  ]);
  const registros = hist.error ? [] : hist.data;
  const programadas = prog.error ? [] : prog.data;
  const termos = normal(assunto).split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !PALAVRAS_VAZIAS.has(t));
  const combina = (texto) => !termos.length || termos.some((t) => normal(texto).includes(t));
  const data = (iso) => iso.split('-').reverse().join('/');
  return {
    feitas: registros.filter((r) => combina(`${r.titulo} ${r.observacao || ''}`)).slice(0, 10)
      .map((r) => ({ o_que: r.titulo, quando: data(r.feita_em), por: r.empresa || undefined, observacao: r.observacao || undefined })),
    programadas: programadas.filter((p) => combina(`${p.titulo} ${p.descricao || ''}`)).slice(0, 10)
      .map((p) => ({ o_que: p.titulo, proxima: data(p.proxima_data), a_cada_dias: p.periodicidade_dias })),
  };
}

module.exports = { registrar, consultar };
