// Cria (ou atualiza) os dados da simulação: 5 moradores fictícios, zelador e síndico,
// e liga o modo simulação para o WhatsApp informado.
// Uso: node scripts/simulacao.js 11999998888
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, ok, setConfig } = require('../src/db');
const { env } = require('../src/config');
const { normalizarTelefone } = require('../src/util');

const tel = normalizarTelefone(process.argv[2] || '');
if (tel.length < 12) { console.error('Informe o WhatsApp da simulação. Ex.: node scripts/simulacao.js 11999998888'); process.exit(1); }

const MORADORES = [
  { nome: 'Carla Mendes', bloco: 'B', numero: '304', vaga: '12', tipo: 'proprietario', fatos: ['Tem um cachorro pequeno chamado Thor', 'Prefere ser chamada de Carla'] },
  { nome: 'João Pereira', bloco: 'A', numero: '101', vaga: '3', tipo: 'inquilino', fatos: ['Trabalha à noite e dorme de manhã'] },
  { nome: 'Marina Costa', bloco: 'A', numero: '209', vaga: '18', tipo: 'proprietario', fatos: ['Tem dois filhos pequenos'] },
  { nome: 'Ricardo Alves', bloco: 'B', numero: '502', vaga: '27', tipo: 'proprietario', fatos: ['Faz parte do conselho fiscal'] },
  { nome: 'Helena Souza', bloco: 'B', numero: '104', vaga: '7', tipo: 'proprietario', fatos: ['Tem 78 anos e prefere mensagens simples', 'Gosta de ser chamada de Dona Helena'] },
];

async function unidadeId(bloco, numero) {
  const [u] = ok(await db.from('unidades').select('id').eq('bloco', bloco).eq('numero', numero).limit(1));
  if (u) return u.id;
  return ok(await db.from('unidades').insert({ bloco, numero }).select('id').single()).id;
}

async function usuario({ nome, email, perfil, telefone }) {
  const [u] = ok(await db.from('usuarios').select('id').eq('email', email).limit(1));
  const dados = { nome, perfil, telefone, ativo: true };
  if (u) { ok(await db.from('usuarios').update(dados).eq('id', u.id)); return u.id; }
  return ok(await db.from('usuarios').insert({ ...dados, email, senha_hash: await bcrypt.hash(crypto.randomBytes(12).toString('hex'), 10) }).select('id').single()).id;
}

(async () => {
  for (const [i, m] of MORADORES.entries()) {
    const telefone = `5500000000${String(i + 1).padStart(3, '0')}`; // número fictício: nunca recebe mensagem de verdade
    const dados = { nome: m.nome, telefone, vaga: m.vaga, tipo: m.tipo, ativo: true, aceita_avisos: true, unidade_id: await unidadeId(m.bloco, m.numero) };
    const [ex] = ok(await db.from('moradores').select('id').eq('telefone', telefone).limit(1));
    const id = ex ? (ok(await db.from('moradores').update(dados).eq('id', ex.id)), ex.id) : ok(await db.from('moradores').insert(dados).select('id').single()).id;
    const fatos = ok(await db.from('memoria').select('fato').eq('morador_id', id)).map((f) => f.fato);
    for (const fato of m.fatos) if (!fatos.includes(fato)) ok(await db.from('memoria').insert({ morador_id: id, fato, origem: 'administracao' }));
    console.log(`#${i + 1} ${m.nome} · bloco ${m.bloco} apto ${m.numero} · vaga ${m.vaga}`);
  }

  const zeladorId = await usuario({ nome: 'Seu José (zelador)', email: 'zelador.simulacao@sem-email.local', perfil: 'zelador', telefone: tel });
  const token = crypto.randomBytes(24).toString('hex');
  const r = await db.from('usuarios').update({ token_acesso: token }).eq('id', zeladorId);
  const semToken = Boolean(r.error);
  if (semToken) console.log('\nAVISO: não deu para gerar o link do zelador agora:', r.error.message);
  await usuario({ nome: 'Síndico (simulação)', email: 'sindico.simulacao@sem-email.local', perfil: 'admin', telefone: null });

  await setConfig({ simulacao_ativa: '1', simulacao_telefone: tel, simulacao_persona: 'morador:1', telefone_sindico: tel });
  console.log('\nZelador: Seu José (recebe os chamados no WhatsApp da simulação)');
  console.log('Síndico: Síndico (simulação) (use #sindico no WhatsApp; alertas chegam no mesmo número)');
  if (!semToken) console.log(`\nLink do app do zelador: ${env.APP_URL || '<APP_URL>'}/entrar/${token}`);
  console.log(`\nModo simulação LIGADO para ${tel}. Mande #menu na conversa com você mesmo.`);
})().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
