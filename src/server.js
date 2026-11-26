const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const { env, faltando } = require('./config');
const { getConfig, contar } = require('./db');
const { icone } = require('./icones');
const util = require('./util');
const uazapi = require('./uazapi');
const agente = require('./agente');
const rotinas = require('./rotinas');
const { db, dbGlobal, listarCondominios } = require('./db');
const { noCondominio } = require('./contexto');

const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/icone-192.png'));
app.get('/saude', (req, res) => res.json({ ok: true, faltando }));

// ---------- Webhook da Uazapi (antes do login) ----------
app.post('/webhook/uazapi/:segredo', express.json({ limit: '5mb' }), (req, res) => {
  if (!env.WEBHOOK_SECRET || req.params.segredo !== env.WEBHOOK_SECRET) return res.sendStatus(403);
  res.sendStatus(200); // responde na hora; o processamento segue em segundo plano
  tratarWebhook(req.body).catch((e) => console.error('[webhook]', e.message));
});

// O WhatsApp devolve ao webhook cópias das mensagens que o próprio sistema enviou.
// A memória do processo não basta (a hospedagem pode rodar mais de um processo), então confere no banco:
// toda mensagem enviada fica em "mensagens" com o id do WhatsApp. Espera uns segundos porque a gravação
// acontece logo depois do envio, e a cópia pode chegar antes.
async function ecoDoSistema(ev) {
  await new Promise((r) => setTimeout(r, 5000));
  const ids = (ev.ids || []).filter(Boolean).map((id) => String(id).split(':').pop());
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const texto = norm(ev.texto);
  const r = await dbGlobal.from('mensagens').select('wa_id, texto').eq('direcao', 'saida')
    .gte('criado_em', new Date(Date.now() - 15 * 60000).toISOString()).order('criado_em', { ascending: false }).limit(300);
  if (r.error) { console.error('[eco] consulta', r.error.message); return false; }
  return r.data.some((m) => {
    if (m.wa_id && ids.includes(String(m.wa_id).split(':').pop())) return true;
    if (!texto) return false;
    const enviado = norm(m.texto.replace(/\n\[botões:[^\]]*\]$/, ''));
    // Igual, ou um pedaço grande da mensagem (mensagem com botões volta só com o corpo)
    return enviado === texto || (texto.length >= 40 && enviado.includes(texto));
  });
}

// Mensagens já recebidas (pelo id do WhatsApp), para ignorar a entrega repetida
const recebidas = new Map();
function jaRecebida(id) {
  if (!id) return false;
  const agora = Date.now();
  for (const [k, t] of recebidas) if (agora - t > 10 * 60000) recebidas.delete(k);
  if (recebidas.has(id)) return true;
  recebidas.set(id, agora);
  return false;
}

// Grava a mensagem do grupo e devolve o id dela. Devolve null se ela já estava gravada (entrega repetida em outro processo).
async function gravarMensagemDoGrupo(linha) {
  const r = await db.from('grupo_mensagens').insert(linha).select('id').single();
  if (!r.error) return r.data.id;
  if (r.error.code === '23505') return null; // mesma mensagem: já tratada
  // Banco ainda sem a coluna wa_id (migração 016 não rodou): grava sem ela
  if (/wa_id/.test(r.error.message)) {
    const { wa_id: _, ...resto } = linha;
    const r2 = await db.from('grupo_mensagens').insert(resto).select('id').single();
    if (r2.error) console.error('[grupo]', r2.error.message);
    return r2.error ? null : r2.data.id;
  }
  console.error('[grupo]', r.error.message);
  return null;
}

async function tratarWebhook(body) {
  const ev = uazapi.lerWebhook(body);
  if (ev.tipo === 'conexao') {
    console.log('[whatsapp] conexão:', ev.estado, ev.motivo);
    return;
  }
  if (ev.tipo !== 'mensagem') return;

  // Mensagem escrita no próprio celular do número do prédio: só vale na conversa consigo mesmo
  // (o chat é o próprio número). Mensagens dele para outras pessoas nunca são tratadas.
  if (!ev.ehGrupo) {
    const numero = await uazapi.numeroDaInstancia();
    const { variantesTelefone } = require('./util');
    const doProprioNumero = Boolean(numero && variantesTelefone(ev.telefone).includes(numero));
    if (ev.proprio && !doProprioNumero) return;
    // Tudo que parece vir do próprio número do assistente pode ser cópia do que ele mesmo enviou
    if (doProprioNumero && (await ecoDoSistema(ev))) return;
  }

  if (ev.ehGrupo) {
    if (!ev.texto && ev.midia !== 'audio') return;
    // A Uazapi entrega cada mensagem de grupo duas vezes: trata só a primeira
    if (jaRecebida(ev.waId)) return;
    // De qual condomínio é este grupo (cada condomínio escolhe o seu grupo na página do WhatsApp)
    const donos = await dbGlobal.from('config').select('condominio_id').eq('chave', 'grupo_jid').eq('valor', ev.chatid);
    if (donos.error) return console.error('[grupo]', donos.error.message);
    for (const { condominio_id: id } of donos.data) {
      await noCondominio(id, async () => {
        const cfg = await getConfig();
        const { acharMorador } = require('./servicos');
        // Síndico, administração, portaria e zelador postam o que quiserem no grupo: o assistente nunca os questiona
        // (nem quando o número também está cadastrado como morador)
        const daEquipe = ev.telefone ? await require('./agente_admin').acharAdmin(ev.telefone).catch(() => null) : null;
        const morador = ev.telefone && !daEquipe ? await acharMorador(ev.telefone) : null;
        let texto = ev.texto;
        // Áudio no grupo: só de morador cadastrado (ouvir áudio de qualquer um custa caro)
        if (!texto) {
          if (!morador) return;
          try { texto = await agente.transcreverAudio(ev.ids); } catch (e) { return console.error('[grupo] áudio', e.message); }
          if (!texto) return;
          texto = `[áudio] ${texto}`;
        }
        // O banco garante que a mesma mensagem não seja gravada (nem tratada) duas vezes
        const grupoMsgId = await gravarMensagemDoGrupo({ telefone: ev.telefone || null, nome: morador?.nome || daEquipe?.nome || ev.nome || null, morador_id: morador?.id || null, texto: texto.slice(0, 4000), wa_id: ev.waId || null });
        if (!grupoMsgId) return;
        // O assistente nunca responde no grupo. Se ligado, chama no privado quem relatou um problema.
        if (cfg.grupo_chamar_privado === '1' && morador) await agente.avaliarMensagemDoGrupo(morador, texto.replace(/^\[áudio\] /, ''), grupoMsgId);
      });
    }
    return;
  }

  if (!ev.telefone) return;
  await agente.receberMensagemPrivada(ev);
}

// ---------- Painel ----------
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.json({ limit: '8mb' })); // fotos do celular chegam comprimidas, mas com folga
app.use(cookieSession({
  name: 'cond_sessao',
  keys: [env.SESSION_SECRET || 'defina-SESSION_SECRET'],
  maxAge: 12 * 3600 * 1000,
  sameSite: 'lax',
  httpOnly: true,
  secure: env.APP_URL.startsWith('https://'),
}));

// Condomínio da vez no painel: o escolhido no seletor (ou o primeiro que a pessoa atende).
// Toda a página roda dentro dele, e o banco filtra os dados por ele.
app.use(async (req, res, next) => {
  const u = req.session.usuario;
  res.locals.condominios = [];
  res.locals.condominioAtual = null;
  if (!u) return next();
  try {
    if (!req.session.condominios || Date.now() - (req.session.condominiosEm || 0) > 5 * 60000) {
      req.session.condominios = await require('./servicos').condominiosDoUsuario(u);
      req.session.condominiosEm = Date.now();
    }
  } catch (e) { console.error('[condomínios]', e.message); }
  const lista = req.session.condominios || [];
  const atual = lista.find((c) => c.id === req.session.condominioId) || lista[0] || null;
  req.session.condominioId = atual?.id || null;
  res.locals.condominios = lista;
  res.locals.condominioAtual = atual;
  if (!atual) {
    // Sem condomínio: o dono vai criar o primeiro; os outros só podem sair
    const livre = ['/condominios', '/sair', '/login', '/ficha', '/r', '/entrar', '/minha-senha', '/esqueci', '/nova-senha'].some((p) => req.path === p || req.path.startsWith(p + '/'));
    if (require('./rotas/comum').ehGestor(u) && !livre) return res.redirect('/condominios');
    if (!require('./rotas/comum').ehGestor(u) && !livre) return res.status(403).render('erro', { titulo: 'Sem condomínio', mensagem: 'Seu acesso ainda não está ligado a nenhum condomínio. Fale com a administração.', usuario: u, condominios: [], condominioAtual: null, cfg: { nome_predio: 'Condomínio' }, contadores: {}, caminho: req.path, aviso: null, faltando: [], icone, u: util });
    return next();
  }
  noCondominio(atual.id, () => next());
});

app.use(async (req, res, next) => {
  res.locals.u = util;
  res.locals.usuario = req.session.usuario || null;
  res.locals.caminho = req.path;
  res.locals.aviso = req.session.aviso || null;
  res.locals.faltando = faltando;
  res.locals.icone = icone;
  res.locals.contadores = {};
  req.session.aviso = null;
  try { res.locals.cfg = await getConfig(); } catch { res.locals.cfg = { nome_predio: 'Condomínio' }; }
  // Números que aparecem no menu lateral (chamados e reclamações pendentes)
  const u = req.session.usuario;
  if (u && u.perfil !== 'conselho' && req.method === 'GET' && !req.path.endsWith('.json')) {
    try {
      const [chamados, reclamacoes] = await Promise.all([
        u.perfil === 'portaria' ? 0 : contar('chamados', (q) => {
          q = q.in('status', ['aberto', 'em_andamento']);
          return u.perfil === 'zelador' ? q.neq('categoria', 'administracao') : q;
        }),
        u.perfil === 'zelador' ? 0 : contar('reclamacoes', (q) => q.eq('status', 'nova')),
      ]);
      res.locals.contadores = { chamados, reclamacoes };
      // Dúvidas sem resposta (tabela da migração 008; sem ela, fica sem número)
      if (u.perfil === 'admin') res.locals.contadores.duvidas = await contar('duvidas', (q) => q.eq('status', 'aberta')).catch(() => 0);
      if (u.perfil === 'admin' || u.perfil === 'portaria') res.locals.contadores.encomendas = await contar('encomendas', (q) => q.eq('status', 'aguardando')).catch(() => 0);
    } catch { /* menu sem números se o banco falhar */ }
  }
  next();
});

app.use(require('./rotas/acesso'));
app.use(require('./rotas/senha'));
app.use(require('./rotas/condominios'));
app.use(require('./rotas/implantacao'));
app.use(require('./rotas/zelador'));
app.use(require('./rotas/whatsapp'));
app.use(require('./rotas/cadastro'));
app.use(require('./rotas/operacao'));
app.use(require('./rotas/encomendas'));
app.use(require('./rotas/reservas'));
app.use(require('./rotas/inteligencia'));

app.use((req, res) => res.status(404).render('erro', { titulo: 'Página não encontrada', mensagem: 'Confira o endereço.' }));
app.use((err, req, res, next) => {
  console.error('[erro]', req.method, req.path, err.message);
  if (req.accepts(['html', 'json']) === 'json' || req.xhr) return res.status(500).json({ erro: err.message });
  res.status(500).render('erro', { titulo: 'Algo deu errado', mensagem: err.message });
});

app.listen(env.PORT, () => {
  console.log(`Assistente do condomínio rodando na porta ${env.PORT}`);
  if (faltando.length) console.warn('Variáveis de ambiente faltando:', faltando.join(', '));
  else rotinas.iniciar();
});
