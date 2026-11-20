// Painel inicial, IA que ajuda a decidir, radar do grupo e relatório do conselho
const router = require('express').Router();
const { db, ok, contar, getConfig, setConfig } = require('../db');
const { completar } = require('../ia');
const uazapi = require('../uazapi');
const sv = require('../servicos');
const { dataHora, data, agoraBR } = require('../util');
const { a, exigir, avisar, PAGINA_INICIAL } = require('./comum');

const dias = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

// Fotografia do prédio usada pela IA do painel
async function panorama() {
  const agora = Date.now();
  const [chamados, reclamacoes, eventos, manut, grupo, pendentes] = await Promise.all([
    db.from('chamados').select('id, titulo, local, categoria, prioridade, status, criado_em, atualizado_em').in('status', ['aberto', 'em_andamento']).order('criado_em').limit(80).then(ok),
    db.from('reclamacoes').select('id, tipo, unidade_alvo, descricao, status, criado_em').gte('criado_em', new Date(agora - 30 * 86400000).toISOString()).order('criado_em', { ascending: false }).limit(80).then(ok),
    db.from('eventos').select('titulo, inicio, publico').gte('inicio', new Date(agora).toISOString()).lte('inicio', new Date(agora + 14 * 86400000).toISOString()).order('inicio').then(ok),
    db.from('manutencoes').select('titulo, proxima_data').lte('proxima_data', new Date(agora + 45 * 86400000).toISOString().slice(0, 10)).order('proxima_data').then(ok),
    db.from('grupo_mensagens').select('nome, texto, criado_em').gte('criado_em', new Date(agora - 3 * 86400000).toISOString()).order('criado_em', { ascending: false }).limit(150).then(ok),
    contar('contatos_pendentes'),
  ]);
  // Histórico de 90 dias para perceber problemas recorrentes
  const hist = ok(await db.from('chamados').select('titulo, local, criado_em').gte('criado_em', new Date(agora - 90 * 86400000).toISOString()).limit(400));
  return {
    hoje: agoraBR().dataISO,
    chamados_abertos: chamados.map((c) => ({ numero: c.id, titulo: c.titulo, local: c.local, categoria: c.categoria, prioridade: c.prioridade, status: c.status, dias_aberto: dias(c.criado_em), dias_sem_atualizacao: dias(c.atualizado_em) })),
    chamados_90_dias: hist.map((c) => `${data(c.criado_em)} ${c.titulo} (${c.local || ''})`),
    reclamacoes_30_dias: reclamacoes.map((r) => ({ numero: r.id, tipo: r.tipo, unidade: r.unidade_alvo, status: r.status, quando: dataHora(r.criado_em), descricao: r.descricao.slice(0, 200) })),
    proximos_eventos: eventos.map((e) => ({ titulo: e.titulo, quando: dataHora(e.inicio), publico: e.publico })),
    manutencoes_proximas: manut,
    grupo_ultimos_3_dias: grupo.map((g) => `${g.nome || 'morador'}: ${g.texto.slice(0, 200)}`),
    contatos_sem_cadastro: pendentes,
  };
}

const PAPEL_IA = 'Você é o assistente de gestão de um condomínio residencial e ajuda o síndico e a administração a decidir. Português do Brasil, linguagem simples e direta. Use apenas os dados fornecidos e nunca invente números. Quando sugerir algo com peso jurídico (notificação, multa), lembre que precisa ser aprovado pela administração. Não identifique autores de reclamações.';

router.get('/', exigir(), a(async (req, res) => {
  const perfil = req.session.usuario.perfil;
  if (perfil !== 'admin') return res.redirect(PAGINA_INICIAL[perfil]);
  const cfg = await getConfig();
  const agora = new Date().toISOString();
  const [abertos, urgentes, reclNovas, pendentes, fila, eventos, moradores] = await Promise.all([
    contar('chamados', (q) => q.in('status', ['aberto', 'em_andamento'])),
    contar('chamados', (q) => q.in('status', ['aberto', 'em_andamento']).in('prioridade', ['alta', 'urgente'])),
    contar('reclamacoes', (q) => q.eq('status', 'nova')),
    contar('contatos_pendentes'),
    contar('fila_envio', (q) => q.eq('status', 'pendente')),
    db.from('eventos').select('id, titulo, inicio').gte('inicio', agora).order('inicio').limit(4).then(ok),
    contar('moradores', (q) => q.eq('ativo', true)),
  ]);
  const duvidas = await contar('duvidas', (q) => q.eq('status', 'aberta')).catch(() => 0);
  let whats = null;
  try { whats = await uazapi.status(); } catch { whats = null; }
  res.render('inicio', {
    titulo: 'Início', duvidas, abertos, urgentes, reclNovas, pendentes, fila, eventos, moradores, whats,
    resumo: cfg.resumo_dia || '', resumoEm: cfg.resumo_dia_em || '',
  });
}));

router.post('/ia/resumo', exigir('admin'), a(async (req, res) => {
  const dados = await panorama();
  const texto = await completar(
    PAPEL_IA,
    `Monte o resumo do dia para o síndico com 4 partes curtas, cada uma com um título em uma linha própria:\n1. Urgente hoje\n2. Parado ou atrasado (chamados sem atualização há 3 dias ou mais)\n3. Padrões que merecem decisão (problemas que se repetem, unidades com reclamações reincidentes, assuntos crescendo no grupo)\n4. Próximos compromissos (eventos e manutenções)\nPara cada item, diga o próximo passo sugerido em uma frase. Se uma parte não tiver nada, escreva "Nada a destacar".\n\nDADOS:\n${JSON.stringify(dados)}`,
    { maxTokens: 1200 },
  );
  await setConfig({ resumo_dia: texto, resumo_dia_em: new Date().toISOString() });
  res.json({ texto, em: dataHora(new Date().toISOString()) });
}));

router.post('/ia/pergunta', exigir('admin', 'conselho'), a(async (req, res) => {
  const pergunta = String(req.body.pergunta || '').slice(0, 500);
  if (!pergunta) return res.json({ texto: '' });
  const dados = await panorama();
  const texto = await completar(PAPEL_IA, `Responda à pergunta da administração usando só estes dados. Se os dados não bastarem, diga o que falta.\n\nPERGUNTA: ${pergunta}\n\nDADOS:\n${JSON.stringify(dados)}`, { maxTokens: 700 });
  res.json({ texto });
}));

// Rascunho de aviso ou notificação a partir de uma ideia curta
router.post('/ia/rascunho', exigir('admin'), a(async (req, res) => {
  const ideia = String(req.body.ideia || '').slice(0, 1500);
  const tipo = req.body.tipo === 'notificacao' ? 'notificacao' : 'aviso';
  const cfg = await getConfig();
  const docs = ok(await db.from('documentos').select('titulo, conteudo').eq('ativo', true)).map((d) => `### ${d.titulo}\n${d.conteudo}`).join('\n\n').slice(0, 30000);
  const instr = tipo === 'aviso'
    ? 'Escreva um aviso de WhatsApp para os moradores: claro, educado, curto (até 8 linhas), sem markdown. Não comece com saudação, porque o sistema já adiciona "Olá, nome!". Responda no formato:\nTITULO: ...\nTEXTO: ...'
    : 'Escreva um rascunho de notificação formal do condomínio para uma unidade, citando o artigo do regimento que se aplica se ele existir nos documentos. Tom respeitoso e objetivo. Deixe claro que é um rascunho para a administração revisar. Responda no formato:\nTITULO: ...\nTEXTO: ...';
  const r = await completar(PAPEL_IA, `${instr}\n\nPrédio: ${cfg.nome_predio}\nPedido: ${ideia}\n\nDOCUMENTOS:\n${docs || '(nenhum)'}`, { maxTokens: 800 });
  const titulo = (r.match(/TITULO:\s*(.+)/i) || [])[1] || '';
  const texto = (r.split(/TEXTO:\s*/i)[1] || r).trim();
  res.json({ titulo: titulo.trim(), texto });
}));

// ---------- Radar do grupo ----------
router.get('/radar', exigir('admin', 'conselho'), a(async (req, res) => {
  const cfg = await getConfig();
  const msgs = ok(await db.from('grupo_mensagens').select('*').gte('criado_em', new Date(Date.now() - 7 * 86400000).toISOString()).order('criado_em', { ascending: false }).limit(300));
  res.render('radar', { titulo: 'Radar do grupo', msgs, grupo: cfg.grupo_nome, analise: cfg.radar_analise || '', analiseEm: cfg.radar_analise_em || '' });
}));

router.post('/radar/analisar', exigir('admin', 'conselho'), a(async (req, res) => {
  const msgs = ok(await db.from('grupo_mensagens').select('nome, texto, criado_em').gte('criado_em', new Date(Date.now() - 7 * 86400000).toISOString()).order('criado_em').limit(600));
  if (!msgs.length) { avisar(req, 'Ainda não há mensagens do grupo nos últimos 7 dias.', 'erro'); return res.redirect('/radar'); }
  const texto = await completar(
    PAPEL_IA,
    `Analise as mensagens do grupo de moradores dos últimos 7 dias. Entregue:\n- Os assuntos mais comentados, com quantas pessoas diferentes falaram de cada um\n- O clima geral do grupo em uma frase\n- Problemas citados que provavelmente não viraram chamado\n- Sugestões de ação para a administração\nNão exponha nomes em assuntos sensíveis. Sem markdown pesado, use linhas curtas.\n\nMENSAGENS:\n${msgs.map((m) => `[${dataHora(m.criado_em)}] ${m.nome || 'morador'}: ${m.texto.slice(0, 300)}`).join('\n')}`,
    { maxTokens: 1000 },
  );
  await setConfig({ radar_analise: texto, radar_analise_em: new Date().toISOString() });
  res.redirect('/radar');
}));

// ---------- Relatório do conselho ----------
router.get('/relatorio', exigir('admin', 'conselho'), a(async (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : agoraBR().dataISO.slice(0, 7);
  const ini = new Date(`${mes}-01T00:00:00-03:00`);
  const fim = new Date(ini); fim.setMonth(fim.getMonth() + 1);
  const [I, F] = [ini.toISOString(), fim.toISOString()];

  const [chamados, reclamacoes, entradas, avisos, ativosAgora] = await Promise.all([
    db.from('chamados').select('id, categoria, status, criado_em, resolvido_em, titulo, avaliacao').gte('criado_em', I).lt('criado_em', F).then(ok),
    db.from('reclamacoes').select('tipo, unidade_alvo, status').gte('criado_em', I).lt('criado_em', F).then(ok),
    db.from('mensagens').select('morador_id').eq('direcao', 'entrada').not('morador_id', 'is', null).gte('criado_em', I).lt('criado_em', F).limit(20000).then(ok),
    contar('avisos', (q) => q.gte('criado_em', I).lt('criado_em', F).neq('status', 'rascunho')),
    contar('chamados', (q) => q.in('status', ['aberto', 'em_andamento'])),
  ]);

  const resolvidos = chamados.filter((c) => c.resolvido_em);
  const horas = resolvidos.map((c) => (new Date(c.resolvido_em) - new Date(c.criado_em)) / 3600000);
  const porCategoria = {}; for (const c of chamados) porCategoria[c.categoria] = (porCategoria[c.categoria] || 0) + 1;
  const porTipo = {}; for (const r of reclamacoes) porTipo[r.tipo] = (porTipo[r.tipo] || 0) + 1;
  const porUnidade = {}; for (const r of reclamacoes) if (r.unidade_alvo) { const k = sv.chaveUnidade(r.unidade_alvo); porUnidade[k] = (porUnidade[k] || 0) + 1; }

  res.render('relatorio', {
    titulo: 'Relatório do mês', mes,
    m: {
      chamados: chamados.length, resolvidos: resolvidos.length, abertosAgora: ativosAgora,
      tempoMedio: horas.length ? horas.reduce((s, h) => s + h, 0) / horas.length : null,
      porCategoria: Object.entries(porCategoria).sort((x, y) => y[1] - x[1]),
      reclamacoes: reclamacoes.length,
      porTipo: Object.entries(porTipo).sort((x, y) => y[1] - x[1]),
      unidadesReincidentes: Object.entries(porUnidade).filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1]),
      mensagens: entradas.length,
      moradoresAtendidos: new Set(entradas.map((e) => e.morador_id).filter(Boolean)).size,
      notas: chamados.filter((c) => c.avaliacao).length,
      notaMedia: (() => { const n = chamados.filter((c) => c.avaliacao); return n.length ? n.reduce((s, c) => s + c.avaliacao, 0) / n.length : null; })(),
      avisos,
    },
  });
}));

// ---------- Assistente da administração (chat no painel) ----------
router.get('/assistente', exigir('admin'), a(async (req, res) => {
  const { historicoPainel } = require('../agente_admin');
  res.render('assistente', { titulo: 'Assistente', historico: await historicoPainel(req.session.usuario.id) });
}));

router.post('/assistente', exigir('admin'), a(async (req, res) => {
  const texto = String(req.body.texto || '').trim().slice(0, 2000);
  if (!texto) return res.json({ resposta: '' });
  const { atenderAdminPainel } = require('../agente_admin');
  res.json({ resposta: await atenderAdminPainel(req.session.usuario, texto) });
}));

router.panorama = panorama;
module.exports = router;
