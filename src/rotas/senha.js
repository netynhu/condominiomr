// Senhas: cada pessoa troca a própria senha no painel ("Minha senha") e, se esquecer,
// recebe um link no WhatsApp cadastrado na Equipe para criar uma nova.
// O link é assinado (não fica guardado no banco), vale 30 minutos e uma vez só:
// depois que a senha muda, o mesmo link deixa de funcionar.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { env } = require('../config');
const { dbGlobal: db, ok } = require('../db');
const { a, exigir, avisar } = require('./comum');

const VALIDADE_MS = 30 * 60000;
const segredo = () => env.SESSION_SECRET || 'defina-SESSION_SECRET';
const assinar = (texto) => crypto.createHmac('sha256', segredo()).update(texto).digest('base64url');

// Token = id.validade.assinatura (a assinatura inclui o hash da senha atual: trocou a senha, o link morre)
function criarToken(u) {
  const ate = Date.now() + VALIDADE_MS;
  return `${u.id}.${ate}.${assinar(`${u.id}.${ate}.${u.senha_hash}`)}`;
}

async function lerToken(token) {
  const [id, ate, assinatura] = String(token || '').split('.');
  if (!id || !ate || !assinatura || Number(ate) < Date.now()) return null;
  const [u] = ok(await db.from('usuarios').select('id, nome, email, telefone, senha_hash, ativo').eq('id', id).limit(1));
  if (!u || !u.ativo) return null;
  const certo = assinar(`${u.id}.${ate}.${u.senha_hash}`);
  if (certo.length !== assinatura.length || !crypto.timingSafeEqual(Buffer.from(certo), Buffer.from(assinatura))) return null;
  return u;
}

function senhaValida(nova, confirmar) {
  if (!nova || nova.length < 8) return 'A senha precisa de pelo menos 8 caracteres.';
  if (nova !== confirmar) return 'As duas senhas não são iguais.';
  return null;
}

async function avisarTroca(u) {
  if (!u.telefone) return;
  try {
    await require('../servicos').enviar(u.telefone, `Olá, ${u.nome.split(' ')[0]}! A senha do seu acesso ao painel do condomínio foi alterada agora. Se não foi você, fale com a administração.`);
  } catch (e) { console.error('[senha] aviso', e.message); }
}

// ---------- Esqueci minha senha ----------
const pedidosPorIp = new Map();     // ip -> [horários]
const ultimoPorUsuario = new Map(); // id -> horário

router.get('/esqueci', (req, res) => res.render('senha', { titulo: 'Esqueci minha senha', modo: 'pedir', erro: null, ok: null, email: '' }));

router.post('/esqueci', a(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const agora = Date.now();
  const lista = (pedidosPorIp.get(req.ip) || []).filter((t) => agora - t < 15 * 60000);
  if (lista.length >= 5) return res.render('senha', { titulo: 'Esqueci minha senha', modo: 'pedir', erro: 'Muitos pedidos seguidos. Aguarde 15 minutos.', ok: null, email });
  lista.push(agora);
  pedidosPorIp.set(req.ip, lista);

  const [u] = email ? ok(await db.from('usuarios').select('id, nome, telefone, senha_hash, ativo').eq('email', email).eq('ativo', true).limit(1)) : [];
  // Só envia se o e-mail existe, tem WhatsApp e não pediu há menos de 2 minutos. A resposta é sempre a mesma,
  // para ninguém descobrir pela tela quais e-mails estão cadastrados.
  if (u?.telefone && agora - (ultimoPorUsuario.get(u.id) || 0) > 2 * 60000) {
    ultimoPorUsuario.set(u.id, agora);
    const link = `${env.APP_URL}/nova-senha/${criarToken(u)}`;
    try {
      await require('../servicos').enviarBotoes(u.telefone,
        `Olá, ${u.nome.split(' ')[0]}! Recebemos um pedido para criar uma nova senha do painel do condomínio.\n\nToque no botão abaixo. O link vale 30 minutos e funciona uma vez só. Se não foi você, ignore esta mensagem: sua senha continua a mesma.`,
        [`🔑 Criar nova senha|${link}`], { planoB: `👉 ${link}` });
    } catch (e) { console.error('[senha] envio', e.message); }
  }
  res.render('senha', { titulo: 'Esqueci minha senha', modo: 'pedir', erro: null, email: '',
    ok: 'Se este e-mail estiver cadastrado com um WhatsApp, você vai receber agora o link para criar a nova senha. Ele vale 30 minutos. Não recebeu? Fale com a administração do condomínio.' });
}));

router.get('/nova-senha/:token', a(async (req, res) => {
  const u = await lerToken(req.params.token);
  res.render('senha', { titulo: 'Nova senha', modo: u ? 'nova' : 'expirado', erro: null, ok: null, email: '', nome: u?.nome || '' });
}));

router.post('/nova-senha/:token', a(async (req, res) => {
  const u = await lerToken(req.params.token);
  if (!u) return res.render('senha', { titulo: 'Nova senha', modo: 'expirado', erro: null, ok: null, email: '' });
  const erro = senhaValida(String(req.body.senha || ''), String(req.body.confirmar || ''));
  if (erro) return res.render('senha', { titulo: 'Nova senha', modo: 'nova', erro, ok: null, email: '', nome: u.nome });
  ok(await db.from('usuarios').update({ senha_hash: await bcrypt.hash(String(req.body.senha), 10) }).eq('id', u.id));
  await avisarTroca(u);
  res.render('login', { titulo: 'Entrar', erro: null, email: u.email || '', sucesso: 'Senha criada. Entre com o seu e-mail e a nova senha.' });
}));

// ---------- Minha senha (logado) ----------
router.get('/minha-senha', exigir(), (req, res) => res.render('minha_senha', { titulo: 'Minha senha', erro: null }));

router.post('/minha-senha', exigir(), a(async (req, res) => {
  const [u] = ok(await db.from('usuarios').select('id, nome, telefone, senha_hash').eq('id', req.session.usuario.id).limit(1));
  if (!u || !(await bcrypt.compare(String(req.body.atual || ''), u.senha_hash))) {
    return res.render('minha_senha', { titulo: 'Minha senha', erro: 'A senha atual não confere.' });
  }
  const erro = senhaValida(String(req.body.senha || ''), String(req.body.confirmar || ''));
  if (erro) return res.render('minha_senha', { titulo: 'Minha senha', erro });
  ok(await db.from('usuarios').update({ senha_hash: await bcrypt.hash(String(req.body.senha), 10) }).eq('id', u.id));
  await avisarTroca(u);
  avisar(req, 'Senha alterada.');
  res.redirect('/minha-senha');
}));

module.exports = router;
module.exports._teste = { criarToken, lerToken };
