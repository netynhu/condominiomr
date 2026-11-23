// Cliente da Uazapi (uazapiGO v2). Referência: https://docs.uazapi.com
const { env } = require('./config');
const { telefoneDoJid, soDigitos } = require('./util');

async function chamar(caminho, { method = 'GET', body } = {}) {
  if (!env.UAZAPI_URL || !env.UAZAPI_TOKEN) throw new Error('Uazapi não configurada (UAZAPI_URL e UAZAPI_TOKEN).');
  const res = await fetch(env.UAZAPI_URL + caminho, {
    method,
    headers: { token: env.UAZAPI_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const texto = await res.text();
  let json;
  try { json = texto ? JSON.parse(texto) : {}; } catch { json = { raw: texto }; }
  if (!res.ok) {
    const e = new Error(json.error || json.message || `Uazapi respondeu ${res.status}`);
    e.status = res.status;
    e.resposta = json;
    throw e;
  }
  return json;
}

// O QR pode vir como base64 puro ou já como data URI
function qrComoImagem(qr) {
  if (!qr || typeof qr !== 'string') return null;
  return qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`;
}

function resumirStatus(json) {
  const inst = json.instance || {};
  const st = json.status || {};
  let estado = inst.status || (st.connected ? 'connected' : 'disconnected');
  if (st.connected && st.loggedIn) estado = 'connected';
  return {
    estado, // connected | connecting | disconnected | hibernated
    conectado: estado === 'connected',
    qrcode: qrComoImagem(inst.qrcode || json.qrcode),
    paircode: inst.paircode || json.paircode || null,
    numero: telefoneDoJid(typeof st.jid === 'string' ? st.jid : st.jid?.user ? `${st.jid.user}@s.whatsapp.net` : '') || soDigitos(inst.owner || ''),
    perfil: inst.profileName || '',
    ultimoMotivo: inst.lastDisconnectReason || '',
  };
}

async function status() {
  return resumirStatus(await chamar('/instance/status'));
}

// Inicia a conexão. Sem telefone gera QR; com telefone gera código de pareamento.
async function conectar(telefone) {
  const body = telefone ? { phone: soDigitos(telefone) } : {};
  try {
    const json = await chamar('/instance/connect', { method: 'POST', body });
    const s = resumirStatus(json);
    if (s.qrcode || s.paircode || s.conectado) return s;
  } catch (e) {
    if (e.status !== 409) throw e; // 409 = conexão já em andamento: segue para o status
  }
  return status();
}

async function desconectar() {
  return chamar('/instance/disconnect', { method: 'POST' });
}

// Cadastra o webhook do condomínio SEM mexer nos webhooks de outros sistemas que usam a mesma instância.
// Se já existir um webhook com o mesmo endereço base, atualiza só ele; senão, acrescenta um novo.
async function configurarWebhook(url) {
  const corpo = { enabled: true, url, events: ['messages', 'connection'], excludeMessages: ['wasSentByApi'] };
  let existentes = [];
  try { const j = await chamar('/webhook'); existentes = Array.isArray(j) ? j : (j && j.url ? [j] : []); } catch { existentes = []; }
  const base = url.split('/webhook/uazapi/')[0] + '/webhook/uazapi/';
  const meu = existentes.find((w) => String(w.url || '').startsWith(base));
  if (meu?.id) return chamar('/webhook', { method: 'POST', body: { ...corpo, id: meu.id, action: 'update' } });
  if (existentes.length) return chamar('/webhook', { method: 'POST', body: { ...corpo, action: 'add' } });
  return chamar('/webhook', { method: 'POST', body: corpo });
}

async function listarGrupos() {
  const json = await chamar('/group/list', { method: 'POST', body: { limit: 500, offset: 0, noParticipants: true } });
  return (json.groups || []).map((g) => ({ jid: g.JID || g.jid, nome: g.Name || g.name || g.Subject || '(sem nome)' }));
}

// Telefones de quem está no grupo (a Uazapi devolve o número mesmo quando o grupo usa LID)
const cacheParticipantes = new Map(); // jid -> { em, tels }
async function participantesDoGrupo(grupoJid) {
  const c = cacheParticipantes.get(grupoJid);
  if (c && Date.now() - c.em < 2 * 60000) return c.tels;
  const json = await chamar('/group/info', { method: 'POST', body: { groupjid: grupoJid } });
  const lista = json.Participants || json.participants || [];
  const tels = new Set(lista.map((p) => telefoneDoJid(p.PhoneNumber || p.phoneNumber || p.JID || '')).filter(Boolean));
  cacheParticipantes.set(grupoJid, { em: Date.now(), tels });
  return tels;
}

// Envia texto para uma pessoa. Nunca escreve em grupo: o assistente só lê o grupo.
// Mensagens enviadas há pouco: evita que, na conversa consigo mesmo, o sistema leia a própria resposta
const enviadasRecentes = new Map(); // chave (id ou texto) -> hora
// O id pode vir com o número na frente ("5511...:ABC123"): guarda e compara só a parte final
const chaveId = (id) => 'id:' + String(id).split(':').pop();
// Texto comparado sem espaços extras (o WhatsApp às vezes devolve com quebras diferentes)
const chaveTexto = (t) => 'tx:' + String(t).replace(/\s+/g, ' ').trim();
function limparAntigas() {
  const agora = Date.now();
  for (const [k, t] of enviadasRecentes) if (agora - t > 10 * 60000) enviadasRecentes.delete(k);
}
// Chamado ANTES do envio: o eco da mensagem pode chegar no webhook antes da resposta da Uazapi
function lembrarTexto(texto) {
  limparAntigas();
  if (texto) enviadasRecentes.set(chaveTexto(texto), Date.now());
}
function lembrarEnvio(json, texto) {
  limparAntigas();
  const id = idEnviado(json);
  if (id) enviadasRecentes.set(chaveId(id), Date.now());
  if (texto) enviadasRecentes.set(chaveTexto(texto), Date.now());
}
const foiEnviadaPeloSistema = (ids, texto) => ids.some((id) => id && enviadasRecentes.has(chaveId(id))) || Boolean(texto && enviadasRecentes.has(chaveTexto(texto)));

// Mensagem com link: desliga a prévia do link (linkPreview: false)
const temLink = (texto) => /https?:\/\/|www\.|wa\.me\//i.test(String(texto || ''));
const semPrevia = (corpo, texto) => (temLink(texto) ? { ...corpo, linkPreview: false } : corpo);

async function enviarTexto(numero, texto, { digitando = true } = {}) {
  const alvo = String(numero || '');
  if (!alvo || alvo.includes('@g.us') || alvo.includes('@newsletter')) {
    throw new Error('Envio bloqueado: o assistente só envia mensagens privadas.');
  }
  const delay = digitando ? Math.min(4000, 800 + texto.length * 15) : 0;
  lembrarTexto(texto);
  const json = await chamar('/send/text', { method: 'POST', body: semPrevia({ number: soDigitos(alvo), text: texto, delay }, texto) });
  lembrarEnvio(json, texto);
  return json;
}

// Botões interativos (POST /send/menu). escolhas: "Texto|id" (resposta) ou "Texto|https://..." (link).
// tipo "list" mostra uma lista; a Uazapi avisa que botões podem ser descontinuados, então quem chama tem plano B em texto.
async function enviarMenu(numero, texto, escolhas, { tipo = 'button', rodape = '', botaoLista = 'Ver opções' } = {}) {
  const alvo = String(numero || '');
  if (!alvo || alvo.includes('@g.us')) throw new Error('Envio bloqueado: botões só no privado.');
  const corpo = { number: soDigitos(alvo), type: tipo, text: texto, choices: escolhas };
  if (rodape) corpo.footerText = rodape;
  if (tipo === 'list') corpo.listButton = botaoLista;
  lembrarTexto(texto);
  const json = await chamar('/send/menu', { method: 'POST', body: semPrevia(corpo, texto) });
  lembrarEnvio(json, texto);
  return json;
}

// Envia uma foto (buffer) com legenda para uma pessoa
async function enviarFoto(numero, buffer, legenda = '') {
  const alvo = String(numero || '');
  if (!alvo || alvo.includes('@g.us')) throw new Error('Envio bloqueado: fotos só no privado.');
  lembrarTexto(legenda);
  const json = await chamar('/send/media', { method: 'POST', body: semPrevia({ number: soDigitos(alvo), type: 'image', file: buffer.toString('base64'), text: legenda }, legenda) });
  lembrarEnvio(json, legenda);
  return json;
}

// Posta no grupo dos moradores. Só aceita o grupo configurado no painel.
async function enviarNoGrupo(grupoJid, texto) {
  if (!grupoJid || !grupoJid.endsWith('@g.us')) throw new Error('Nenhum grupo dos moradores configurado.');
  lembrarTexto(texto);
  const json = await chamar('/send/text', { method: 'POST', body: semPrevia({ number: grupoJid, text: texto, delay: 1500 }, texto) });
  lembrarEnvio(json, texto);
  return json;
}

// Posta uma imagem com legenda no grupo dos moradores (avisos com imagem)
async function enviarImagemNoGrupo(grupoJid, buffer, legenda = '') {
  if (!grupoJid || !grupoJid.endsWith('@g.us')) throw new Error('Nenhum grupo dos moradores configurado.');
  lembrarTexto(legenda);
  const json = await chamar('/send/media', { method: 'POST', body: semPrevia({ number: grupoJid, type: 'image', file: buffer.toString('base64'), text: legenda }, legenda) });
  lembrarEnvio(json, legenda);
  return json;
}

// Baixa a mídia de uma mensagem recebida (áudio vem em MP3).
// citada=true baixa a mídia da mensagem que a pessoa citou ao responder.
async function baixarMidia(ids, { citada = false, limiteBytes = 0 } = {}) {
  let ultimoErro;
  for (const id of ids.filter(Boolean)) {
    try {
      const json = await chamar('/message/download', { method: 'POST', body: { id, return_link: true, generate_mp3: true, download_quoted: citada } });
      if (!json.fileURL) throw new Error('Sem arquivo na resposta');
      const res = await fetch(json.fileURL, { signal: AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error(`Download respondeu ${res.status}`);
      const tamanho = Number(res.headers.get('content-length') || 0);
      if (limiteBytes && tamanho > limiteBytes) { const e = new Error('Arquivo grande demais'); e.grande = true; throw e; }
      return { buffer: Buffer.from(await res.arrayBuffer()), mime: json.mimetype || res.headers.get('content-type') || '' };
    } catch (e) { if (e.grande) throw e; ultimoErro = e; }
  }
  throw ultimoErro || new Error('Mensagem sem id');
}

// Identifica o tipo de mídia pelo que a Uazapi informa (o nome exato do tipo não é documentado)
function tipoDeMidia(m) {
  const t = `${m.messageType || ''} ${m.mediaType || ''} ${m.content?.mimetype || m.content?.mimeType || ''}`.toLowerCase();
  if (/reaction|sticker|protocol|revoked|call/.test(t)) return 'ignorar';
  if (/audio|ptt|voice/.test(t)) return 'audio';
  if (/video|ptv|gif/.test(t)) return 'video';
  if (/image|imagem/.test(t)) return 'imagem';
  if (/document|pdf|application\//.test(t)) return 'documento';
  if (/location|localiza/.test(t)) return 'localizacao';
  if (/contact|vcard/.test(t)) return 'contato';
  return null;
}

// Texto da mensagem citada, quando vem junto no conteúdo bruto (formato varia; tenta os mais comuns)
function textoCitado(m) {
  const c = m.content || {};
  const ctx = c.contextInfo || c.ContextInfo || c.extendedTextMessage?.contextInfo || {};
  const q = ctx.quotedMessage || ctx.QuotedMessage || m.quotedMessage || {};
  return String(q.conversation || q.Conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || q.videoMessage?.caption || m.quotedText || '').trim();
}

// Id da mensagem que acabou de ser enviada (para reconhecer quando o morador responder em cima dela)
const idEnviado = (json) => json?.messageid || json?.messageId || json?.id || json?.key?.id || null;

// Número conectado na instância (guardado por 10 minutos)
let cacheNumero = { valor: '', em: 0 };
async function numeroDaInstancia() {
  if (cacheNumero.valor && Date.now() - cacheNumero.em < 10 * 60000) return cacheNumero.valor;
  try { const s = await status(); if (s.numero) cacheNumero = { valor: s.numero, em: Date.now() }; } catch { /* mantém o anterior */ }
  return cacheNumero.valor;
}

// Converte o corpo do webhook em algo simples para o sistema
function lerWebhook(body) {
  const tipo = body?.EventType || body?.event || body?.type;
  if (tipo === 'connection') {
    return { tipo: 'conexao', estado: body.instance?.status || '', motivo: body.instance?.lastDisconnectReason || body.type || '' };
  }
  if (tipo !== 'messages') return { tipo: 'outro', bruto: tipo };
  const m = body.message || {};
  if (m.wasSentByApi) return { tipo: 'ignorar' };
  // Clique em botão ou item de lista: o id vem em buttonOrListid
  const botao = String(m.buttonOrListid || '').trim();
  const texto = (typeof m.text === 'string' ? m.text.trim() : '') || botao;
  const chatid = m.chatid || body.chat?.wa_chatid || '';
  const ehGrupo = Boolean(m.isGroup) || chatid.endsWith('@g.us');
  let telefone = telefoneDoJid(m.sender_pn) || telefoneDoJid(m.sender) || (!ehGrupo ? telefoneDoJid(chatid) : '') || telefoneDoJid(body.chat?.wa_chatid);
  let proprio = false;
  if (m.fromMe) {
    // Mensagem que o próprio dono do número escreveu. Só interessa na conversa consigo mesmo
    // ou no grupo dos moradores. Mensagens dele para outras pessoas são ignoradas.
    const dono = soDigitos(body.owner || '');
    if (foiEnviadaPeloSistema([m.messageid, m.id], texto)) return { tipo: 'ignorar' };
    // Mensagem com botões ou lista só o sistema envia (ninguém escreve isso à mão): é eco, ignora
    if (/button|list|interactive|template|nativeflow/i.test(m.messageType || '') && !botao) return { tipo: 'ignorar' };
    const alvoChat = telefoneDoJid(chatid) || soDigitos(body.chat?.phone || '');
    if (ehGrupo) { telefone = dono || telefone; proprio = true; }
    // Conversa consigo mesmo: o chat é o próprio número. Se a Uazapi não informar o dono,
    // o servidor confirma comparando com o número conectado na instância.
    else if (alvoChat && (!dono || alvoChat === dono)) { telefone = alvoChat; proprio = true; }
    else return { tipo: 'ignorar', proprioOutraConversa: true, diag: { chatid, chatPhone: body.chat?.phone || '', dono, tipo: m.messageType || '' } };
  }
  return {
    tipo: 'mensagem',
    botao,
    proprio,
    ehGrupo,
    chatid,
    telefone,
    nome: m.senderName || body.chat?.wa_name || body.chat?.name || '',
    texto,
    tipoMensagem: m.messageType || '',
    midia: tipoDeMidia(m),
    ids: [m.id, m.messageid],
    waId: m.messageid || m.id || '',
    citadoId: typeof m.quoted === 'string' ? m.quoted : (m.quoted?.id || m.quoted?.messageid || ''),
    citadoTexto: textoCitado(m),
    nomeArquivo: m.content?.fileName || m.content?.title || '',
  };
}

module.exports = { enviarImagemNoGrupo, participantesDoGrupo, numeroDaInstancia, status, conectar, desconectar, configurarWebhook, listarGrupos, enviarTexto, enviarMenu, enviarFoto, enviarNoGrupo, baixarMidia, lerWebhook, idEnviado };
