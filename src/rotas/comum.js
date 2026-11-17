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

const PAGINA_INICIAL = { admin: '/', zelador: '/chamados', portaria: '/reclamacoes', conselho: '/relatorio' };

module.exports = { a, exigir, avisar, PAGINA_INICIAL };
