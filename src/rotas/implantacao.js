// Implantação de um condomínio: a ficha (link sem senha) e a lista "Pronto para ativar" no painel
const router = require('express').Router();
const { db, getConfig, setConfig } = require('../db');
const { noCondominio } = require('../contexto');
const { env } = require('../config');
const imp = require('../implantacao');
const { a, exigir, avisar } = require('./comum');

// ---------- Painel ----------
router.get('/implantacao', exigir('admin'), a(async (req, res) => {
  const t = await imp.token();
  const cfg = await getConfig();
  const [feitas, lista] = await Promise.all([imp.partesFeitas(), imp.checklist()]);
  res.render('implantacao', {
    titulo: 'Implantação', link: `${env.APP_URL}/ficha/${t}`, feitas, partes: imp.PARTES, lista,
    concluida: cfg.ficha_concluida_em || '', atualizada: cfg.ficha_atualizada_em || '',
  });
}));

router.post('/implantacao/equipe', exigir('admin'), a(async (req, res) => {
  const criados = await imp.criarEquipeDaFicha();
  avisar(req, criados.length
    ? `Acessos criados: ${criados.join(', ')}. Em Equipe e acessos, defina a senha de quem entra com e-mail (síndico, administração e portaria) e envie o link para a manutenção.`
    : 'A equipe da ficha já estava cadastrada.');
  res.redirect('/implantacao');
}));

router.post('/implantacao/novo-link', exigir('admin'), a(async (req, res) => {
  await setConfig({ ficha_token: '' });
  await imp.token();
  avisar(req, 'Novo link da ficha criado. O link antigo deixou de funcionar.');
  res.redirect('/implantacao');
}));

// ---------- Ficha (link sem senha) ----------
async function comFicha(req, res, fn) {
  const id = await imp.condominioDoToken(req.params.token);
  if (!id) return res.status(404).render('erro', { titulo: 'Link inválido', mensagem: 'Este link da ficha de implantação não existe mais. Peça um novo a quem enviou.' });
  return noCondominio(id, () => fn());
}

router.get('/ficha/:token', a(async (req, res) => comFicha(req, res, async () => {
  const cfg = await getConfig();
  const [feitas, manut, espacos] = await Promise.all([
    imp.partesFeitas(),
    Promise.resolve(imp.json(cfg.ficha_manutencoes, [])),
    db.from('espacos').select('nome, itens').eq('ativo', true).then((r) => (r.error ? [] : r.data)),
  ]);
  let numero = '';
  try { numero = await require('../uazapi').numeroDaInstancia(); } catch { /* sem conexão */ }
  res.render('ficha', {
    titulo: 'Ficha de implantação', token: req.params.token, cfg, feitas, partes: imp.PARTES, aberta: req.query.parte || '',
    equipe: imp.json(cfg.ficha_equipe, []), manut, sugeridas: imp.MANUTENCOES_SUGERIDAS, espacos, numero, salvo: req.query.salvo || '',
  });
})));

router.post('/ficha/:token/concluir', a(async (req, res) => comFicha(req, res, async () => {
  await setConfig({ ficha_concluida_em: new Date().toISOString() });
  res.redirect(`/ficha/${req.params.token}?salvo=concluida`);
})));

router.post('/ficha/:token/:parte', a(async (req, res) => comFicha(req, res, async () => {
  const parte = imp.PARTES.find((p) => p.id === req.params.parte);
  if (!parte) return res.redirect(`/ficha/${req.params.token}`);
  await imp.salvarParte(parte.id, req.body);
  const proxima = imp.PARTES[imp.PARTES.indexOf(parte) + 1];
  res.redirect(`/ficha/${req.params.token}?salvo=${parte.id}${proxima ? `&parte=${proxima.id}` : ''}#${proxima ? proxima.id : 'fim'}`);
})));

module.exports = router;
