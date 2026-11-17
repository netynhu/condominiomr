const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db, ok, getConfig, setConfig } = require('../db');
const { normalizarTelefone } = require('../util');
const { a, exigir, avisar } = require('./comum');

const admin = exigir('admin');

async function unidadeId(bloco, numero) {
  bloco = String(bloco || '').trim().toUpperCase();
  numero = String(numero || '').trim();
  if (!numero) return null;
  const [u] = ok(await db.from('unidades').select('id').eq('bloco', bloco).eq('numero', numero).limit(1));
  if (u) return u.id;
  return ok(await db.from('unidades').insert({ bloco, numero }).select('id').single()).id;
}

// ---------- Moradores ----------
router.get('/moradores', admin, a(async (req, res) => {
  const busca = String(req.query.q || '').trim().toLowerCase();
  const [moradores, pendentes] = await Promise.all([
    db.from('moradores').select('*, unidade:unidades(*)').order('nome').then(ok),
    db.from('contatos_pendentes').select('*').order('atualizado_em', { ascending: false }).then(ok),
  ]);
  const lista = busca
    ? moradores.filter((m) => [m.nome, m.telefone, m.email, m.unidade?.numero, m.unidade?.bloco].join(' ').toLowerCase().includes(busca))
    : moradores;
  lista.sort((x, y) => `${x.unidade?.bloco || ''}${(x.unidade?.numero || '').padStart(6, '0')}`.localeCompare(`${y.unidade?.bloco || ''}${(y.unidade?.numero || '').padStart(6, '0')}`));
  res.render('moradores', { titulo: 'Moradores', lista, pendentes, busca, total: moradores.length, novo: { telefone: req.query.telefone || '', nome: req.query.nome || '' } });
}));

router.post('/moradores', admin, a(async (req, res) => {
  const b = req.body;
  const telefone = normalizarTelefone(b.telefone);
  if (!b.nome || telefone.length < 12) { avisar(req, 'Informe nome e telefone com DDD.', 'erro'); return res.redirect('/moradores'); }
  const r = await db.from('moradores').insert({
    nome: b.nome.trim(), telefone, email: b.email || null, tipo: b.tipo || 'morador',
    unidade_id: await unidadeId(b.bloco, b.numero),
  });
  if (r.error) { avisar(req, r.error.code === '23505' ? 'Este telefone já está cadastrado.' : r.error.message, 'erro'); return res.redirect('/moradores'); }
  await db.from('contatos_pendentes').delete().eq('telefone', telefone);
  avisar(req, `${b.nome} cadastrado. O assistente já reconhece este número.`);
  res.redirect('/moradores');
}));

// Importação: uma linha por morador -> nome; telefone; bloco; apartamento; e-mail
router.post('/moradores/importar', admin, a(async (req, res) => {
  const linhas = String(req.body.lista || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let criados = 0; const erros = [];
  for (const [i, linha] of linhas.entries()) {
    const [nome, tel, bloco, numero, email] = linha.split(/[;\t]/).map((x) => (x || '').trim());
    const telefone = normalizarTelefone(tel);
    if (!nome || telefone.length < 12) { erros.push(`linha ${i + 1}`); continue; }
    const r = await db.from('moradores').upsert({ nome, telefone, email: email || null, unidade_id: await unidadeId(bloco, numero) }, { onConflict: 'telefone' });
    if (r.error) erros.push(`linha ${i + 1}`); else criados++;
  }
  avisar(req, `${criados} moradores importados.${erros.length ? ` Não importadas: ${erros.join(', ')}.` : ''}`, erros.length ? 'erro' : 'ok');
  res.redirect('/moradores');
}));

router.post('/pendentes/:tel/ignorar', admin, a(async (req, res) => {
  await db.from('contatos_pendentes').delete().eq('telefone', req.params.tel);
  res.redirect('/moradores');
}));

router.get('/moradores/:id', admin, a(async (req, res) => {
  const m = ok(await db.from('moradores').select('*, unidade:unidades(*)').eq('id', req.params.id).single());
  const [memoria, mensagens, chamados, grupo] = await Promise.all([
    db.from('memoria').select('*').eq('morador_id', m.id).order('criado_em', { ascending: false }).then(ok),
    db.from('mensagens').select('*').eq('morador_id', m.id).order('criado_em', { ascending: false }).limit(60).then(ok),
    db.from('chamados').select('*').eq('morador_id', m.id).order('criado_em', { ascending: false }).limit(20).then(ok),
    db.from('grupo_mensagens').select('*').eq('morador_id', m.id).order('criado_em', { ascending: false }).limit(20).then(ok),
  ]);
  res.render('morador', { titulo: m.nome, m, memoria, mensagens: mensagens.reverse(), chamados, grupo });
}));

router.post('/moradores/:id', admin, a(async (req, res) => {
  const b = req.body;
  const r = await db.from('moradores').update({
    nome: b.nome, telefone: normalizarTelefone(b.telefone), email: b.email || null, tipo: b.tipo,
    ativo: b.ativo === 'on', aceita_avisos: b.aceita_avisos === 'on', resumo_perfil: b.resumo_perfil || null,
    unidade_id: await unidadeId(b.bloco, b.numero),
  }).eq('id', req.params.id);
  avisar(req, r.error ? r.error.message : 'Dados salvos.', r.error ? 'erro' : 'ok');
  res.redirect(`/moradores/${req.params.id}`);
}));

router.post('/moradores/:id/excluir', admin, a(async (req, res) => {
  ok(await db.from('moradores').delete().eq('id', req.params.id));
  avisar(req, 'Morador excluído, com a memória e as mensagens dele.');
  res.redirect('/moradores');
}));

router.post('/moradores/:id/memoria', admin, a(async (req, res) => {
  if (req.body.fato) ok(await db.from('memoria').insert({ morador_id: req.params.id, fato: req.body.fato.slice(0, 300), origem: 'administracao' }));
  res.redirect(`/moradores/${req.params.id}#memoria`);
}));

router.post('/memoria/:id/excluir', admin, a(async (req, res) => {
  const f = ok(await db.from('memoria').delete().eq('id', req.params.id).select('morador_id').single());
  res.redirect(`/moradores/${f.morador_id}#memoria`);
}));

// ---------- Documentos que o assistente consulta ----------
router.get('/documentos', admin, a(async (req, res) => {
  const docs = ok(await db.from('documentos').select('*').order('criado_em'));
  const editar = req.query.editar ? docs.find((d) => d.id === req.query.editar) : null;
  res.render('documentos', { titulo: 'Documentos do prédio', docs, editar });
}));

router.post('/documentos', admin, a(async (req, res) => {
  const { id, titulo, conteudo } = req.body;
  if (!titulo || !conteudo) { avisar(req, 'Preencha título e conteúdo.', 'erro'); return res.redirect('/documentos'); }
  if (id) ok(await db.from('documentos').update({ titulo, conteudo, ativo: req.body.ativo === 'on' }).eq('id', id));
  else ok(await db.from('documentos').insert({ titulo, conteudo }));
  avisar(req, 'Documento salvo. O assistente já usa o novo texto.');
  res.redirect('/documentos');
}));

router.post('/documentos/:id/excluir', admin, a(async (req, res) => {
  ok(await db.from('documentos').delete().eq('id', req.params.id));
  res.redirect('/documentos');
}));

// ---------- Equipe (usuários do painel) ----------
router.get('/equipe', admin, a(async (req, res) => {
  const usuarios = ok(await db.from('usuarios').select('id, nome, email, perfil, telefone, ativo, criado_em').order('nome'));
  res.render('equipe', { titulo: 'Equipe e acessos', usuarios });
}));

router.post('/equipe', admin, a(async (req, res) => {
  const { id, nome, email, perfil, senha, telefone } = req.body;
  const dados = { nome, email: String(email || '').trim().toLowerCase(), perfil, telefone: normalizarTelefone(telefone) || null };
  if (id) {
    dados.ativo = req.body.ativo === 'on';
    if (senha) dados.senha_hash = await bcrypt.hash(senha, 10);
    if (id === req.session.usuario.id && (!dados.ativo || perfil !== 'admin')) { avisar(req, 'Você não pode tirar o seu próprio acesso de administrador.', 'erro'); return res.redirect('/equipe'); }
    ok(await db.from('usuarios').update(dados).eq('id', id));
  } else {
    if (!senha || senha.length < 8) { avisar(req, 'A senha precisa de pelo menos 8 caracteres.', 'erro'); return res.redirect('/equipe'); }
    const r = await db.from('usuarios').insert({ ...dados, senha_hash: await bcrypt.hash(senha, 10) });
    if (r.error) { avisar(req, r.error.code === '23505' ? 'Este e-mail já tem acesso.' : r.error.message, 'erro'); return res.redirect('/equipe'); }
  }
  avisar(req, 'Acesso salvo.');
  res.redirect('/equipe');
}));

// ---------- Configurações do prédio ----------
router.get('/configuracoes', admin, a(async (req, res) => {
  res.render('configuracoes', { titulo: 'Configurações', c: await getConfig() });
}));

router.post('/configuracoes', admin, a(async (req, res) => {
  const campos = ['nome_predio', 'nome_assistente', 'telefone_sindico', 'telefone_zelador', 'telefone_portaria', 'horario_administracao', 'instrucoes_extras'];
  const v = {};
  for (const c of campos) v[c] = c.startsWith('telefone_') ? normalizarTelefone(req.body[c]) : (req.body[c] || '').trim();
  await setConfig(v);
  avisar(req, 'Configurações salvas.');
  res.redirect('/configuracoes');
}));

module.exports = router;
