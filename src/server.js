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
const { db } = require('./db');

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

async function tratarWebhook(body) {
  const ev = uazapi.lerWebhook(body);
  if (ev.tipo === 'conexao') {
    console.log('[whatsapp] conexão:', ev.estado, ev.motivo);
    return;
  }
  if (ev.tipo !== 'mensagem') return;

  // Mensagem escrita no próprio celular do número do prédio: só vale na conversa consigo mesmo
  // (o chat é o próprio número). Mensagens dele para outras pessoas nunca são tratadas.
  if (ev.proprio && !ev.ehGrupo) {
    const numero = await uazapi.numeroDaInstancia();
    const { variantesTelefone } = require('./util');
    if (!numero || !variantesTelefone(ev.telefone).includes(numero)) return;
  }

  if (ev.ehGrupo) {
    const cfg = await getConfig();
    if (!cfg.grupo_jid || ev.chatid !== cfg.grupo_jid || !ev.texto) return;
    const { acharMorador } = require('./servicos');
    const morador = ev.telefone ? await acharMorador(ev.telefone) : null;
    await db.from('grupo_mensagens').insert({ telefone: ev.telefone || null, nome: morador?.nome || ev.nome || null, morador_id: morador?.id || null, texto: ev.texto.slice(0, 4000) });
    // O assistente nunca responde no grupo. Se ligado, chama no privado quem relatou um problema.
    if (cfg.grupo_chamar_privado === '1' && morador) await agente.avaliarMensagemDoGrupo(morador, ev.texto);
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
    } catch { /* menu sem números se o banco falhar */ }
  }
  next();
});

app.use(require('./rotas/acesso'));
app.use(require('./rotas/zelador'));
app.use(require('./rotas/whatsapp'));
app.use(require('./rotas/cadastro'));
app.use(require('./rotas/operacao'));
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
