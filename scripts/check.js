// Verificação rápida: carrega todos os módulos e compila todas as telas.
// Uso: npm run check
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const raiz = path.join(__dirname, '..');
let falhas = 0;

for (const m of ['config', 'db', 'util', 'uazapi', 'ia', 'servicos', 'agente', 'agente_admin', 'rotinas', 'fotos', 'icones', 'rotas/comum', 'rotas/acesso', 'rotas/zelador', 'rotas/whatsapp', 'rotas/cadastro', 'rotas/operacao', 'rotas/inteligencia']) {
  try { require(path.join(raiz, 'src', m)); } catch (e) { falhas++; console.error('Módulo', m, '->', e.message); }
}

const pasta = path.join(raiz, 'views');
const arquivos = [...fs.readdirSync(pasta).filter((f) => f.endsWith('.ejs')), ...fs.readdirSync(path.join(pasta, 'z')).filter((f) => f.endsWith('.ejs')).map((f) => 'z/' + f)];
for (const f of arquivos) {
  try { ejs.compile(fs.readFileSync(path.join(pasta, f), 'utf8'), { filename: path.join(pasta, f) }); } catch (e) { falhas++; console.error('Tela', f, '->', e.message); }
}

// Leitura do webhook com os formatos documentados da Uazapi
const { lerWebhook } = require(path.join(raiz, 'src', 'uazapi'));
const { variantesTelefone } = require(path.join(raiz, 'src', 'util'));
const casos = [
  [{ EventType: 'messages', message: { chatid: '5511999998888@s.whatsapp.net', sender: '5511999998888@s.whatsapp.net', fromMe: false, isGroup: false, text: 'oi', senderName: 'Carla' } }, (r) => r.tipo === 'mensagem' && !r.ehGrupo && r.telefone === '5511999998888' && r.texto === 'oi'],
  [{ EventType: 'messages', message: { chatid: '1203630@g.us', sender: '123@lid', sender_pn: '5511988887777@s.whatsapp.net', isGroup: true, text: 'portão quebrado' } }, (r) => r.ehGrupo && r.telefone === '5511988887777'],
  [{ EventType: 'messages', message: { fromMe: true, text: 'x' } }, (r) => r.tipo === 'ignorar'],
  [{ EventType: 'connection', instance: { status: 'connected' } }, (r) => r.tipo === 'conexao' && r.estado === 'connected'],
];
casos.forEach(([body, teste], i) => { if (!teste(lerWebhook(body))) { falhas++; console.error('Webhook caso', i + 1, 'falhou', lerWebhook(body)); } });
const v = variantesTelefone('5511999998888');
if (!v.includes('551199998888')) { falhas++; console.error('Variante sem o 9 não gerada', v); }

console.log(falhas ? `${falhas} problema(s) encontrado(s).` : `Tudo certo: ${arquivos.length} telas e todos os módulos carregados.`);
process.exit(falhas ? 1 : 0);
