// Espaços (com checklist), reservas e a página de check-in/check-out do morador
const router = require('express').Router();
const { db, ok, getConfig } = require('../db');
const { noCondominio } = require('../contexto');
const { lerFoto, salvarFoto, dataUrlParaBuffer } = require('../fotos');
const { localParaISO } = require('../util');
const rs = require('../reservas');
const { a, exigir, avisar } = require('./comum');

const admin = exigir('admin');

// ---------- Espaços e checklists (o síndico monta) ----------
router.get('/espacos', admin, a(async (req, res) => {
  const r = await db.from('espacos').select('*').eq('ativo', true).order('nome');
  if (r.error) return res.render('espacos', { titulo: 'Espaços e checklists', espacos: [], semTabela: true });
  res.render('espacos', { titulo: 'Espaços e checklists', espacos: r.data, semTabela: false });
}));

router.post('/espacos', admin, a(async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  let itens = [];
  try { itens = JSON.parse(req.body.itens || '[]'); } catch { itens = []; }
  itens = itens.map((i) => ({ texto: String(i.texto || '').trim().slice(0, 120), foto: Boolean(i.foto) })).filter((i) => i.texto).slice(0, 40);
  if (!nome || !itens.length) { avisar(req, 'Informe o nome do espaço e pelo menos um item do checklist.', 'erro'); return res.redirect('/espacos'); }
  if (req.body.id) ok(await db.from('espacos').update({ nome, itens }).eq('id', req.body.id));
  else ok(await db.from('espacos').insert({ nome, itens }));
  avisar(req, `Checklist do ${nome} salvo.`);
  res.redirect('/espacos');
}));

router.post('/espacos/:id/excluir', admin, a(async (req, res) => {
  ok(await db.from('espacos').update({ ativo: false }).eq('id', req.params.id));
  avisar(req, 'Espaço removido. As reservas antigas continuam no histórico.');
  res.redirect('/espacos');
}));

// ---------- Reservas (a administração cadastra) ----------
router.get('/reservas', admin, a(async (req, res) => {
  const [r, espacos, moradores] = await Promise.all([
    db.from('reservas').select('id, inicio, fim, status, problemas, entrada_em, saida_em, espaco:espacos(nome), morador:moradores(nome, unidade:unidades(bloco, numero))')
      .gte('fim', new Date(Date.now() - 30 * 86400000).toISOString()).order('inicio').limit(200),
    db.from('espacos').select('id, nome').eq('ativo', true).order('nome'),
    db.from('moradores').select('id, nome, unidade:unidades(bloco, numero)').eq('ativo', true).order('nome'),
  ]);
  if (r.error || espacos.error) return res.render('reservas', { titulo: 'Reservas', proximas: [], passadas: [], espacos: [], moradores: [], semTabela: true });
  const agora = Date.now();
  const proximas = r.data.filter((x) => new Date(x.fim).getTime() >= agora && x.status !== 'cancelada');
  const passadas = r.data.filter((x) => !proximas.includes(x)).reverse();
  const ordenar = (m) => `${m.unidade?.bloco || ''}${(m.unidade?.numero || '').padStart(6, '0')}`;
  res.render('reservas', { titulo: 'Reservas', proximas, passadas, espacos: espacos.data, moradores: moradores.data.sort((x, y) => ordenar(x).localeCompare(ordenar(y))), semTabela: false });
}));

router.post('/reservas', admin, a(async (req, res) => {
  const { espaco_id: espacoId, morador_id: moradorId, data, hora_inicio: hi, hora_fim: hf, observacao } = req.body;
  if (!espacoId || !moradorId || !data || !hi || !hf) { avisar(req, 'Preencha espaço, morador, data e horários.', 'erro'); return res.redirect('/reservas'); }
  const inicio = localParaISO(`${data}T${hi}`);
  // Fim antes do início = termina no dia seguinte (ex.: 20h às 2h)
  let fim = localParaISO(`${data}T${hf}`);
  if (new Date(fim) <= new Date(inicio)) fim = new Date(new Date(fim).getTime() + 86400000).toISOString();
  try {
    const r = await rs.criar({ espacoId, moradorId, inicio, fim, observacao, por: req.session.usuario.nome });
    avisar(req, `Reserva do ${r.espaco.nome} cadastrada. ${r.morador?.nome || 'O morador'} recebeu a confirmação no WhatsApp e vai receber o link do check-in 2h antes do início.`);
  } catch (e) { avisar(req, e.message, 'erro'); }
  res.redirect('/reservas');
}));

router.get('/reservas/:id', admin, a(async (req, res) => {
  const r = await rs.carregar(Number(req.params.id));
  if (!r) return res.status(404).render('erro', { titulo: 'Reserva não encontrada', mensagem: 'Confira o endereço.' });
  res.render('reserva', { titulo: `Reserva · ${r.espaco.nome}`, r, hora: rs.hora });
}));

router.post('/reservas/:id/cancelar', admin, a(async (req, res) => {
  await rs.cancelar(Number(req.params.id), req.session.usuario.nome);
  avisar(req, 'Reserva cancelada. O morador foi avisado no WhatsApp.');
  res.redirect('/reservas');
}));

router.post('/reservas/:id/link/:etapa', admin, a(async (req, res) => {
  const etapa = req.params.etapa === 'saida' ? 'saida' : 'entrada';
  const r = await rs.carregar(Number(req.params.id));
  const enviado = r && (await rs.enviarLink(r, etapa));
  avisar(req, enviado ? `Link do ${rs.ETAPA[etapa]} enviado ao morador.` : 'Não foi possível enviar (morador sem WhatsApp ou inativo).', enviado ? 'ok' : 'erro');
  res.redirect(`/reservas/${req.params.id}`);
}));

// Foto de um item do checklist (painel)
router.get('/reservas/:id/foto/:etapa/:i', admin, a(async (req, res) => {
  const r = ok(await db.from('reservas').select('entrada, saida').eq('id', req.params.id).maybeSingle());
  const lista = r?.[req.params.etapa === 'saida' ? 'saida' : 'entrada'] || [];
  const id = lista[Number(req.params.i)]?.foto;
  if (!id) return res.sendStatus(404);
  const { buffer, mime } = await lerFoto(id);
  res.set('Content-Type', mime).set('Cache-Control', 'private, max-age=3600').send(buffer);
}));

// ---------- Página do morador (link no WhatsApp, sem senha) ----------
async function comReserva(req, res, fn) {
  const etapa = req.params.etapa === 'saida' ? 'saida' : req.params.etapa === 'entrada' ? 'entrada' : null;
  const ref = etapa && (await rs.porToken(req.params.token));
  if (!ref) return res.status(404).render('erro', { titulo: 'Link inválido', mensagem: 'Este link de checklist não existe ou expirou.' });
  return noCondominio(ref.condominio_id, async () => {
    const r = await rs.carregar(ref.id);
    // O link vale até 24 horas depois do fim da reserva
    const vencido = r.status === 'cancelada' || Date.now() - new Date(r.fim).getTime() > 86400000;
    return fn(r, etapa, vencido);
  });
}

router.get('/r/:token/:etapa', a(async (req, res) => comReserva(req, res, async (r, etapa, vencido) => {
  const cfg = await getConfig();
  res.render('checklist', { titulo: `${rs.ETAPA[etapa][0].toUpperCase()}${rs.ETAPA[etapa].slice(1)} · ${r.espaco.nome}`, r, etapa, vencido, cfg, hora: rs.hora, feito: Boolean(r[`${etapa}_em`]) });
})));

router.post('/r/:token/:etapa', express_json(), a(async (req, res) => comReserva(req, res, async (r, etapa, vencido) => {
  if (vencido) return res.status(410).json({ erro: 'Este link expirou.' });
  if (r[`${etapa}_em`]) return res.status(409).json({ erro: `O ${rs.ETAPA[etapa]} desta reserva já foi feito.` });
  const itens = r.espaco.itens || [];
  const recebidas = Array.isArray(req.body.respostas) ? req.body.respostas : [];
  const respostas = [];
  for (let i = 0; i < itens.length; i++) {
    const x = recebidas[i] || {};
    let foto = null;
    if (x.foto) {
      const arq = dataUrlParaBuffer(x.foto);
      if (arq) foto = await salvarFoto(arq.buffer, arq.mime, 'reservas');
    }
    if (itens[i].foto && !foto) return res.status(400).json({ erro: `Falta a foto de: ${itens[i].texto}` });
    respostas.push({ ok: x.ok !== false, obs: String(x.obs || ''), foto });
  }
  const { problemas } = await rs.salvarChecklist(r, etapa, respostas);
  res.json({ ok: true, problemas: Boolean(problemas) });
})));

// Corpo JSON maior só para o checklist (várias fotos)
function express_json() { return require('express').json({ limit: '20mb' }); }

module.exports = router;
