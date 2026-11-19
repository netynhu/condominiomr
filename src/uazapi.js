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

async function configurarWebhook(url) {
  return chamar('/webhook', {
    method: 'POST',
    body: {
      enabled: true,
      url,
      events: ['messages', 'connection'],
      excludeMessages: ['wasSentByApi'],
    },
  });
}

async function listarGrupos() {
  const json = await chamar('/group/list', { method: 'POST', body: { limit: 500, offset: 0, noParticipants: true } });
  return (json.groups || []).map((g) => ({ jid: g.JID || g.jid, nome: g.Name || g.name || g.Subject || '(sem nome)' }));
}

// Envia texto para uma pessoa. Nunca escreve em grupo: o assistente só lê o grupo.
async function enviarTexto(numero, texto, { digitando = true } = {}) {
  const alvo = String(numero || '');
  if (!alvo || alvo.includes('@g.us') || alvo.includes('@newsletter')) {
    throw new Error('Envio bloqueado: o assistente só envia mensagens privadas.');
  }
  const delay = digitando ? Math.min(4000, 800 + texto.length * 15) : 0;
  return chamar('/send/text', { method: 'POST', body: { number: soDigitos(alvo), text: texto, delay } });
}

// Envia uma foto (buffer) com legenda para uma pessoa
async function enviarFoto(numero, buffer, legenda = '') {
  const alvo = String(numero || '');
  if (!alvo || alvo.includes('@g.us')) throw new Error('Envio bloqueado: fotos só no privado.');
  return chamar('/send/media', { method: 'POST', body: { number: soDigitos(alvo), type: 'image', file: buffer.toString('base64'), text: legenda } });
}

// Posta no grupo dos moradores. Só aceita o grupo configurado no painel.
async function enviarNoGrupo(grupoJid, texto) {
  if (!grupoJid || !grupoJid.endsWith('@g.us')) throw new Error('Nenhum grupo dos moradores configurado.');
  return chamar('/send/text', { method: 'POST', body: { number: grupoJid, text: texto, delay: 1500 } });
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

// Converte o corpo do webhook em algo simples para o sistema
function lerWebhook(body) {
  const tipo = body?.EventType || body?.event || body?.type;
  if (tipo === 'connection') {
    return { tipo: 'conexao', estado: body.instance?.status || '', motivo: body.instance?.lastDisconnectReason || body.type || '' };
  }
  if (tipo !== 'messages') return { tipo: 'outro', bruto: tipo };
  const m = body.message || {};
  if (m.fromMe || m.wasSentByApi) return { tipo: 'ignorar' };
  const texto = typeof m.text === 'string' ? m.text.trim() : '';
  const chatid = m.chatid || body.chat?.wa_chatid || '';
  const ehGrupo = Boolean(m.isGroup) || chatid.endsWith('@g.us');
  const telefone = telefoneDoJid(m.sender_pn) || telefoneDoJid(m.sender) || (!ehGrupo ? telefoneDoJid(chatid) : '') || telefoneDoJid(body.chat?.wa_chatid);
  return {
    tipo: 'mensagem',
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

module.exports = { status, conectar, desconectar, configurarWebhook, listarGrupos, enviarTexto, enviarFoto, enviarNoGrupo, baixarMidia, lerWebhook, idEnviado };
