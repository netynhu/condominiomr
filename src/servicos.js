// Regras de negócio usadas pelo agente, pelo painel e pelas rotinas automáticas
const { db, ok, getConfig } = require('./db');
const uazapi = require('./uazapi');
const { variantesTelefone, normalizarTelefone, primeiroNome, soDigitos, rotuloUnidade } = require('./util');

async function acharMorador(telefone) {
  const vars = variantesTelefone(telefone);
  if (!vars[0]) return null;
  const linhas = ok(await db.from('moradores').select('*, unidade:unidades(*)').in('telefone', vars).limit(1));
  return linhas[0] || null;
}

// Envia direto (mensagens individuais e avisos à equipe). Grava no histórico quando é para morador.
async function enviar(telefone, texto, moradorId) {
  const tel = normalizarTelefone(telefone);
  if (!tel) return false;
  try {
    await uazapi.enviarTexto(tel, texto);
    await db.from('mensagens').insert({ morador_id: moradorId || null, telefone: tel, direcao: 'saida', texto });
    return true;
  } catch (e) {
    console.error('[envio] falhou para', tel, e.message);
    return false;
  }
}

// Avisa síndico, zelador ou portaria pelo WhatsApp, se o telefone estiver configurado
async function avisarEquipe(papel, texto) {
  const cfg = await getConfig();
  const tel = cfg[`telefone_${papel}`];
  if (!tel) return false;
  return enviar(tel, texto);
}

async function registrarHistoricoChamado(chamadoId, acao, usuarioNome) {
  await db.from('chamado_historico').insert({ chamado_id: chamadoId, acao, usuario_nome: usuarioNome || 'Assistente' });
}

async function abrirChamado({ morador, titulo, descricao, local, prioridade = 'normal', categoria = 'manutencao', origem = 'whatsapp', usuarioNome }) {
  const ch = ok(await db.from('chamados').insert({
    morador_id: morador?.id || null, titulo, descricao, local, prioridade, categoria, origem,
  }).select().single());
  await registrarHistoricoChamado(ch.id, 'Chamado aberto', usuarioNome || (morador ? morador.nome : 'Assistente'));
  const quem = morador ? `${morador.nome} (${rotuloUnidade(morador.unidade)})` : 'Administração';
  const msg = `Novo chamado nº ${ch.id} [${prioridade}]\n${titulo}${local ? `\nLocal: ${local}` : ''}${descricao ? `\n${descricao}` : ''}\nAberto por: ${quem}`;
  if (categoria === 'administracao') await avisarEquipe('sindico', msg);
  else {
    await avisarEquipe('zelador', msg);
    if (prioridade === 'urgente') await avisarEquipe('sindico', 'URGENTE. ' + msg);
  }
  return ch;
}

const ROTULO_STATUS = { aberto: 'aberto', em_andamento: 'em andamento', resolvido: 'resolvido', cancelado: 'cancelado' };

async function mudarStatusChamado(id, status, observacao, usuarioNome) {
  const agora = new Date().toISOString();
  const patch = { status, atualizado_em: agora };
  if (observacao) patch.observacao_equipe = observacao;
  if (status === 'resolvido') patch.resolvido_em = agora;
  const ch = ok(await db.from('chamados').update(patch).eq('id', id).select('*, morador:moradores(*)').single());
  await registrarHistoricoChamado(id, `Status: ${ROTULO_STATUS[status]}${observacao ? ` (${observacao})` : ''}`, usuarioNome);
  if (ch.morador) {
    const nome = primeiroNome(ch.morador.nome);
    let texto;
    if (status === 'resolvido') texto = `Olá, ${nome}. Seu chamado nº ${id} (${ch.titulo}) foi resolvido.${observacao ? `\nObservação da equipe: ${observacao}` : ''}\nSe ainda houver algum problema, é só me responder.`;
    else if (status === 'em_andamento') texto = `Olá, ${nome}. A equipe já está cuidando do seu chamado nº ${id} (${ch.titulo}).${observacao ? `\n${observacao}` : ''}`;
    else if (status === 'cancelado') texto = `Olá, ${nome}. O chamado nº ${id} (${ch.titulo}) foi encerrado sem execução.${observacao ? `\nMotivo: ${observacao}` : ''}`;
    if (texto) await enviar(ch.morador.telefone, texto, ch.morador.id);
  }
  return ch;
}

// Compara unidades ignorando letras e espaços ("209", "apto 209", "B-209")
const chaveUnidade = (s) => soDigitos(s) || String(s || '').trim().toLowerCase();

async function registrarReclamacao({ morador, tipo, unidade_alvo, descricao, acontecendo_agora }) {
  const r = ok(await db.from('reclamacoes').insert({
    autor_morador_id: morador?.id || null, tipo, unidade_alvo: unidade_alvo || null, descricao, acontecendo_agora: !!acontecendo_agora,
  }).select().single());

  const alvo = unidade_alvo ? `Unidade: ${unidade_alvo}\n` : '';
  await avisarEquipe('portaria', `Reclamação nº ${r.id}${acontecendo_agora ? ' (acontecendo agora)' : ''}\nTipo: ${tipo}\n${alvo}${descricao}\nAutor protegido. Veja no painel.`);

  let reincidencia = 0;
  if (unidade_alvo) {
    const desde = new Date(Date.now() - 30 * 86400000).toISOString();
    const recentes = ok(await db.from('reclamacoes').select('unidade_alvo').gte('criado_em', desde).not('unidade_alvo', 'is', null));
    const k = chaveUnidade(unidade_alvo);
    reincidencia = recentes.filter((x) => chaveUnidade(x.unidade_alvo) === k).length;
    if (reincidencia >= 3) {
      await avisarEquipe('sindico', `Alerta de reincidência: a unidade ${unidade_alvo} recebeu ${reincidencia} reclamações nos últimos 30 dias (a mais recente: ${tipo}). Vale avaliar uma notificação formal. Detalhes no painel.`);
    }
  }
  return { ...r, reincidencia };
}

// Lista de destinatários de um aviso: "todos" ou "bloco:B"
async function destinatarios(publico) {
  let q = db.from('moradores').select('id, nome, telefone, unidade:unidades(bloco)').eq('ativo', true).eq('aceita_avisos', true);
  const linhas = ok(await q);
  if (publico && publico.startsWith('bloco:')) {
    const b = publico.slice(6).trim().toLowerCase();
    return linhas.filter((m) => (m.unidade?.bloco || '').toLowerCase() === b);
  }
  return linhas;
}

function personalizar(texto, nome) {
  const p = primeiroNome(nome);
  if (texto.includes('{nome}')) return texto.replaceAll('{nome}', p);
  return `Olá, ${p}!\n\n${texto}`;
}

async function enfileirar(publico, texto, avisoId) {
  const lista = await destinatarios(publico);
  if (!lista.length) return 0;
  const linhas = lista.map((m) => ({ telefone: m.telefone, texto: personalizar(texto, m.nome), aviso_id: avisoId || null }));
  for (let i = 0; i < linhas.length; i += 500) ok(await db.from('fila_envio').insert(linhas.slice(i, i + 500)));
  return linhas.length;
}

module.exports = {
  acharMorador, enviar, avisarEquipe, abrirChamado, mudarStatusChamado, registrarReclamacao,
  registrarHistoricoChamado, enfileirar, destinatarios, chaveUnidade, ROTULO_STATUS,
};
