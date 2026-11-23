// Utilidades das rotas do painel
const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Exige login e, se informado, um dos perfis
const exigir = (...perfis) => (req, res, next) => {
  const u = req.session.usuario;
  if (!u) return res.redirect('/login');
  if (perfis.length && !perfis.includes(u.perfil)) {
    return res.status(403).render('erro', { titulo: 'Sem acesso', mensagem: 'Seu perfil não tem acesso a esta área.' });
  }
  next();
};

const avisar = (req, texto, tipo = 'ok') => { req.session.aviso = { texto, tipo }; };

// Só o "dono" da plataforma (quem cria condomínios e cuida do número de WhatsApp)
const exigirDono = (req, res, next) => {
  if (!req.session.usuario) return res.redirect('/login');
  if (!req.session.usuario.dono) return res.status(403).render('erro', { titulo: 'Sem acesso', mensagem: 'Só o responsável pela plataforma pode fazer isso.' });
  next();
};

// Começa a sessão de quem entrou (senha ou link). O condomínio é escolhido no próximo passo (server.js).
function iniciarSessao(req, u) {
  req.session.usuario = { id: u.id, nome: u.nome, perfil: u.perfil === 'sindico' ? 'admin' : u.perfil, cargo: u.perfil, dono: Boolean(u.dono) };
  req.session.condominioId = u.condominio_atual || null;
  req.session.condominios = null;
}

const PAGINA_INICIAL = { admin: '/', sindico: '/', zelador: '/z', portaria: '/encomendas', conselho: '/relatorio' };

module.exports = { a, exigir, exigirDono, avisar, iniciarSessao, PAGINA_INICIAL };
