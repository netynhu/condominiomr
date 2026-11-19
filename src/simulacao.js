// Modo simulação: um único WhatsApp faz o papel de vários moradores e do síndico.
// - Os moradores fictícios têm telefones fictícios (5500000000001...). Nada é enviado a eles:
//   as mensagens são redirecionadas para o telefone da simulação, com a etiqueta de quem receberia.
// - No celular da simulação, o usuário troca de identidade com comandos: #1 a #5, #sindico, #quem.
// - Com a simulação ligada, o assistente ignora qualquer outra conversa privada (proteção do número pessoal).
const { db, ok, getConfig, setConfig } = require('./db');
const { variantesTelefone, rotuloUnidade, primeiroNome } = require('./util');

const FICTICIO = /^5500000000\d{3}$/;
const NOVO = '5500000000999'; // pessoa que ainda não é morador (#novo)
const ehFicticio = (tel) => FICTICIO.test(String(tel || ''));

async function config() {
  const cfg = await getConfig();
  return { ativa: cfg.simulacao_ativa === '1' && !!cfg.simulacao_telefone, telefone: cfg.simulacao_telefone || '', persona: cfg.simulacao_persona || 'morador:1' };
}

const ehTelefoneDaSimulacao = (tel, sim) => sim.ativa && variantesTelefone(tel).includes(sim.telefone);

async function moradoresFicticios() {
  const l = ok(await db.from('moradores').select('*, unidade:unidades(*)').like('telefone', '5500000000%').order('telefone'));
  return l.filter((m) => ehFicticio(m.telefone) && m.telefone !== NOVO);
}

async function adminDaSimulacao() {
  const [u] = ok(await db.from('usuarios').select('id, nome, perfil, telefone').eq('perfil', 'admin').eq('ativo', true).ilike('nome', '%simula%').limit(1));
  return u || { id: 'simulacao', nome: 'Síndico (simulação)', perfil: 'admin' };
}

function menu(moradores) {
  return `🧪 *Modo simulação*\nVocê troca de identidade mandando um comando:\n${moradores.map((m, i) => `#${i + 1}  ${m.nome} (${rotuloUnidade(m.unidade)})`).join('\n')}\n#novo  Pessoa que ainda não é morador (testa o pedido de cadastro)\n#sindico  Administração (comandos de aviso, agenda, chamados)\n#quem  mostra quem você é agora\n\nTudo que o sistema enviaria para moradores, zelador ou síndico chega aqui, com a etiqueta de quem receberia.`;
}

// Trata comandos "#..." e diz para quem a mensagem vai. Retorna { resposta } para comandos,
// { admin } para falar como síndico, { morador } para falar como morador.
async function rotear(texto) {
  const sim = await config();
  const moradores = await moradoresFicticios();
  const cmd = String(texto || '').trim().toLowerCase();

  if (cmd.startsWith('#')) {
    if (/^#(menu|ajuda|help)$/.test(cmd)) return { resposta: menu(moradores) };
    if (/^#(sindico|síndico|adm|admin)$/.test(cmd)) {
      await setConfig({ simulacao_persona: 'sindico' });
      return { resposta: '🧪 Agora você é a *administração*. Peça, por exemplo: "coloca aviso de manutenção do elevador na terça das 9h às 12h".' };
    }
    const n = /^#(\d)$/.exec(cmd);
    if (n && moradores[Number(n[1]) - 1]) {
      const m = moradores[Number(n[1]) - 1];
      await setConfig({ simulacao_persona: `morador:${n[1]}` });
      return { resposta: `🧪 Agora você é *${m.nome}* (${rotuloUnidade(m.unidade)}${m.vaga ? `, vaga ${m.vaga}` : ''}). Pode conversar com o assistente.` };
    }
    if (cmd === '#novo') {
      await db.from('contatos_pendentes').delete().eq('telefone', NOVO);
      await db.from('moradores').delete().eq('telefone', NOVO);
      await setConfig({ simulacao_persona: 'novo' });
      return { resposta: '🧪 Agora você é *uma pessoa que ainda não é morador*. Mande qualquer mensagem para ver o pedido de cadastro. O pedido de aprovação chega aqui como síndico.' };
    }
    if (cmd === '#quem') {
      if (sim.persona === 'sindico') return { resposta: '🧪 Você está como *administração*.' };
      const m = moradores[Number(sim.persona.split(':')[1] || 1) - 1];
      return { resposta: m ? `🧪 Você está como *${m.nome}* (${rotuloUnidade(m.unidade)}).` : menu(moradores) };
    }
    return { resposta: menu(moradores) };
  }

  if (sim.persona === 'sindico') return { admin: await adminDaSimulacao() };
  if (sim.persona === 'novo') {
    const [novo] = ok(await db.from('moradores').select('*, unidade:unidades(*)').eq('telefone', NOVO).limit(1));
    return novo && novo.ativo ? { morador: novo } : { desconhecido: NOVO };
  }
  const m = moradores[Number(sim.persona.split(':')[1] || 1) - 1];
  return m ? { morador: m } : { resposta: menu(moradores) };
}

// Morador que está sendo representado agora (para as mensagens que ele manda no grupo)
async function moradorAtual() {
  const sim = await config();
  if (sim.persona === 'sindico') return null;
  const moradores = await moradoresFicticios();
  return moradores[Number(sim.persona.split(':')[1] || 1) - 1] || null;
}

// Para onde vai de verdade uma mensagem endereçada a um telefone fictício, e com qual etiqueta
async function destino(numero) {
  if (!ehFicticio(numero)) return { numero, etiqueta: '' };
  const sim = await config();
  if (!sim.telefone) throw new Error('Telefone fictício sem simulação ligada: envio cancelado.');
  const [m] = ok(await db.from('moradores').select('nome, unidade:unidades(*)').eq('telefone', numero).limit(1));
  return { numero: sim.telefone, etiqueta: m ? `*[→ ${primeiroNome(m.nome)} · ${rotuloUnidade(m.unidade)}]*\n` : '*[→ morador fictício]*\n' };
}

module.exports = { config, ehFicticio, ehTelefoneDaSimulacao, rotear, moradorAtual, destino, moradoresFicticios };
