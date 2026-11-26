const router = require('express').Router();
const { env } = require('../config');
const { setConfig, getConfig } = require('../db');
const uazapi = require('../uazapi');
const { a, exigir, exigirDono, exigirGestor, avisar } = require('./comum');

// { jid do grupo: nome do condomínio } dos grupos escolhidos por outros condomínios
async function gruposDeOutros(condominioId) {
  const { dbGlobal } = require('../db');
  const [linhas, conds] = await Promise.all([
    dbGlobal.from('config').select('condominio_id, valor').eq('chave', 'grupo_jid').neq('valor', ''),
    dbGlobal.from('condominios').select('id, nome'),
  ]);
  const mapa = {};
  for (const l of linhas.data || []) if (l.condominio_id !== condominioId) mapa[l.valor] = (conds.data || []).find((c) => c.id === l.condominio_id)?.nome || 'outro condomínio';
  return mapa;
}

const urlWebhook = () => `${env.APP_URL}/webhook/uazapi/${env.WEBHOOK_SECRET}`;

router.get('/whatsapp', exigirGestor, a(async (req, res) => {
  let status = null;
  let erro = null;
  try { status = await uazapi.status(); } catch (e) { erro = e.message; }
  res.render('whatsapp', { titulo: 'Conexão do WhatsApp', status, erro, webhook: env.APP_URL ? urlWebhook().replace(env.WEBHOOK_SECRET, '•••') : '' });
}));

// Consultado pela página a cada poucos segundos enquanto o QR está na tela
router.get('/whatsapp/status.json', exigirGestor, a(async (req, res) => {
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
  // Grupos que já são de outro condomínio (o mesmo número está em grupos de vários prédios)
  const outros = await gruposDeOutros(cfg.condominio_id);
  for (const g of grupos) g.deOutro = outros[g.jid] || null;
  res.render('grupos', { titulo: 'Grupo dos moradores', grupos, erro, atual: cfg.grupo_jid });
}));

router.post('/whatsapp/grupos', exigir('admin'), a(async (req, res) => {
  const cfg = await getConfig();
  const outros = await gruposDeOutros(cfg.condominio_id);
  if (req.body.jid && outros[req.body.jid]) { avisar(req, `Esse grupo já é o grupo dos moradores do ${outros[req.body.jid]}.`, 'erro'); return res.redirect('/whatsapp/grupos'); }
  await setConfig({ grupo_jid: req.body.jid || '', grupo_nome: req.body.nome || '' });
  avisar(req, req.body.jid ? `O assistente passa a ler o grupo "${req.body.nome}".` : 'Leitura do grupo desligada.');
  res.redirect('/whatsapp/grupos');
}));


module.exports = router;
