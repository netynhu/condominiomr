const router = require('express').Router();
const { env } = require('../config');
const { setConfig, getConfig } = require('../db');
const uazapi = require('../uazapi');
const { a, exigir, exigirDono, avisar } = require('./comum');

const urlWebhook = () => `${env.APP_URL}/webhook/uazapi/${env.WEBHOOK_SECRET}`;

router.get('/whatsapp', exigir('admin'), a(async (req, res) => {
  let status = null;
  let erro = null;
  try { status = await uazapi.status(); } catch (e) { erro = e.message; }
  res.render('whatsapp', { titulo: 'Conexão do WhatsApp', status, erro, webhook: env.APP_URL ? urlWebhook().replace(env.WEBHOOK_SECRET, '•••') : '' });
}));

// Consultado pela página a cada poucos segundos enquanto o QR está na tela
router.get('/whatsapp/status.json', exigir('admin'), a(async (req, res) => {
  try { res.json(await uazapi.status()); } catch (e) { res.status(502).json({ erro: e.message }); }
}));

router.post('/whatsapp/conectar', exigirDono, a(async (req, res) => {
  try {
    // Garante que as mensagens cheguem ao sistema antes de conectar
    if (env.APP_URL && env.WEBHOOK_SECRET) await uazapi.configurarWebhook(urlWebhook());
    const s = await uazapi.conectar(req.body.telefone || '');
    res.json(s);
  } catch (e) {
    res.status(502).json({ erro: e.message });
  }
}));

router.post('/whatsapp/desconectar', exigirDono, a(async (req, res) => {
  try { await uazapi.desconectar(); avisar(req, 'WhatsApp desconectado.'); } catch (e) { avisar(req, 'Não foi possível desconectar: ' + e.message, 'erro'); }
  res.redirect('/whatsapp');
}));

router.post('/whatsapp/webhook', exigirDono, a(async (req, res) => {
  try { await uazapi.configurarWebhook(urlWebhook()); avisar(req, 'Recebimento de mensagens configurado.'); } catch (e) { avisar(req, 'Falha ao configurar: ' + e.message, 'erro'); }
  res.redirect('/whatsapp');
}));

router.get('/whatsapp/grupos', exigir('admin'), a(async (req, res) => {
  let grupos = [];
  let erro = null;
  try { grupos = await uazapi.listarGrupos(); } catch (e) { erro = e.message; }
  const cfg = await getConfig();
  res.render('grupos', { titulo: 'Grupos', grupos, erro, atual: cfg.grupo_jid, manutencao: cfg.grupo_manutencao_jid });
}));

router.post('/whatsapp/grupos', exigir('admin'), a(async (req, res) => {
  await setConfig({ grupo_jid: req.body.jid || '', grupo_nome: req.body.nome || '' });
  avisar(req, req.body.jid ? `O assistente passa a ler o grupo "${req.body.nome}".` : 'Leitura do grupo desligada.');
  res.redirect('/whatsapp');
}));

// Grupo da equipe de manutenção: recebe os chamados novos junto com o zelador
router.post('/whatsapp/grupo-manutencao', exigir('admin'), a(async (req, res) => {
  const cfg = await getConfig();
  if (req.body.jid && req.body.jid === cfg.grupo_jid) { avisar(req, 'Esse é o grupo dos moradores. Escolha o grupo da equipe de manutenção.', 'erro'); return res.redirect('/whatsapp/grupos'); }
  await setConfig({ grupo_manutencao_jid: req.body.jid || '', grupo_manutencao_nome: req.body.nome || '' });
  avisar(req, req.body.jid ? `Os chamados novos também vão para o grupo "${req.body.nome}".` : 'Os chamados deixaram de ir para o grupo da manutenção.');
  res.redirect('/whatsapp');
}));

module.exports = router;
