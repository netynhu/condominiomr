const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { env } = require('../config');
const { enviarBotoes } = require('../servicos');
const { db, ok, getConfig, setConfig } = require('../db');
const { normalizarTelefone } = require('../util');
const { a, exigir, avisar } = require('./comum');

const admin = exigir('admin');

const { unidadeId } = require('../servicos');

// ---------- Moradores ----------
router.get('/moradores', admin, a(async (req, res) => {
  const busca = String(req.query.q || '').trim().toLowerCase();
  const [moradores] = await Promise.all([
    db.from('moradores').select('*, unidade:unidades(*)').order('nome').then(ok),
  ]);
  const lista = busca
    ? moradores.filter((m) => [m.nome, m.telefone, m.email, m.unidade?.numero, m.unidade?.bloco, m.vaga && `vaga ${m.vaga}`].join(' ').toLowerCase().includes(busca))
    : moradores;
  lista.sort((x, y) => `${x.unidade?.bloco || ''}${(x.unidade?.numero || '').padStart(6, '0')}`.localeCompare(`${y.unidade?.bloco || ''}${(y.unidade?.numero || '').padStart(6, '0')}`));
  // Cadastros feitos pelo próprio morador (pelo grupo) que a administração ainda não conferiu
  const porUnidade = {};
  for (const m of moradores) if (m.unidade_id && m.ativo) porUnidade[m.unidade_id] = (porUnidade[m.unidade_id] || 0) + 1;
  const paraConferir = moradores.filter((m) => m.autocadastro && m.conferido === false)
    .sort((x, y) => new Date(y.criado_em) - new Date(x.criado_em))
    .map((m) => ({ ...m, naUnidade: porUnidade[m.unidade_id] || 0 }));
  const cfg = await getConfig();
  let linkCadastro = '';
  try { const n = await require('../uazapi').numeroDaInstancia(); if (n) linkCadastro = `https://wa.me/${n}?text=${encodeURIComponent('Quero me cadastrar')}`; } catch { /* sem conexão */ }
  res.render('moradores', {
    titulo: 'Moradores', lista, busca, total: moradores.length, paraConferir, linkCadastro, convite: textoConviteCadastro(cfg, linkCadastro),
    autocadastro: cfg.autocadastro !== '0', temGrupo: Boolean(cfg.grupo_jid), grupoNome: cfg.grupo_nome,
    novo: { telefone: req.query.telefone || '', nome: req.query.nome || '' },
  });
}));

function textoConviteCadastro(cfg, link) {
  return `📝 *Cadastro no assistente do ${cfg.nome_predio}*\n\nO prédio agora tem um assistente no WhatsApp. Com ele você abre chamados de manutenção (pode mandar foto e áudio), tira dúvidas sobre as regras do prédio e recebe os avisos da administração.\n\nPara se cadastrar, toque no link abaixo e envie a mensagem que já vem pronta:\n👉 ${link || '(link do assistente)'}\n\nO cadastro leva 1 minuto. Só números que estão neste grupo conseguem se cadastrar.\n\n_${cfg.nome_predio} · Administração_`;
}

// Posta no grupo o convite para os moradores se cadastrarem
router.post('/moradores/convite-grupo', admin, a(async (req, res) => {
  const cfg = await getConfig();
  if (!cfg.grupo_jid) { avisar(req, 'Escolha o grupo dos moradores em WhatsApp > Grupos antes de enviar o convite.', 'erro'); return res.redirect('/moradores'); }
  const uazapi = require('../uazapi');
  const n = await uazapi.numeroDaInstancia();
  if (!n) { avisar(req, 'O WhatsApp do assistente não está conectado. Conecte em WhatsApp antes de enviar o convite.', 'erro'); return res.redirect('/moradores'); }
  try {
    await uazapi.enviarNoGrupo(cfg.grupo_jid, textoConviteCadastro(cfg, `https://wa.me/${n}?text=${encodeURIComponent('Quero me cadastrar')}`));
    avisar(req, `Convite enviado no grupo ${cfg.grupo_nome || 'dos moradores'}. Os cadastros vão aparecer aqui em "Cadastros pelo grupo para conferir".`);
  } catch (e) {
    avisar(req, `Não foi possível postar no grupo: ${e.message}. Confira se o número do assistente está no grupo e pode enviar mensagens.`, 'erro');
  }
  res.redirect('/moradores');
}));

router.post('/moradores/conferir-todos', admin, a(async (req, res) => {
  const r = ok(await db.from('moradores').update({ conferido: true }).eq('autocadastro', true).eq('conferido', false).select('id'));
  avisar(req, `${r.length} cadastro(s) conferido(s). Esses moradores já podem registrar reclamações.`);
  res.redirect('/moradores');
}));

router.post('/moradores/:id/desbloquear', admin, a(async (req, res) => {
  const m = ok(await db.from('moradores').update({ bloqueado_ate: null, fora_assunto_vezes: 0 }).eq('id', req.params.id).select('nome').single());
  avisar(req, `Atendimento de ${m.nome} liberado. O assistente volta a responder normalmente.`);
  res.redirect(`/moradores/${req.params.id}`);
}));

router.post('/moradores/:id/conferir', admin, a(async (req, res) => {
  const m = ok(await db.from('moradores').update({ conferido: true }).eq('id', req.params.id).select('nome').single());
  avisar(req, `Cadastro de ${m.nome} conferido.`);
  res.redirect(req.body.voltar === 'ficha' ? `/moradores/${req.params.id}` : '/moradores');
}));

router.post('/moradores', admin, a(async (req, res) => {
  const b = req.body;
  const telefone = normalizarTelefone(b.telefone);
  if (!b.nome || telefone.length < 12) { avisar(req, 'Informe nome e telefone com DDD.', 'erro'); return res.redirect('/moradores'); }
  const r = await db.from('moradores').insert({
    nome: b.nome.trim(), telefone, email: b.email || null, tipo: b.tipo || 'morador', vaga: (b.vaga || '').trim() || null,
    unidade_id: await unidadeId(b.bloco, b.numero),
  }).select('*, unidade:unidades(*)').single();
  if (r.error) { avisar(req, r.error.code === '23505' ? 'Este telefone já está cadastrado.' : r.error.message, 'erro'); return res.redirect('/moradores'); }
  await db.from('contatos_pendentes').delete().eq('telefone', telefone);
  let enviado = false;
  if (b.boas_vindas === 'on') enviado = await enviarBoasVindas(r.data);
  avisar(req, `${b.nome} cadastrado. O assistente já reconhece este número.${enviado ? ' A mensagem de boas-vindas foi enviada no WhatsApp.' : ''}`);
  res.redirect('/moradores');
}));

async function enviarBoasVindas(m) {
  try { return await require('../servicos').boasVindas(m); } catch (e) { console.error('[boas-vindas]', e.message); return false; }
}

// Importação: uma linha por morador -> nome; telefone; bloco; apartamento; e-mail; vaga
router.post('/moradores/importar', admin, a(async (req, res) => {
  const linhas = String(req.body.lista || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let criados = 0; const erros = []; const novos = [];
  for (const [i, linha] of linhas.entries()) {
    const [nome, tel, bloco, numero, email, vaga] = linha.split(/[;\t]/).map((x) => (x || '').trim());
    const telefone = normalizarTelefone(tel);
    if (!nome || telefone.length < 12) { erros.push(`linha ${i + 1}`); continue; }
    const r = await db.from('moradores').upsert({ nome, telefone, email: email || null, vaga: vaga || null, unidade_id: await unidadeId(bloco, numero) }, { onConflict: 'condominio_id,telefone' }).select('*, unidade:unidades(*)').single();
    if (r.error) erros.push(`linha ${i + 1}`); else { criados++; novos.push(r.data); }
  }
  // Boas-vindas de uma importação vão pela fila lenta, para não arriscar o número
  const naFila = req.body.boas_vindas === 'on' && novos.length ? await require('../servicos').boasVindasEmFila(novos) : 0;
  avisar(req, `${criados} moradores importados.${naFila ? ` Boas-vindas na fila para ${naFila} (saem aos poucos).` : ''}${erros.length ? ` Não importadas: ${erros.join(', ')}.` : ''}`, erros.length ? 'erro' : 'ok');
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
    nome: b.nome, telefone: normalizarTelefone(b.telefone), email: b.email || null, tipo: b.tipo, vaga: (b.vaga || '').trim() || null,
    ativo: b.ativo === 'on', aceita_avisos: b.aceita_avisos === 'on', resumo_perfil: b.resumo_perfil || null,
    unidade_id: await unidadeId(b.bloco, b.numero),
  }).eq('id', req.params.id);
  avisar(req, r.error ? r.error.message : 'Dados salvos.', r.error ? 'erro' : 'ok');
  res.redirect(`/moradores/${req.params.id}`);
}));

router.post('/moradores/:id/boas-vindas', admin, a(async (req, res) => {
  const m = ok(await db.from('moradores').select('*, unidade:unidades(*)').eq('id', req.params.id).single());
  const enviado = await enviarBoasVindas(m);
  avisar(req, enviado ? 'Boas-vindas enviadas no WhatsApp.' : 'Não foi possível enviar agora. Confira a conexão do WhatsApp.', enviado ? 'ok' : 'erro');
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
// Cada pessoa da equipe é ligada a um ou mais condomínios (usuario_condominios).
// A tela mostra só a equipe do condomínio da vez. Excluir tira a pessoa deste condomínio;
// ela só é apagada de vez quando não atende mais nenhum.
const { dbGlobal } = require('../db');
const { condominioAtual } = require('../contexto');

async function equipeDoCondominio() {
  const ids = ok(await dbGlobal.from('usuario_condominios').select('usuario_id').eq('condominio_id', condominioAtual())).map((l) => l.usuario_id);
  if (!ids.length) return [];
  return ok(await dbGlobal.from('usuarios').select('id, nome, email, perfil, telefone, ativo, dono, criado_em').in('id', ids).order('nome'));
}

async function daEquipe(usuarioId) {
  const r = ok(await dbGlobal.from('usuario_condominios').select('usuario_id').eq('usuario_id', usuarioId).eq('condominio_id', condominioAtual()).limit(1));
  return r.length > 0;
}

router.get('/equipe', admin, a(async (req, res) => {
  res.render('equipe', { titulo: 'Equipe e acessos', usuarios: await equipeDoCondominio() });
}));

// Gera um link de acesso sem senha (bom para o zelador) e manda pelo WhatsApp
router.post('/equipe/:id/link', admin, a(async (req, res) => {
  if (!(await daEquipe(req.params.id))) return res.redirect('/equipe');
  const token = crypto.randomBytes(24).toString('hex');
  const u = ok(await dbGlobal.from('usuarios').update({ token_acesso: token }).eq('id', req.params.id).select('nome, telefone, perfil').single());
  const cfg = await getConfig();
  const link = `${env.APP_URL}/entrar/${token}`;
  let enviado = false;
  if (u.telefone) {
    // O link vai só no botão; aparece escrito apenas se o botão falhar (plano B)
    enviado = await enviarBotoes(u.telefone,
      `Olá, ${u.nome.split(' ')[0]}! Este é o seu acesso ao app ${u.perfil === 'zelador' ? 'do zelador' : 'do condomínio'} do ${cfg.nome_predio}.\n\nToque no botão abaixo para entrar. Depois, no menu do navegador, escolha "Adicionar à tela inicial" para ter o ícone no celular. Não encaminhe esta mensagem para ninguém.`,
      [`🔑 Entrar no app|${link}`], { rodape: u.perfil === 'zelador' ? 'App do zelador' : cfg.nome_predio, planoB: `👉 ${link}`, rotulo: u.perfil === 'zelador' ? 'zelador' : '' });
  }
  avisar(req, enviado ? `Link enviado para o WhatsApp de ${u.nome}. Links antigos deixaram de funcionar.` : `Link de ${u.nome} (cadastre o WhatsApp para enviar automaticamente): ${link}`, enviado ? 'ok' : 'erro');
  res.redirect('/equipe');
}));

router.post('/equipe/:id/excluir', admin, a(async (req, res) => {
  if (req.params.id === req.session.usuario.id) { avisar(req, 'Você não pode excluir o seu próprio acesso.', 'erro'); return res.redirect('/equipe'); }
  if (!(await daEquipe(req.params.id))) return res.redirect('/equipe');
  ok(await dbGlobal.from('usuario_condominios').delete().eq('usuario_id', req.params.id).eq('condominio_id', condominioAtual()));
  const resta = ok(await dbGlobal.from('usuario_condominios').select('condominio_id').eq('usuario_id', req.params.id).limit(1));
  const u = resta.length
    ? ok(await dbGlobal.from('usuarios').select('nome').eq('id', req.params.id).single())
    : ok(await dbGlobal.from('usuarios').delete().eq('id', req.params.id).eq('dono', false).select('nome').maybeSingle()) || { nome: 'a pessoa' };
  avisar(req, resta.length ? `${u.nome} não faz mais parte da equipe deste condomínio (continua nos outros que atende).` : `Acesso de ${u.nome} excluído.`);
  res.redirect('/equipe');
}));

router.post('/equipe', admin, a(async (req, res) => {
  const { id, nome, perfil, telefone } = req.body;
  let { email, senha } = req.body;
  // O zelador pode entrar só pelo link: e-mail e senha viram opcionais para ele
  if (!id && perfil === 'zelador') {
    if (!email) email = `zelador.${crypto.randomBytes(4).toString('hex')}@sem-email.local`;
    if (!senha) senha = crypto.randomBytes(12).toString('hex');
  }
  const dados = { nome, email: String(email || '').trim().toLowerCase(), perfil, telefone: normalizarTelefone(telefone) || null };
  let jaExistia = false;
  if (id) {
    if (!(await daEquipe(id))) return res.redirect('/equipe');
    dados.ativo = req.body.ativo === 'on';
    if (senha) dados.senha_hash = await bcrypt.hash(senha, 10);
    if (id === req.session.usuario.id && (!dados.ativo || !['admin', 'sindico'].includes(perfil))) { avisar(req, 'Você não pode tirar o seu próprio acesso de administrador.', 'erro'); return res.redirect('/equipe'); }
    ok(await dbGlobal.from('usuarios').update(dados).eq('id', id));
  } else {
    // E-mail que já tem acesso (ex.: síndico profissional de outro prédio): só liga ao condomínio da vez
    const [existe] = ok(await dbGlobal.from('usuarios').select('id, nome').eq('email', dados.email).limit(1));
    let novoId = existe?.id;
    if (existe) jaExistia = true;
    else {
      if (!senha || senha.length < 8) { avisar(req, 'A senha precisa de pelo menos 8 caracteres.', 'erro'); return res.redirect('/equipe'); }
      const r = await dbGlobal.from('usuarios').insert({ ...dados, senha_hash: await bcrypt.hash(senha, 10), condominio_atual: condominioAtual() }).select('id').single();
      if (r.error) { avisar(req, r.error.message, 'erro'); return res.redirect('/equipe'); }
      novoId = r.data.id;
    }
    ok(await dbGlobal.from('usuario_condominios').upsert({ usuario_id: novoId, condominio_id: condominioAtual() }, { onConflict: 'usuario_id,condominio_id' }));
  }
  // O síndico cadastrado com WhatsApp passa a receber os alertas do síndico
  if (perfil === 'sindico' && dados.telefone && (id ? dados.ativo : true)) await setConfig({ telefone_sindico: dados.telefone });
  avisar(req, jaExistia
    ? `Este e-mail já tinha acesso: a pessoa passou a fazer parte da equipe deste condomínio também (com a mesma senha).`
    : perfil === 'sindico' && dados.telefone ? 'Acesso salvo. Este número passa a receber os alertas do síndico e pode usar o assistente no WhatsApp.' : 'Acesso salvo.');
  res.redirect('/equipe');
}));

// ---------- Configurações do prédio ----------
router.get('/configuracoes', admin, a(async (req, res) => {
  res.render('configuracoes', { titulo: 'Configurações', c: await getConfig() });
}));

router.post('/configuracoes', admin, a(async (req, res) => {
  const campos = ['grupo_convite', 'nome_predio', 'nome_assistente', 'telefone_sindico', 'telefone_zelador', 'telefone_portaria', 'horario_administracao', 'instrucoes_extras', 'horario_obras', 'horario_mudancas', 'horario_silencio',
    'adm_nome', 'adm_contato', 'adm_telefone', 'adm_whatsapp', 'adm_email', 'adm_portal', 'adm_horario', 'adm_observacoes'];
  const v = {};
  for (const c of campos) v[c] = c.startsWith('telefone_') ? normalizarTelefone(req.body[c]) : (req.body[c] || '').trim();
  v.grupo_chamar_privado = req.body.grupo_chamar_privado === 'on' ? '1' : '0';
  v.autocadastro = req.body.autocadastro === 'on' ? '1' : '0';
  v.fora_assunto_limite = String(Math.min(10, Math.max(0, parseInt(req.body.fora_assunto_limite, 10) || 0)));
  v.fora_assunto_horas = String(Math.min(168, Math.max(1, parseInt(req.body.fora_assunto_horas, 10) || 12)));
  v.autocadastro_reclamacao_conferido = req.body.autocadastro_reclamacao_conferido === 'on' ? '1' : '0';
  v.unidades_validas = String(req.body.unidades_validas || '').replace(/\s*\n\s*/g, ', ').trim();
  v.avisar_autor_reclamacao = req.body.avisar_autor_reclamacao === 'on' ? '1' : '0';
  v.sindico_reclamacoes = ['todas', 'reincidencia', 'nenhuma'].includes(req.body.sindico_reclamacoes) ? req.body.sindico_reclamacoes : 'todas';
  v.sindico_reincidencia_minima = String(Math.min(5, Math.max(2, Number(req.body.sindico_reincidencia_minima) || 3)));
  await setConfig(v);
  avisar(req, 'Configurações salvas.');
  res.redirect('/configuracoes');
}));

module.exports = router;
