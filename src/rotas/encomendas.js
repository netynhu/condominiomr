// Encomendas: a portaria registra (celular ou computador) e a administração acompanha
const router = require('express').Router();
const { db, ok, getConfig } = require('../db');
const { lerFoto, salvarFoto, dataUrlParaBuffer } = require('../fotos');
const sv = require('../servicos');
const enc = require('../encomendas');
const { lerUnidadesValidas, lerApartamento } = require('../autocadastro');
const { a, exigir, avisar } = require('./comum');

const equipe = exigir('admin', 'portaria');

router.get('/encomendas', equipe, a(async (req, res) => {
  const r = await db.from('encomendas').select('*, unidade:unidades(bloco, numero)').order('recebida_em', { ascending: false }).limit(200);
  if (r.error) return res.render('encomendas', { titulo: 'Encomendas', aguardando: [], recentes: [], semTabela: true, prazo: 7 });
  const cfg = await getConfig();
  const aguardando = r.data.filter((e) => e.status === 'aguardando').reverse(); // mais antigas primeiro
  const recentes = r.data.filter((e) => e.status !== 'aguardando').slice(0, 25);
  res.render('encomendas', { titulo: 'Encomendas', aguardando, recentes, semTabela: false, prazo: Number(cfg.encomenda_prazo_dias) || 7 });
}));

router.post('/encomendas', equipe, a(async (req, res) => {
  const cfg = await getConfig();
  const apto = lerApartamento(String(req.body.apto || ''), lerUnidadesValidas(cfg.unidades_validas));
  if (!apto) { avisar(req, 'Informe o apartamento. Ex.: 304 (ou B 304, se o prédio tem blocos).', 'erro'); return res.redirect('/encomendas'); }
  if (apto.invalido) { avisar(req, `Não encontrei o apartamento ${apto.bloco ? apto.bloco + ' ' : ''}${apto.numero} neste condomínio. Confira o número.`, 'erro'); return res.redirect('/encomendas'); }
  if (apto.faltaBloco) { avisar(req, `O apartamento ${apto.numero} existe nos blocos ${apto.blocos.join(', ')}. Informe o bloco. Ex.: ${apto.blocos[0]} ${apto.numero}`, 'erro'); return res.redirect('/encomendas'); }
  let foto = null;
  if (req.body.imagem) {
    const arq = dataUrlParaBuffer(req.body.imagem);
    if (arq) foto = await salvarFoto(arq.buffer, arq.mime, 'encomendas');
  }
  const r = await enc.registrar({
    unidadeId: await sv.unidadeId(apto.bloco, apto.numero), remetente: req.body.remetente, tipo: req.body.tipo,
    observacao: req.body.observacao, foto, por: `${req.session.usuario.nome}`,
  });
  const quem = `apto ${apto.bloco ? apto.bloco + ' ' : ''}${apto.numero}`;
  avisar(req, r.moradores
    ? `Encomenda nº ${r.encomenda.id} registrada para o ${quem}. ${r.avisados} de ${r.moradores} morador(es) avisado(s) no WhatsApp.`
    : `Encomenda nº ${r.encomenda.id} registrada para o ${quem}, mas não há morador cadastrado neste apartamento. Avise pessoalmente.`, r.moradores ? 'ok' : 'erro');
  res.redirect('/encomendas');
}));

router.post('/encomendas/:id/entregue', equipe, a(async (req, res) => {
  const r = await enc.retirar(Number(req.params.id), { por: `${req.session.usuario.nome} (portaria)` });
  avisar(req, r.ok ? 'Encomenda marcada como entregue. Os avisos pararam.' : r.msg, r.ok ? 'ok' : 'erro');
  res.redirect('/encomendas');
}));

router.post('/encomendas/:id/devolvida', equipe, a(async (req, res) => {
  const r = await enc.retirar(Number(req.params.id), { por: `${req.session.usuario.nome} (portaria)`, devolvida: true });
  avisar(req, r.ok ? 'Encomenda marcada como devolvida ao remetente. Os avisos pararam.' : r.msg, r.ok ? 'ok' : 'erro');
  res.redirect('/encomendas');
}));

// Reenvia o aviso ao morador agora (ex.: o morador disse que não recebeu)
router.post('/encomendas/:id/avisar', equipe, a(async (req, res) => {
  const e = ok(await db.from('encomendas').select('*').eq('id', req.params.id).maybeSingle());
  if (!e || e.status !== 'aguardando') return res.redirect('/encomendas');
  const r = await enc.avisarMoradores(e, { lembrete: true });
  avisar(req, r.moradores ? `${r.avisados} de ${r.moradores} morador(es) avisado(s) de novo.` : 'Não há morador cadastrado neste apartamento.', r.avisados ? 'ok' : 'erro');
  res.redirect('/encomendas');
}));

router.get('/encomendas/:id/foto', equipe, a(async (req, res) => {
  const e = ok(await db.from('encomendas').select('foto').eq('id', req.params.id).maybeSingle());
  if (!e?.foto) return res.sendStatus(404);
  const { buffer, mime } = await lerFoto(e.foto);
  res.set('Content-Type', mime).set('Cache-Control', 'private, max-age=3600').send(buffer);
}));

module.exports = router;
