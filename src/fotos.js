// Fotos e vídeos dos chamados, guardados na tabela "fotos" do banco (em base64).
// Fotos chegam comprimidas (cerca de 200 KB). Vídeos têm limite de tamanho.
const { db, ok } = require('./db');

const LIMITE_FOTO = 6 * 1024 * 1024;
const LIMITE_VIDEO = 12 * 1024 * 1024;

async function salvarArquivo(buffer, mime, pasta) {
  if (!buffer?.length) throw new Error('Arquivo vazio');
  const limite = String(mime).startsWith('video/') ? LIMITE_VIDEO : LIMITE_FOTO;
  if (buffer.length > limite) throw new Error('Arquivo grande demais');
  const f = ok(await db.from('fotos').insert({ pasta, mime, dados: buffer.toString('base64') }).select('id').single());
  return f.id;
}

const salvarFoto = (buffer, mime = 'image/jpeg', pasta = 'chamados') => salvarArquivo(buffer, mime, pasta);
const salvarVideo = (buffer, mime = 'video/mp4') => salvarArquivo(buffer, mime, 'videos');

async function lerFoto(id) {
  const f = ok(await db.from('fotos').select('mime, dados').eq('id', id).maybeSingle());
  if (!f) throw new Error('Arquivo não encontrado');
  return { buffer: Buffer.from(f.dados, 'base64'), mime: f.mime || 'image/jpeg' };
}

// "data:image/jpeg;base64,...." (vinda do celular) -> buffer
function dataUrlParaBuffer(dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > LIMITE_FOTO) return null;
  return { buffer, mime: m[1].toLowerCase() };
}

module.exports = { salvarFoto, salvarVideo, lerFoto, dataUrlParaBuffer, LIMITE_VIDEO };
