const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { dbGlobal: db, ok, contar, setConfig } = require('../db');
const { noCondominio } = require('../contexto');
const { a, avisar, iniciarSessao, PAGINA_INICIAL } = require('./comum');

// Tentativas de login por IP (proteção simples contra força bruta)
const tentativas = new Map();

router.get('/login', a(async (req, res) => {
  if (req.session.usuario) return res.redirect(PAGINA_INICIAL[req.session.usuario.perfil]);
  if ((await contar('usuarios')) === 0) return res.redirect('/configurar');
  res.render('login', { titulo: 'Entrar', erro: null, email: '' });
}));

router.post('/login', a(async (req, res) => {
  const ip = req.ip;
  const t = tentativas.get(ip) || { n: 0, ate: 0 };
  if (t.ate > Date.now()) return res.render('login', { titulo: 'Entrar', erro: 'Muitas tentativas. Aguarde 10 minutos.', email: '' });

  const email = String(req.body.email || '').trim().toLowerCase();
  const [u] = ok(await db.from('usuarios').select('*').eq('email', email).eq('ativo', true).limit(1));
  if (!u || !(await bcrypt.compare(String(req.body.senha || ''), u.senha_hash))) {
    t.n += 1;
    if (t.n >= 8) { t.ate = Date.now() + 10 * 60000; t.n = 0; }
    tentativas.set(ip, t);
    return res.render('login', { titulo: 'Entrar', erro: 'E-mail ou senha incorretos.', email });
  }
  tentativas.delete(ip);
  iniciarSessao(req, u);
  res.redirect(PAGINA_INICIAL[u.perfil]);
}));

router.post('/sair', (req, res) => { req.session = null; res.redirect('/login'); });

// Primeiro acesso: cria o administrador e o nome do prédio. Só funciona com o banco vazio.
router.get('/configurar', a(async (req, res) => {
  if ((await contar('usuarios')) > 0) return res.redirect('/login');
  res.render('configurar', { titulo: 'Primeiro acesso', erro: null });
}));

router.post('/configurar', a(async (req, res) => {
  if ((await contar('usuarios')) > 0) return res.redirect('/login');
  const { nome, email, senha, nome_predio } = req.body;
  if (!nome || !email || !senha || senha.length < 8 || !nome_predio) {
    return res.render('configurar', { titulo: 'Primeiro acesso', erro: 'Preencha tudo. A senha precisa de pelo menos 8 caracteres.' });
  }
  // Primeiro condomínio e o responsável pela plataforma ("dono")
  const cond = ok(await db.from('condominios').insert({ nome: nome_predio.trim() }).select('id').single());
  const u = ok(await db.from('usuarios').insert({
    nome: nome.trim(), email: email.trim().toLowerCase(), senha_hash: await bcrypt.hash(senha, 10), perfil: 'admin', dono: true, condominio_atual: cond.id,
  }).select().single());
  ok(await db.from('usuario_condominios').insert({ usuario_id: u.id, condominio_id: cond.id }));
  await noCondominio(cond.id, () => setConfig({ nome_predio: nome_predio.trim(), nome_assistente: `Assistente do ${nome_predio.trim()}` }));
  iniciarSessao(req, u);
  avisar(req, 'Tudo pronto. Agora conecte o WhatsApp do prédio.');
  res.redirect('/whatsapp');
}));

module.exports = router;
