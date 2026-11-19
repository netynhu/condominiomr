// Fotos dos chamados, guardadas na pasta privada "fotos" do Supabase Storage
const crypto = require('crypto');
const { db } = require('./db');

const BUCKET = 'fotos';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function salvarFoto(buffer, mime = 'image/jpeg', pasta = 'chamados') {
  const caminho = `${pasta}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${EXT[mime] || 'jpg'}`;
  const { error } = await db.storage.from(BUCKET).upload(caminho, buffer, { contentType: mime, upsert: false });
  if (error) throw new Error('Falha ao guardar a foto: ' + error.message);
  return caminho;
}

async function lerFoto(caminho) {
  const { data, error } = await db.storage.from(BUCKET).download(caminho);
  if (error) throw new Error('Foto não encontrada');
  return { buffer: Buffer.from(await data.arrayBuffer()), mime: data.type || 'image/jpeg' };
}

// "data:image/jpeg;base64,...." (vinda do celular) -> buffer
function dataUrlParaBuffer(dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > 8 * 1024 * 1024) return null;
  return { buffer, mime: m[1].toLowerCase() };
}

module.exports = { salvarFoto, lerFoto, dataUrlParaBuffer };
