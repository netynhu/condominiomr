const router = require('express').Router();
const { db, ok, contar } = require('../db');
const sv = require('../servicos');
const { localParaISO } = require('../util');
const { a, exigir, avisar } = require('./comum');

// ---------- Chamados (administração e zelador) ----------
router.get('/chamados', exigir('admin', 'zelador'), a(async (req, res) => {
  const filtro = req.query.status || 'abertos';
  let q = db.from('chamados').select('*, morador:moradores(nome, unidade:unidades(bloco, numero))').order('criado_em', { ascending: false }).limit(200);
  if (filtro === 'abertos') q = q.in('status', ['aberto', 'em_andamento']);
  else if (filtro !== 'todos') q = q.eq('status', filtro);
  if (req.session.usuario.perfil === 'zelador') q = q.neq('categoria', 'administracao');
  const lista = ok(await q);
  const ordem = { urgente: 0, alta: 1, normal: 2, baixa: 3 };
  if (filtro === 'abertos') lista.sort((x, y) => ordem[x.prioridade] - ordem[y.prioridade] || new Date(x.criado_em) - new Date(y.criado_em));
  res.render('chamados', { titulo: 'Chamados', lista, filtro });
}));

router.post('/chamados', exigir('admin'), a(async (req, res) => {
  const b = req.body;
  if (!b.titulo) { avisar(req, 'Informe o título.', 'erro'); return res.redirect('/chamados'); }
  const ch = await sv.abrirChamado({ titulo: b.titulo, descricao: b.descricao, local: b.local, prioridade: b.prioridade, categoria: b.categoria, origem: 'painel', usuarioNome: req.session.usuario.nome });
  avisar(req, `Chamado nº ${ch.id} aberto.`);
  res.redirect('/chamados');
}));

router.get('/chamados/:id', exigir('admin', 'zelador'), a(async (req, res) => {
  const c = ok(await db.from('chamados').select('*, morador:moradores(id, nome, telefone, unidade:unidades(bloco, numero))').eq('id', req.params.id).single());
  if (req.session.usuario.perfil === 'zelador' && c.categoria === 'administracao') return res.redirect('/chamados');
  const historico = ok(await db.from('chamado_historico').select('*').eq('chamado_id', c.id).order('criado_em'));
  res.render('chamado', { titulo: `Chamado nº ${c.id}`, c, historico });
}));

router.post('/chamados/:id/status', exigir('admin', 'zelador'), a(async (req, res) => {
  const { status, observacao } = req.body;
  if (!sv.ROTULO_STATUS[status]) return res.redirect(`/chamados/${req.params.id}`);
  await sv.mudarStatusChamado(req.params.id, status, (observacao || '').trim(), req.session.usuario.nome);
  avisar(req, status === 'aberto' ? 'Chamado reaberto.' : 'Status atualizado. O morador foi avisado no WhatsApp.');
  res.redirect(`/chamados/${req.params.id}`);
}));

router.post('/chamados/:id/prioridade', exigir('admin'), a(async (req, res) => {
  ok(await db.from('chamados').update({ prioridade: req.body.prioridade, atualizado_em: new Date().toISOString() }).eq('id', req.params.id));
  await sv.registrarHistoricoChamado(req.params.id, `Prioridade: ${req.body.prioridade}`, req.session.usuario.nome);
  res.redirect(`/chamados/${req.params.id}`);
}));

// ---------- Reclamações (administração e portaria; autor nunca aparece) ----------
router.get('/reclamacoes', exigir('admin', 'portaria'), a(async (req, res) => {
  const filtro = req.query.status || 'abertas';
  let q = db.from('reclamacoes').select('id, unidade_alvo, tipo, descricao, acontecendo_agora, status, tratativa, tratada_por, criado_em, tratada_em').order('criado_em', { ascending: false }).limit(200);
  if (filtro === 'abertas') q = q.in('status', ['nova', 'em_tratamento']);
  else if (filtro !== 'todas') q = q.eq('status', filtro);
  const lista = ok(await q);

  // Reincidência por unidade nos últimos 30 dias
  const desde = new Date(Date.now() - 30 * 86400000).toISOString();
  const recentes = ok(await db.from('reclamacoes').select('unidade_alvo').gte('criado_em', desde).not('unidade_alvo', 'is', null));
  const contagem = {};
  for (const r of recentes) { const k = sv.chaveUnidade(r.unidade_alvo); contagem[k] = (contagem[k] || 0) + 1; }
  const reinc = Object.entries(contagem).filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1]);

  res.render('reclamacoes', { titulo: 'Reclamações', lista, filtro, contagem, reinc, chave: sv.chaveUnidade });
}));

router.post('/reclamacoes/:id', exigir('admin', 'portaria'), a(async (req, res) => {
  const { status, tratativa } = req.body;
  if (!['nova', 'em_tratamento', 'resolvida', 'arquivada'].includes(status)) return res.redirect('/reclamacoes');
  const r = await sv.atualizarReclamacao(req.params.id, status, (tratativa || '').trim(), req.session.usuario.nome);
  const avisado = r.autor && (status === 'em_tratamento' || status === 'resolvida');
  avisar(req, `Reclamação nº ${req.params.id} atualizada.${avisado ? ' Quem reclamou foi avisado no WhatsApp.' : ''}`);
  res.redirect('/reclamacoes');
}));

// ---------- Avisos ----------
router.get('/avisos', exigir('admin'), a(async (req, res) => {
  const lista = ok(await db.from('avisos').select('*').order('criado_em', { ascending: false }).limit(50));
  for (const av of lista.filter((x) => x.status !== 'rascunho')) {
    av.enviados = await contar('fila_envio', (q) => q.eq('aviso_id', av.id).eq('status', 'enviado'));
    av.erros = await contar('fila_envio', (q) => q.eq('aviso_id', av.id).eq('status', 'erro'));
  }
  const blocos = [...new Set(ok(await db.from('unidades').select('bloco')).map((u) => u.bloco).filter(Boolean))].sort();
  res.render('avisos', { titulo: 'Avisos', lista, blocos });
}));

router.post('/avisos', exigir('admin'), a(async (req, res) => {
  const { titulo, texto, publico, acao } = req.body;
  const canal = req.body.canal === 'privado' ? 'privado' : 'grupo';
  if (!titulo || !texto) { avisar(req, 'Preencha título e texto.', 'erro'); return res.redirect('/avisos'); }
  const av = ok(await db.from('avisos').insert({ titulo, texto, canal, publico: canal === 'grupo' ? 'todos' : (publico || 'todos'), criado_por: req.session.usuario.nome }).select().single());
  if (acao === 'enviar') return enviarAviso(req, res, av);
  avisar(req, 'Rascunho salvo.');
  res.redirect('/avisos');
}));

router.post('/avisos/:id/enviar', exigir('admin'), a(async (req, res) => {
  const av = ok(await db.from('avisos').select('*').eq('id', req.params.id).single());
  if (av.status !== 'rascunho') { avisar(req, 'Este aviso já foi enviado.', 'erro'); return res.redirect('/avisos'); }
  return enviarAviso(req, res, av);
}));

async function enviarAviso(req, res, av) {
  if (av.canal === 'grupo') {
    try {
      await sv.postarNoGrupo(av.titulo, av.texto);
      ok(await db.from('avisos').update({ status: 'enviado', total: 1, enviado_em: new Date().toISOString() }).eq('id', av.id));
      avisar(req, 'Aviso postado no grupo dos moradores.');
    } catch (e) {
      avisar(req, `Não foi possível postar no grupo: ${e.message}. O aviso ficou salvo como rascunho.`, 'erro');
    }
    return res.redirect('/avisos');
  }
  const total = await sv.enfileirar(av.publico, `${av.titulo}\n\n${av.texto}`, av.id);
  ok(await db.from('avisos').update({ status: total ? 'enviando' : 'enviado', total }).eq('id', av.id));
  avisar(req, total ? `Aviso na fila para ${total} moradores. As mensagens saem aos poucos, no horário permitido.` : 'Nenhum morador para este público.', total ? 'ok' : 'erro');
  res.redirect('/avisos');
}

router.post('/avisos/:id/excluir', exigir('admin'), a(async (req, res) => {
  ok(await db.from('avisos').delete().eq('id', req.params.id).eq('status', 'rascunho'));
  res.redirect('/avisos');
}));

// ---------- Agenda ----------
const tituloEvento = (e) => `${e.publico && e.publico.startsWith('bloco:') ? `Bloco ${e.publico.slice(6)} · ` : ''}${e.titulo}`;
const textoEvento = (e) => `🗓️ ${require('../util').dataExtenso(e.inicio)}${e.fim ? ` até ${require('../util').dataExtenso(e.fim)}` : ''}${e.local ? `\n📍 ${e.local}` : ''}${e.descricao ? `\n\n${e.descricao}` : ''}`;
router.get('/agenda', exigir('admin'), a(async (req, res) => {
  const desde = new Date(Date.now() - 7 * 86400000).toISOString();
  const lista = ok(await db.from('eventos').select('*').gte('inicio', desde).order('inicio'));
  const blocos = [...new Set(ok(await db.from('unidades').select('bloco')).map((u) => u.bloco).filter(Boolean))].sort();
  const editar = req.query.editar ? lista.find((e) => e.id === req.query.editar) : null;
  res.render('agenda', { titulo: 'Agenda do condomínio', lista, blocos, editar });
}));

router.post('/agenda', exigir('admin'), a(async (req, res) => {
  const b = req.body;
  if (!b.titulo || !b.inicio) { avisar(req, 'Informe título e data.', 'erro'); return res.redirect('/agenda'); }
  const dados = {
    titulo: b.titulo, descricao: b.descricao || null, local: b.local || null,
    inicio: localParaISO(b.inicio), fim: localParaISO(b.fim), publico: b.publico || 'todos', avisar_vespera: b.avisar_vespera === 'on',
  };
  if (b.id) ok(await db.from('eventos').update({ ...dados, lembrete_enviado: false }).eq('id', b.id));
  else ok(await db.from('eventos').insert(dados));
  if (b.avisar_agora === 'on') {
    try {
      await sv.postarNoGrupo(tituloEvento(dados), textoEvento(dados));
      avisar(req, 'Evento salvo e postado no grupo dos moradores.');
    } catch (e) { avisar(req, `Evento salvo, mas não foi possível postar no grupo: ${e.message}`, 'erro'); }
  } else avisar(req, 'Evento salvo. O assistente já sabe dele.');
  res.redirect('/agenda');
}));

router.post('/agenda/:id/excluir', exigir('admin'), a(async (req, res) => {
  ok(await db.from('eventos').delete().eq('id', req.params.id));
  res.redirect('/agenda');
}));

// ---------- Manutenção preventiva ----------
router.get('/manutencoes', exigir('admin'), a(async (req, res) => {
  const lista = ok(await db.from('manutencoes').select('*').order('proxima_data'));
  const editar = req.query.editar ? lista.find((m) => m.id === req.query.editar) : null;
  res.render('manutencoes', { titulo: 'Manutenção preventiva', lista, editar });
}));

router.post('/manutencoes', exigir('admin'), a(async (req, res) => {
  const b = req.body;
  const dados = {
    titulo: b.titulo, descricao: b.descricao || null, proxima_data: b.proxima_data,
    periodicidade_dias: Number(b.periodicidade_dias) || 365, antecedencia_dias: Number(b.antecedencia_dias) || 15,
  };
  if (!dados.titulo || !dados.proxima_data) { avisar(req, 'Informe o item e a próxima data.', 'erro'); return res.redirect('/manutencoes'); }
  if (b.id) ok(await db.from('manutencoes').update(dados).eq('id', b.id));
  else ok(await db.from('manutencoes').insert(dados));
  avisar(req, 'Manutenção salva.');
  res.redirect('/manutencoes');
}));

// Marca como feita e agenda a próxima
router.post('/manutencoes/:id/feita', exigir('admin'), a(async (req, res) => {
  const m = ok(await db.from('manutencoes').select('*').eq('id', req.params.id).single());
  const base = new Date(); // conta a partir de hoje
  const prox = new Date(base.getTime() + m.periodicidade_dias * 86400000).toISOString().slice(0, 10);
  ok(await db.from('manutencoes').update({ proxima_data: prox, alerta_enviado_para: null }).eq('id', m.id));
  avisar(req, `${m.titulo}: próxima em ${prox.split('-').reverse().join('/')}.`);
  res.redirect('/manutencoes');
}));

router.post('/manutencoes/:id/excluir', exigir('admin'), a(async (req, res) => {
  ok(await db.from('manutencoes').delete().eq('id', req.params.id));
  res.redirect('/manutencoes');
}));

module.exports = router;
