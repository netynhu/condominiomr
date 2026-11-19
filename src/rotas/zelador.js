// App do zelador no celular: lista simples, Começar/Terminei com foto e "Avisar problema"
const path = require('path');
const router = require('express').Router();
const { db, ok } = require('../db');
const sv = require('../servicos');
const { completar } = require('../ia');
const { salvarFoto, lerFoto, dataUrlParaBuffer } = require('../fotos');
const { a, exigir, PAGINA_INICIAL } = require('./comum');

const NOVENTA_DIAS = 90 * 86400000;
const equipe = exigir('admin', 'zelador');

// Locais que aparecem como botões grandes em "Avisar problema"
const LOCAIS = [
  ['elevador', 'Elevador'], ['portao', 'Portão'], ['garagem', 'Garagem'], ['luz', 'Iluminação'],
  ['hall', 'Hall e escadas'], ['lazer', 'Piscina e lazer'], ['limpeza', 'Limpeza'], ['agua', 'Água e vazamento'], ['outro', 'Outro'],
];

// ---------- Entrar pelo link enviado no WhatsApp ----------
router.get('/entrar/:token', a(async (req, res) => {
  const token = String(req.params.token || '');
  const [u] = token.length >= 32 ? ok(await db.from('usuarios').select('id, nome, perfil, ativo').eq('token_acesso', token).limit(1)) : [];
  if (!u || !u.ativo) return res.status(403).render('erro', { titulo: 'Link inválido', mensagem: 'Este link de acesso não vale mais. Peça um novo ao síndico.' });
  req.session.usuario = { id: u.id, nome: u.nome, perfil: u.perfil === 'sindico' ? 'admin' : u.perfil, cargo: u.perfil };
  req.sessionOptions.maxAge = NOVENTA_DIAS; // fica conectado no celular
  res.redirect(u.perfil === 'zelador' ? '/z' : PAGINA_INICIAL[u.perfil]);
}));

// ---------- Instalação como app (tela inicial do celular) ----------
router.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: `Zelador · ${res.locals.cfg.nome_predio}`,
    short_name: 'Zelador',
    start_url: '/z',
    scope: '/',
    display: 'standalone',
    background_color: '#F5F7F8',
    theme_color: '#0C1B1F',
    icons: [{ src: '/static/icone.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  });
});
router.get('/sw.js', (req, res) => res.type('text/javascript').sendFile(path.join(__dirname, '..', '..', 'public', 'sw.js')));

// ---------- Lista ----------
router.get('/z', equipe, a(async (req, res) => {
  const aba = ['fazer', 'fazendo', 'feito'].includes(req.query.aba) ? req.query.aba : 'fazer';
  const desde = new Date(Date.now() - 7 * 86400000).toISOString();
  const base = () => db.from('chamados').select('*').neq('categoria', 'administracao');
  const [fazer, fazendo, feito] = await Promise.all([
    base().eq('status', 'aberto').order('criado_em').limit(100).then(ok),
    base().eq('status', 'em_andamento').order('atualizado_em').limit(100).then(ok),
    base().eq('status', 'resolvido').gte('resolvido_em', desde).order('resolvido_em', { ascending: false }).limit(50).then(ok),
  ]);
  const ordem = { urgente: 0, alta: 1, normal: 2, baixa: 3 };
  for (const l of [fazer, fazendo]) l.sort((x, y) => ordem[x.prioridade] - ordem[y.prioridade] || new Date(x.criado_em) - new Date(y.criado_em));
  res.render('z/lista', { titulo: 'Chamados', aba, fazer, fazendo, feito, lista: { fazer, fazendo, feito }[aba] });
}));

// ---------- Avisar problema ----------
router.get('/z/novo', equipe, (req, res) => res.render('z/novo', { titulo: 'Avisar problema', LOCAIS }));

router.post('/z/novo', equipe, express6mb(), a(async (req, res) => {
  const chave = String(req.body.local || 'outro');
  const local = (LOCAIS.find(([k]) => k === chave) || LOCAIS[LOCAIS.length - 1])[1];
  const texto = String(req.body.texto || '').trim().slice(0, 1000);
  let foto = null;
  const img = dataUrlParaBuffer(req.body.foto);
  if (img) foto = await salvarFoto(img.buffer, img.mime);

  // A IA escreve o título e define a prioridade; se falhar, segue com o básico
  let titulo = texto ? `${local}: ${texto.slice(0, 70)}` : `Problema em ${local.toLowerCase()}`;
  let prioridade = 'normal';
  let categoria = chave === 'limpeza' ? 'limpeza' : 'manutencao';
  try {
    const r = await completar(
      'Você classifica chamados de manutenção de condomínio. Responda só JSON: {"titulo": "até 60 caracteres, claro", "prioridade": "baixa|normal|alta|urgente", "categoria": "manutencao|limpeza|seguranca"}. Urgente só com risco a pessoas, pessoa presa no elevador, vazamento grande ou falta total de água/luz.',
      `Local: ${local}\nRelato do zelador: ${texto || '(sem texto)'}${foto ? '\n(tem foto)' : ''}`,
      { maxTokens: 120, temperatura: 0 },
    );
    const j = JSON.parse(r.replace(/```json|```/g, '').trim());
    if (j.titulo) titulo = String(j.titulo).slice(0, 90);
    if (['baixa', 'normal', 'alta', 'urgente'].includes(j.prioridade)) prioridade = j.prioridade;
    if (['manutencao', 'limpeza', 'seguranca'].includes(j.categoria)) categoria = j.categoria;
  } catch (e) { console.error('[zelador] classificação', e.message); }

  const ch = await sv.abrirChamado({
    titulo, descricao: texto || null, local, prioridade, categoria, origem: 'zelador', usuarioNome: req.session.usuario.nome, foto,
  });
  res.json({ ok: true, id: ch.id });
}));

// ---------- Detalhe ----------
router.get('/z/:id', equipe, a(async (req, res) => {
  const c = ok(await db.from('chamados').select('*, morador:moradores(nome, unidade:unidades(bloco, numero))').eq('id', req.params.id).maybeSingle());
  if (!c || c.categoria === 'administracao') return res.redirect('/z');
  res.render('z/chamado', { titulo: `Chamado ${c.id}`, c });
}));

router.post('/z/:id/comecar', equipe, a(async (req, res) => {
  await sv.mudarStatusChamado(req.params.id, 'em_andamento', '', req.session.usuario.nome);
  res.redirect(`/z/${req.params.id}`);
}));

router.post('/z/:id/terminar', equipe, express6mb(), a(async (req, res) => {
  let foto = null;
  const img = dataUrlParaBuffer(req.body.foto);
  if (img) foto = await salvarFoto(img.buffer, img.mime, 'conclusoes');
  await sv.mudarStatusChamado(req.params.id, 'resolvido', String(req.body.observacao || '').trim().slice(0, 500), req.session.usuario.nome, foto);
  res.json({ ok: true });
}));

// ---------- Fotos (só para quem está logado) ----------
router.get('/foto/:id/:qual', exigir('admin', 'zelador', 'conselho'), a(async (req, res) => {
  const c = ok(await db.from('chamados').select('*').eq('id', req.params.id).maybeSingle());
  const caminho = { conclusao: c?.foto_conclusao, video: c?.video, problema: c?.foto }[req.params.qual];
  if (!caminho) return res.sendStatus(404);
  const { buffer, mime } = await lerFoto(caminho);
  res.set({ 'Cache-Control': 'private, max-age=86400', 'Accept-Ranges': 'bytes', 'Content-Type': mime });
  // O iPhone só toca vídeo se o servidor entregar por partes (Range)
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const total = buffer.length;
    const ini = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
    const fim = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (ini >= total || ini > fim) return res.status(416).set('Content-Range', `bytes */${total}`).end();
    return res.status(206).set('Content-Range', `bytes ${ini}-${fim}/${total}`).send(buffer.subarray(ini, fim + 1));
  }
  res.send(buffer);
}));

function express6mb() {
  return require('express').json({ limit: '8mb' });
}

module.exports = router;
