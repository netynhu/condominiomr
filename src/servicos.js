// Regras de negócio usadas pelo agente, pelo painel e pelas rotinas automáticas
const { db, ok, getConfig, inserirMensagem } = require('./db');
const uazapi = require('./uazapi');
const { env } = require('./config');
const { lerFoto } = require('./fotos');
const { variantesTelefone, normalizarTelefone, primeiroNome, soDigitos, rotuloUnidade, agoraBR } = require('./util');

async function acharMorador(telefone) {
  const vars = variantesTelefone(telefone);
  if (!vars[0]) return null;
  const linhas = ok(await db.from('moradores').select('*, unidade:unidades(*)').in('telefone', vars).limit(1));
  return linhas[0] || null;
}

// Envia direto (mensagens individuais e avisos à equipe). Grava no histórico quando é para morador.
// rotulo: para quem é a mensagem (zelador, síndico...). Na simulação, tudo chega no mesmo celular,
// então a mensagem ganha uma etiqueta para saber quem a receberia.
async function enviar(telefone, texto, moradorId, rotulo) {
  const tel = normalizarTelefone(telefone);
  if (!tel) return false;
  try {
    let final = texto;
    if (rotulo) {
      const simulacao = require('./simulacao');
      if (simulacao.ehTelefoneDaSimulacao(tel, await simulacao.config())) final = `*[→ ${rotulo}]*\n${texto}`;
    }
    const r = await uazapi.enviarTexto(tel, final);
    await inserirMensagem({ morador_id: moradorId || null, telefone: tel, direcao: 'saida', texto, wa_id: uazapi.idEnviado(r) });
    return true;
  } catch (e) {
    console.error('[envio] falhou para', tel, e.message);
    return false;
  }
}

// Mensagem com botões. Se os botões falharem (a Uazapi avisa que podem ser descontinuados),
// manda o mesmo conteúdo em texto, com as opções escritas (planoB).
async function enviarBotoes(telefone, texto, escolhas, { tipo = 'button', rodape = '', botaoLista, planoB = '', moradorId, rotulo } = {}) {
  const tel = normalizarTelefone(telefone);
  if (!tel) return false;
  let final = texto;
  if (rotulo) {
    const simulacao = require('./simulacao');
    if (simulacao.ehTelefoneDaSimulacao(tel, await simulacao.config())) final = `*[→ ${rotulo}]*\n${texto}`;
  }
  try {
    const r = await uazapi.enviarMenu(tel, final, escolhas, { tipo, rodape, botaoLista });
    await inserirMensagem({ morador_id: moradorId || null, telefone: tel, direcao: 'saida', texto: `${texto}\n[botões: ${escolhas.map((e) => e.split('|')[0]).join(' / ')}]`, wa_id: uazapi.idEnviado(r) });
    return true;
  } catch (e) {
    console.error('[botões] falhou, enviando em texto:', e.message);
    return enviar(tel, planoB ? `${texto}\n\n${planoB}` : texto, moradorId, rotulo);
  }
}

// Avisa síndico, zelador ou portaria pelo WhatsApp, se o telefone estiver configurado
async function avisarEquipe(papel, texto) {
  const cfg = await getConfig();
  const tel = cfg[`telefone_${papel}`];
  if (!tel) return false;
  return enviar(tel, texto, null, papel === 'sindico' ? 'síndico' : papel);
}

// Todos os telefones de zelador: o do painel de ajustes e os dos usuários com perfil zelador
async function telefonesZeladores() {
  const cfg = await getConfig();
  const usuarios = ok(await db.from('usuarios').select('telefone').eq('perfil', 'zelador').eq('ativo', true).not('telefone', 'is', null));
  return [...new Set([cfg.telefone_zelador, ...usuarios.map((u) => u.telefone)].map(normalizarTelefone).filter(Boolean))];
}

async function registrarHistoricoChamado(chamadoId, acao, usuarioNome) {
  await db.from('chamado_historico').insert({ chamado_id: chamadoId, acao, usuario_nome: usuarioNome || 'Assistente' });
}

const EMOJI_PRIORIDADE = { urgente: '🚨 URGENTE', alta: '⚠️ Prioridade alta', normal: '🔧', baixa: '🔧' };

function foraDoHorario() {
  const { hora } = agoraBR();
  return hora < 7 || hora >= 22;
}

async function abrirChamado({ morador, titulo, descricao, local, prioridade = 'normal', categoria = 'manutencao', origem = 'whatsapp', usuarioNome, foto, video }) {
  const dados = {
    morador_id: morador?.id || null, titulo, descricao, local, prioridade, categoria, origem, foto: foto || null,
    aberto_por: usuarioNome || (morador ? morador.nome : 'Assistente'),
  };
  if (video) dados.video = video; // só envia a coluna quando há vídeo (migração 004)
  const ch = ok(await db.from('chamados').insert(dados).select().single());
  await registrarHistoricoChamado(ch.id, 'Chamado aberto', usuarioNome || (morador ? morador.nome : 'Assistente'));

  const quem = morador ? `${morador.nome} (${rotuloUnidade(morador.unidade)})` : (usuarioNome || 'Administração');
  const corpo = `Chamado nº ${ch.id}\n${titulo}${local ? `\nLocal: ${local}` : ''}${descricao ? `\n${descricao}` : ''}\nAberto por: ${quem}`;

  if (categoria === 'administracao') {
    await avisarEquipe('sindico', `📋 ${corpo}`);
    return ch;
  }
  // O zelador recebe o aviso com o link direto para o chamado no app (exceto quando foi ele mesmo que abriu)
  if (origem !== 'zelador') {
    const url = env.APP_URL ? `${env.APP_URL}/z/${ch.id}` : '';
    const anexos = [foto && '📷 Tem foto', video && '🎥 Tem vídeo'].filter(Boolean).join(' · ');
    const msg = `${EMOJI_PRIORIDADE[prioridade]} ${corpo}${anexos ? `\n${anexos}` : ''}`;
    for (const tel of await telefonesZeladores()) {
      // Botão que abre o chamado direto no app do zelador (plano B: o link em texto)
      if (url) await enviarBotoes(tel, msg, [`📋 Abrir chamado|${url}`], { rodape: 'App do zelador', planoB: `👉 Toque para abrir: ${url}`, rotulo: 'zelador' });
      else await enviar(tel, msg, null, 'zelador');
    }
  }
  if (prioridade === 'urgente' || (prioridade === 'alta' && foraDoHorario())) {
    await avisarEquipe('sindico', `${EMOJI_PRIORIDADE[prioridade]} ${corpo}`);
  }
  return ch;
}

const ROTULO_STATUS = { aberto: 'aberto', em_andamento: 'em andamento', resolvido: 'resolvido', cancelado: 'cancelado' };

async function mudarStatusChamado(id, status, observacao, usuarioNome, fotoConclusao) {
  const agora = new Date().toISOString();
  const patch = { status, atualizado_em: agora };
  if (observacao) patch.observacao_equipe = observacao;
  if (status === 'resolvido') { patch.resolvido_em = agora; if (fotoConclusao) patch.foto_conclusao = fotoConclusao; }
  const ch = ok(await db.from('chamados').update(patch).eq('id', id).select('*, morador:moradores(*)').single());
  await registrarHistoricoChamado(id, `Status: ${ROTULO_STATUS[status]}${observacao ? ` (${observacao})` : ''}${fotoConclusao ? ' com foto' : ''}`, usuarioNome);
  if (ch.morador && ch.morador.ativo) {
    const nome = primeiroNome(ch.morador.nome);
    const tel = ch.morador.telefone;
    if (status === 'resolvido') {
      const texto = `Olá, ${nome}! ✅ Seu chamado nº ${id} (${ch.titulo}) foi resolvido.${observacao ? `\nObservação da equipe: ${observacao}` : ''}`;
      let foiComFoto = false;
      if (fotoConclusao) {
        try {
          const { buffer } = await lerFoto(fotoConclusao);
          await uazapi.enviarFoto(tel, buffer, texto);
          await db.from('mensagens').insert({ morador_id: ch.morador.id, telefone: tel, direcao: 'saida', texto: `[foto do serviço] ${texto}` });
          foiComFoto = true;
        } catch (e) { console.error('[chamado] foto não enviada', e.message); }
      }
      if (!foiComFoto) await enviar(tel, texto, ch.morador.id);
      // Pede a nota do atendimento (a resposta é tratada pelo agente)
      await enviarBotoes(tel, 'Que nota você dá para esse atendimento? Se ainda houver algum problema, é só me contar.', ['[Sua nota]', '5 · Excelente|5', '4 · Bom|4', '3 · Regular|3', '2 · Ruim|2', '1 · Péssimo|1'],
        { tipo: 'list', botaoLista: 'Dar nota', planoB: 'Responda com um número de 1 a 5.', moradorId: ch.morador.id });
      await db.from('chamados').update({ avaliacao_pedida_em: agora }).eq('id', id);
    } else if (status === 'em_andamento') {
      await enviar(tel, `Olá, ${nome}! 🔧 A equipe já está cuidando do seu chamado nº ${id} (${ch.titulo}).${observacao ? `\n${observacao}` : ''}`, ch.morador.id);
    } else if (status === 'cancelado') {
      await enviar(tel, `Olá, ${nome}. O chamado nº ${id} (${ch.titulo}) foi encerrado sem execução.${observacao ? `\nMotivo: ${observacao}` : ''}`, ch.morador.id);
    }
  }
  return ch;
}

// Avisos oficiais no grupo dos moradores (o assistente não conversa no grupo, só posta)
async function postarNoGrupo(titulo, texto) {
  const cfg = await getConfig();
  if (!cfg.grupo_jid) throw new Error('Escolha o grupo dos moradores na página do WhatsApp antes de postar avisos.');
  const limpo = String(texto).replaceAll('{nome}', '').replace(/^\s*Olá,?\s*!?\s*/i, '').trim();
  const msg = `📢 *${titulo}*\n\n${limpo}\n\n_${cfg.nome_predio} · Administração_`;
  await uazapi.enviarNoGrupo(cfg.grupo_jid, msg);
  return msg;
}

// Compara unidades ignorando letras e espaços ("209", "apto 209", "B-209")
const chaveUnidade = (s) => soDigitos(s) || String(s || '').trim().toLowerCase();

// Descobre a unidade dona de uma vaga ("12" encontra quem tem "12" ou "12, 13")
async function unidadeDaVaga(vaga) {
  const alvo = String(vaga || '').trim().toLowerCase();
  if (!alvo) return null;
  const lista = ok(await db.from('moradores').select('vaga, unidade:unidades(bloco, numero)').not('vaga', 'is', null));
  const dono = lista.find((m) => m.unidade && m.vaga.toLowerCase().split(/\s+e\s+|[\s,;/]+/).filter(Boolean).includes(alvo));
  return dono ? (dono.unidade.bloco ? `${dono.unidade.bloco}-${dono.unidade.numero}` : dono.unidade.numero) : null;
}

async function registrarReclamacao({ morador, tipo, unidade_alvo, vaga_alvo, descricao, acontecendo_agora }) {
  if (vaga_alvo) {
    descricao = `${descricao} [vaga ${vaga_alvo}]`;
    if (!unidade_alvo) unidade_alvo = await unidadeDaVaga(vaga_alvo);
  }
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

const textoBoasVindas = (m, cfg, titulo) => `${titulo ? `${titulo}, ` : 'Olá, '}${primeiroNome(m.nome)}! Você foi cadastrado(a) no assistente do ${cfg.nome_predio}${m.unidade ? ` (${rotuloUnidade(m.unidade)})` : ''}.\n\nPor aqui você abre chamados de manutenção, faz reclamações sem se expor, tira dúvidas sobre as regras e fica sabendo dos eventos e obras. Pode mandar texto, áudio, foto ou vídeo.`;

// Mensagem de boas-vindas ao morador recém-cadastrado, com o botão para entrar no grupo dos moradores
async function boasVindas(morador, titulo = '') {
  const cfg = await getConfig();
  const m = morador.unidade || !morador.unidade_id ? morador : ok(await db.from('moradores').select('*, unidade:unidades(*)').eq('id', morador.id).single());
  const texto = textoBoasVindas(m, cfg, titulo);
  if (cfg.grupo_convite) {
    return enviarBotoes(m.telefone, `${texto}\n\nToque abaixo para entrar no grupo dos moradores.`, [`👥 Entrar no grupo|${cfg.grupo_convite}`],
      { rodape: cfg.grupo_nome || 'Grupo dos moradores', planoB: `Entre no grupo dos moradores: ${cfg.grupo_convite}`, moradorId: m.id });
  }
  return enviar(m.telefone, texto, m.id);
}

// Boas-vindas para muitos de uma vez (importação): vai pela fila lenta, em texto com o link do grupo
async function boasVindasEmFila(moradores) {
  const cfg = await getConfig();
  const linhas = moradores.map((m) => ({ telefone: m.telefone, texto: `${textoBoasVindas(m, cfg)}${cfg.grupo_convite ? `\n\n👥 Grupo dos moradores: ${cfg.grupo_convite}` : ''}` }));
  for (let i = 0; i < linhas.length; i += 500) ok(await db.from('fila_envio').insert(linhas.slice(i, i + 500)));
  return linhas.length;
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
  acharMorador, enviar, enviarBotoes, avisarEquipe, boasVindas, boasVindasEmFila, abrirChamado, mudarStatusChamado, registrarReclamacao,
  registrarHistoricoChamado, enfileirar, destinatarios, chaveUnidade, unidadeDaVaga, postarNoGrupo, telefonesZeladores, ROTULO_STATUS,
};
