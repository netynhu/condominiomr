// Regras de negócio usadas pelo agente, pelo painel e pelas rotinas automáticas
const { db, dbGlobal, ok, getConfig, inserirMensagem } = require('./db');
const { condominioAtual } = require('./contexto');
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

// O mesmo telefone em todos os condomínios (para saber de qual prédio é quem escreveu)
async function moradorEmTodos(telefone) {
  const vars = variantesTelefone(telefone);
  if (!vars[0]) return [];
  // Consultas separadas (sem depender das ligações entre tabelas no cache da API do banco)
  const linhas = ok(await dbGlobal.from('moradores').select('id, nome, condominio_id, ativo, conversa_em').in('telefone', vars));
  if (!linhas.length) return [];
  const conds = ok(await dbGlobal.from('condominios').select('id, nome, ativo').in('id', [...new Set(linhas.map((m) => m.condominio_id))]));
  return linhas.map((m) => ({ ...m, condominio: conds.find((c) => c.id === m.condominio_id) || null }))
    .filter((m) => m.condominio && m.condominio.ativo !== false);
}

// Condomínios que a pessoa da equipe atende ("dono" da plataforma vê todos)
async function condominiosDoUsuario(usuario) {
  if (usuario.dono) return ok(await dbGlobal.from('condominios').select('id, nome').eq('ativo', true).order('nome'));
  const ids = ok(await dbGlobal.from('usuario_condominios').select('condominio_id').eq('usuario_id', usuario.id)).map((l) => l.condominio_id);
  if (!ids.length) return [];
  return ok(await dbGlobal.from('condominios').select('id, nome').in('id', ids).eq('ativo', true).order('nome'));
}

// Telefones da equipe do condomínio da vez com os perfis pedidos (ex.: ['zelador'] ou ['sindico','admin'])
async function telefonesDaEquipe(perfis) {
  const id = condominioAtual();
  if (!id) return [];
  const ids = ok(await dbGlobal.from('usuario_condominios').select('usuario_id').eq('condominio_id', id)).map((l) => l.usuario_id);
  if (!ids.length) return [];
  const usuarios = ok(await dbGlobal.from('usuarios').select('telefone, perfil, ativo, dono').in('id', ids));
  // O super admin (dono) não recebe alertas de nenhum condomínio
  return usuarios.filter((u) => !u.dono && u.ativo && u.telefone && perfis.includes(u.perfil)).map((u) => u.telefone);
}

// ---------- Manutenção: quem recebe os chamados ----------
// Horário de trabalho: { dias: [1..5], inicio: '08:00', fim: '17:00' } (0 = domingo). Sem horário = sempre disponível.
function noTurno(turno) {
  if (!turno || !Array.isArray(turno.dias) || !turno.inicio || !turno.fim) return true;
  const { dataISO, hora, minuto } = agoraBR();
  const dia = new Date(`${dataISO}T12:00:00-03:00`).getUTCDay();
  const agora = hora * 60 + minuto;
  const [hi, mi] = turno.inicio.split(':').map(Number);
  const [hf, mf] = turno.fim.split(':').map(Number);
  const ini = hi * 60 + mi; const fim = hf * 60 + mf;
  if (ini <= fim) return turno.dias.includes(dia) && agora >= ini && agora < fim;
  // Turno que passa da meia-noite (ex.: 22h às 6h): vale do início até a meia-noite no dia marcado e depois até o fim
  const ontem = (dia + 6) % 7;
  return (turno.dias.includes(dia) && agora >= ini) || (turno.dias.includes(ontem) && agora < fim);
}

// Telefones da manutenção para um chamado. O síndico escolhe em Ajustes: todos sempre, ou só quem está no horário.
// Chamado urgente vai para todos. Se ninguém estiver no horário, vai para todos, marcado como fora do horário.
async function telefonesManutencao(prioridade) {
  const id = condominioAtual();
  const cfg = await getConfig();
  let links = await dbGlobal.from('usuario_condominios').select('usuario_id, turno').eq('condominio_id', id);
  if (links.error) links = await dbGlobal.from('usuario_condominios').select('usuario_id').eq('condominio_id', id); // antes da migração 014
  const turnos = Object.fromEntries((links.data || []).map((l) => [l.usuario_id, l.turno || null]));
  const ids = Object.keys(turnos);
  const equipe = ids.length ? ok(await dbGlobal.from('usuarios').select('id, telefone, perfil, ativo, dono').in('id', ids))
    .filter((u) => !u.dono && u.ativo && u.telefone && u.perfil === 'zelador') : [];
  if (!equipe.length) return { tels: [normalizarTelefone(cfg.telefone_zelador)].filter(Boolean), foraDoHorario: false };
  const todos = [...new Set(equipe.map((u) => normalizarTelefone(u.telefone)).filter(Boolean))];
  if (cfg.manutencao_envio !== 'horario' || prioridade === 'urgente') return { tels: todos, foraDoHorario: false };
  const agora = [...new Set(equipe.filter((u) => noTurno(turnos[u.id])).map((u) => normalizarTelefone(u.telefone)).filter(Boolean))];
  return agora.length ? { tels: agora, foraDoHorario: false } : { tels: todos, foraDoHorario: true };
}

// Envia direto (mensagens individuais e avisos à equipe). Grava no histórico quando é para morador.
// rotulo: para quem é a mensagem (zelador, síndico...); hoje só informativo.
// Alertas para a equipe começam com o nome do prédio: o mesmo síndico (ou o mesmo número) pode atender vários condomínios
const PARA_EQUIPE = new Set(['síndico', 'zelador', 'portaria']);
async function comNomeDoPredio(texto, rotulo) {
  if (!PARA_EQUIPE.has(rotulo) || !condominioAtual() || String(texto).startsWith('🏢')) return texto;
  const cfg = await getConfig();
  return `🏢 *${cfg.nome_predio}*
${texto}`;
}

async function enviar(telefone, texto, moradorId, rotulo) {
  const tel = normalizarTelefone(telefone);
  if (!tel) return false;
  texto = await comNomeDoPredio(texto, rotulo);
  try {
    const r = await uazapi.enviarTexto(tel, texto);
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
  texto = await comNomeDoPredio(texto, rotulo);
  try {
    const r = await uazapi.enviarMenu(tel, texto, escolhas, { tipo, rodape, botaoLista });
    await inserirMensagem({ morador_id: moradorId || null, telefone: tel, direcao: 'saida', texto: `${texto}\n[botões: ${escolhas.map((e) => e.split('|')[0]).join(' / ')}]`, wa_id: uazapi.idEnviado(r) });
    return true;
  } catch (e) {
    console.error('[botões] falhou, enviando em texto:', e.message);
    return enviar(tel, planoB ? `${texto}\n\n${planoB}` : texto, moradorId, rotulo);
  }
}

// Quem recebe os alertas de cada papel: o WhatsApp de quem está em Equipe e acessos com aquele perfil.
// Síndico: perfil Síndico (sem nenhum, a Administração). O telefone antigo dos Ajustes só vale
// enquanto o condomínio ainda não tem ninguém cadastrado com aquele perfil.
async function telefonesDoPapel(papel) {
  const perfis = { sindico: ['sindico'], zelador: ['zelador'], portaria: ['portaria'] }[papel] || [papel];
  let tels = await telefonesDaEquipe(perfis);
  if (!tels.length && papel === 'sindico') tels = await telefonesDaEquipe(['admin']);
  if (!tels.length) { const cfg = await getConfig(); tels = [cfg[`telefone_${papel}`]]; }
  return [...new Set(tels.map(normalizarTelefone).filter(Boolean))];
}

// Avisa síndico, zelador ou portaria pelo WhatsApp. "exceto": telefones que já receberam a mesma mensagem.
async function avisarEquipe(papel, texto, { exceto = [] } = {}) {
  const tels = (await telefonesDoPapel(papel)).filter((t) => !exceto.includes(t));
  for (const t of tels) await enviar(t, texto, null, papel === 'sindico' ? 'síndico' : papel);
  return tels;
}

const telefonesZeladores = () => telefonesDoPapel('zelador');

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
    const { tels, foraDoHorario } = await telefonesManutencao(prioridade);
    const texto = foraDoHorario ? `🌙 Fora do horário da equipe
${msg}` : msg;
    for (const tel of tels) {
      // Botão que abre o chamado direto no app da manutenção (plano B: o link em texto)
      if (url) await enviarBotoes(tel, texto, [`📋 Abrir chamado|${url}`], { rodape: 'App da manutenção', planoB: `👉 Toque para abrir: ${url}`, rotulo: 'zelador' });
      else await enviar(tel, texto, null, 'zelador');
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
async function postarNoGrupo(titulo, texto, imagemId) {
  const cfg = await getConfig();
  if (!cfg.grupo_jid) throw new Error('Escolha o grupo dos moradores na página do WhatsApp antes de postar avisos.');
  const limpo = String(texto || '').replaceAll('{nome}', '').replace(/^\s*Olá,?\s*!?\s*/i, '').trim();
  // Imagem sem texto: pediram para postar só a imagem, sem legenda nenhuma
  const msg = imagemId && !limpo ? '' : [titulo && `📢 *${titulo}*`, limpo, `_${cfg.nome_predio} · Administração_`].filter(Boolean).join('\n\n');
  if (imagemId) {
    // Aviso com imagem: a imagem vai com o título e o texto como legenda
    const { buffer } = await lerFoto(imagemId);
    await uazapi.enviarImagemNoGrupo(cfg.grupo_jid, buffer, msg);
  } else {
    await uazapi.enviarNoGrupo(cfg.grupo_jid, msg);
  }
  return msg;
}

// Acha ou cria a unidade (bloco + número)
async function unidadeId(bloco, numero) {
  bloco = String(bloco || '').trim().toUpperCase();
  numero = String(numero || '').trim();
  if (!numero) return null;
  const [u] = ok(await db.from('unidades').select('id').eq('bloco', bloco).eq('numero', numero).limit(1));
  if (u) return u.id;
  return ok(await db.from('unidades').insert({ bloco, numero }).select('id').single()).id;
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

  let reincidencia = 0;
  if (unidade_alvo) {
    const desde = new Date(Date.now() - 30 * 86400000).toISOString();
    const recentes = ok(await db.from('reclamacoes').select('unidade_alvo').gte('criado_em', desde).not('unidade_alvo', 'is', null));
    const k = chaveUnidade(unidade_alvo);
    reincidencia = recentes.filter((x) => chaveUnidade(x.unidade_alvo) === k).length;
  }

  // Portaria e síndico recebem toda reclamação nova (sem o nome de quem reclamou)
  const alvo = unidade_alvo ? `Unidade: ${unidade_alvo}\n` : '';
  const msg = `📣 Reclamação nº ${r.id}${acontecendo_agora ? ' · ACONTECENDO AGORA' : ''}\nTipo: ${tipo}\n${alvo}${descricao}\nQuem reclamou fica protegido. Veja no painel.`;
  const cfg = await getConfig();
  const portaria = await avisarEquipe('portaria', msg);

  // O síndico decide em Ajustes: todas as reclamações, só reincidência (a partir de N em 30 dias) ou nenhuma
  const modo = cfg.sindico_reclamacoes || 'todas';
  const minimo = Math.max(2, Number(cfg.sindico_reincidencia_minima) || 3);
  const reincidente = reincidencia >= minimo;
  const alerta = reincidente ? `\n\n⚠️ Reincidência: ${reincidencia} reclamações contra a unidade ${unidade_alvo} nos últimos 30 dias. Vale avaliar uma notificação formal.` : '';
  if (modo === 'todas') {
    await avisarEquipe('sindico', msg + alerta, { exceto: portaria });
    // Quem é portaria e síndico ao mesmo tempo já recebeu a reclamação: só o alerta de reincidência
    if (reincidente) for (const t of (await telefonesDoPapel('sindico')).filter((x) => portaria.includes(x))) await enviar(t, alerta.trim(), null, 'síndico');
  } else if (modo === 'reincidencia' && reincidente) {
    await avisarEquipe('sindico', msg + alerta);
  }
  return { ...r, reincidencia };
}

const TIPO_RECL = (t) => ({ convivencia: 'convivência', outro: 'outro assunto' }[t] || t);

// Portaria/administração atualiza a reclamação. Quem reclamou é avisado (se ligado em Ajustes):
// em tratamento -> "já estão verificando"; resolvida -> o que foi feito + botões "voltou a acontecer" / "está resolvido".
// Arquivada não gera mensagem (pode ser reclamação sem fundamento).
async function atualizarReclamacao(id, status, tratativa, usuarioNome) {
  const patch = { status, tratativa: tratativa || null, tratada_por: usuarioNome };
  if (status === 'resolvida' || status === 'arquivada') patch.tratada_em = new Date().toISOString();
  const r = ok(await db.from('reclamacoes').update(patch).eq('id', id).select('*, autor:moradores(id, nome, telefone, ativo)').single());
  const cfg = await getConfig();
  const autor = r.autor;
  if (cfg.avisar_autor_reclamacao === '0' || !autor || !autor.ativo) return r;
  const nome = primeiroNome(autor.nome);
  if (status === 'em_tratamento') {
    await enviar(autor.telefone, `Olá, ${nome}! Sua reclamação nº ${r.id} (${TIPO_RECL(r.tipo)}) já está sendo verificada.${tratativa ? `\n${tratativa}` : ''}\nTe aviso quando for resolvida.`, autor.id);
  } else if (status === 'resolvida') {
    await enviarBotoes(autor.telefone,
      `Olá, ${nome}! ✅ Sua reclamação nº ${r.id} (${TIPO_RECL(r.tipo)}) foi tratada.${tratativa ? `\nO que foi feito: ${tratativa}` : ''}\n\nSe o problema continuar ou voltar a acontecer, é só me avisar aqui que eu reabro a reclamação.`,
      [`🔁 Voltou a acontecer|reclamacao_voltou:${r.id}`, '👍 Está resolvido|reclamacao_ok'],
      { planoB: 'Se continuar, responda "voltou a acontecer".', moradorId: autor.id });
  }
  return r;
}

// Morador avisa que o problema voltou: reabre a reclamação e avisa portaria e síndico
async function reabrirReclamacao(id, morador, detalhe) {
  const r = ok(await db.from('reclamacoes').select('*').eq('id', id).maybeSingle());
  if (!r || r.autor_morador_id !== morador.id) throw new Error('Reclamação não encontrada para este morador.');
  if (r.status === 'nova' || r.status === 'em_tratamento') return { ...r, jaAberta: true };
  const quando = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());
  const descricao = `${r.descricao}\n[Reaberta em ${quando}] ${detalhe || 'O morador informou que o problema continua.'}`;
  const novo = ok(await db.from('reclamacoes').update({ status: 'nova', tratada_em: null, descricao }).eq('id', id).select().single());
  const cfg = await getConfig();
  const msg = `🔁 Reclamação nº ${id} REABERTA: voltou a acontecer\nTipo: ${TIPO_RECL(r.tipo)}${r.unidade_alvo ? `\nUnidade: ${r.unidade_alvo}` : ''}\n${detalhe || ''}\nQuem reclamou fica protegido. Veja no painel.`;
  const portaria = await avisarEquipe('portaria', msg);
  if ((cfg.sindico_reclamacoes || 'todas') !== 'nenhuma') await avisarEquipe('sindico', msg, { exceto: portaria });
  return novo;
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
  acharMorador, moradorEmTodos, telefonesDaEquipe, telefonesDoPapel, telefonesManutencao, noTurno, condominiosDoUsuario, enviar, enviarBotoes, avisarEquipe, atualizarReclamacao, reabrirReclamacao, boasVindas, boasVindasEmFila, abrirChamado, mudarStatusChamado, registrarReclamacao,
  registrarHistoricoChamado, unidadeId, enfileirar, destinatarios, chaveUnidade, unidadeDaVaga, postarNoGrupo, telefonesZeladores, ROTULO_STATUS,
};
