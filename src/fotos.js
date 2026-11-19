// Fotos dos chamados, guardadas na tabela "fotos" do banco (em base64).
// As fotos chegam comprimidas (cerca de 200 KB), então o banco aguenta bem o volume de um prédio.
const { db, ok } = require('./db');

const LIMITE = 6 * 1024 * 1024;

async function salvarFoto(buffer, mime = 'image/jpeg', pasta = 'chamados') {
  if (!buffer?.length) throw new Error('Foto vazia');
  if (buffer.length > LIMITE) throw new Error('Foto grande demais');
  const f = ok(await db.from('fotos').insert({ pasta, mime, dados: buffer.toString('base64') }).select('id').single());
  return f.id;
}

async function lerFoto(id) {
  const f = ok(await db.from('fotos').select('mime, dados').eq('id', id).maybeSingle());
  if (!f) throw new Error('Foto não encontrada');
  return { buffer: Buffer.from(f.dados, 'base64'), mime: f.mime || 'image/jpeg' };
}

// "data:image/jpeg;base64,...." (vinda do celular) -> buffer
function dataUrlParaBuffer(dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > LIMITE) return null;
  return { buffer, mime: m[1].toLowerCase() };
}

module.exports = { salvarFoto, lerFoto, dataUrlParaBuffer };
