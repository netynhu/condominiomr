// Vários condomínios: trocar o condomínio da vez no painel e (para o dono da plataforma) criar e editar condomínios
const router = require('express').Router();
const { dbGlobal, ok, setConfig } = require('../db');
const { noCondominio } = require('../contexto');
const { a, exigir, exigirDono, avisar } = require('./comum');

// Troca o condomínio da vez (seletor do topo). Só entre os condomínios que a pessoa atende.
router.post('/condominio/trocar', exigir(), a(async (req, res) => {
  const lista = req.session.condominios || [];
  const alvo = lista.find((c) => c.id === req.body.id);
  if (alvo) {
    req.session.condominioId = alvo.id;
    await dbGlobal.from('usuarios').update({ condominio_atual: alvo.id }).eq('id', req.session.usuario.id);
    avisar(req, `Agora você está no ${alvo.nome}.`);
  }
  const volta = String(req.body.voltar || '/');
  // Páginas com id de outro condomínio (ex.: /chamados/123) não fazem sentido no novo: volta para a lista
  res.redirect(/^\/[a-z-]+$/.test(volta) || volta === '/' ? volta : '/' + (volta.split('/')[1] || ''));
}));

router.get('/condominios', exigirDono, a(async (req, res) => {
  const lista = ok(await dbGlobal.from('condominios').select('id, nome, ativo, criado_em').order('nome'));
  const [moradores, equipe] = await Promise.all([
    dbGlobal.from('moradores').select('condominio_id').eq('ativo', true).then(ok),
    dbGlobal.from('usuario_condominios').select('condominio_id').then(ok),
  ]);
  const conta = (linhas, id) => linhas.filter((l) => l.condominio_id === id).length;
  res.render('condominios', {
    titulo: 'Condomínios',
    lista: lista.map((c) => ({ ...c, moradores: conta(moradores, c.id), equipe: conta(equipe, c.id) })),
  });
}));

router.post('/condominios', exigirDono, a(async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  if (nome.length < 3) { avisar(req, 'Informe o nome do condomínio.', 'erro'); return res.redirect('/condominios'); }
  const c = ok(await dbGlobal.from('condominios').insert({ nome }).select('id, nome').single());
  // Quem criou já faz parte da equipe do novo condomínio e passa a trabalhar nele
  ok(await dbGlobal.from('usuario_condominios').upsert({ usuario_id: req.session.usuario.id, condominio_id: c.id }, { onConflict: 'usuario_id,condominio_id' }));
  await noCondominio(c.id, () => setConfig({ nome_predio: nome, nome_assistente: 'Assistente do condomínio' }));
  req.session.condominioId = c.id;
  req.session.condominios = null;
  await dbGlobal.from('usuarios').update({ condominio_atual: c.id }).eq('id', req.session.usuario.id);
  avisar(req, `${nome} criado. Agora configure: documentos, ajustes do prédio, equipe e o grupo dos moradores.`);
  res.redirect('/configuracoes');
}));

router.post('/condominios/:id', exigirDono, a(async (req, res) => {
  const dados = {};
  if (req.body.nome) dados.nome = String(req.body.nome).trim();
  dados.ativo = req.body.ativo === 'on';
  ok(await dbGlobal.from('condominios').update(dados).eq('id', req.params.id));
  if (dados.nome) await noCondominio(req.params.id, () => setConfig({ nome_predio: dados.nome }));
  req.session.condominios = null;
  avisar(req, dados.ativo ? 'Condomínio atualizado.' : 'Condomínio desativado: o assistente deixa de atender os moradores dele.');
  res.redirect('/condominios');
}));

module.exports = router;
