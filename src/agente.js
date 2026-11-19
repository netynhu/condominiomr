// O assistente que conversa com cada morador no privado
const { db, ok, getConfig } = require('./db');
const { env } = require('./config');
const { toFile } = require('openai');
const { openai, completar, descreverImagem } = require('./ia');
const sv = require('./servicos');
const uazapi = require('./uazapi');
const { salvarFoto, salvarVideo, LIMITE_VIDEO } = require('./fotos');
const { inserirMensagem } = require('./db');
const { rotuloUnidade, dataExtenso, primeiroNome, normalizarTelefone, dataHora, hojeParaIA } = require('./util');

const LIMITE_DOCS = 40000; // caracteres de regimento/convenção enviados ao modelo
const HISTORICO = 16;      // mensagens anteriores lembradas na conversa

// Uma conversa por vez para cada telefone (evita respostas cruzadas quando a pessoa manda várias mensagens)
const filas = new Map();
function emSequencia(chave, tarefa) {
  const anterior = filas.get(chave) || Promise.resolve();
  const proxima = anterior.catch(() => {}).then(tarefa);
  filas.set(chave, proxima);
  proxima.catch(() => {}).finally(() => { if (filas.get(chave) === proxima) filas.delete(chave); });
  return proxima;
}

const FERRAMENTAS = [
  {
    name: 'abrir_chamado',
    description: 'Abre um chamado de manutenção, limpeza ou segurança para a equipe do prédio. Use quando o morador relatar algo quebrado, sujo, com defeito ou inseguro nas áreas comuns. Confirme o local antes, se não estiver claro.',
    parameters: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Resumo curto, ex.: "Lâmpada queimada no corredor do 3º andar"' },
        descricao: { type: 'string' },
        local: { type: 'string', description: 'Onde fica o problema' },
        categoria: { type: 'string', enum: ['manutencao', 'limpeza', 'seguranca'] },
        prioridade: { type: 'string', enum: ['baixa', 'normal', 'alta', 'urgente'], description: 'urgente só para risco a pessoas, vazamento grande, elevador com gente presa, falta total de água ou luz' },
      },
      required: ['titulo', 'local', 'prioridade'],
    },
  },
  {
    name: 'consultar_meus_chamados',
    description: 'Lista os chamados recentes deste morador e o status de cada um.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'registrar_reclamacao',
    description: 'Registra uma reclamação de convivência (barulho, vaga, animal, lixo, obra, comportamento). O nome de quem reclama nunca é mostrado à portaria nem a outros moradores.',
    parameters: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['barulho', 'vaga', 'animal', 'lixo', 'obra', 'convivencia', 'outro'] },
        unidade_alvo: { type: 'string', description: 'Unidade de onde vem o problema, se o morador souber. Ex.: "209" ou "B-209"' },
        vaga_alvo: { type: 'string', description: 'Número da vaga de garagem envolvida, se for problema de vaga (ex.: carro parado na vaga dele). O sistema descobre a unidade dona da vaga sozinho; nunca diga ao morador de quem é a vaga.' },
        descricao: { type: 'string' },
        acontecendo_agora: { type: 'boolean' },
      },
      required: ['tipo', 'descricao', 'acontecendo_agora'],
    },
  },
  {
    name: 'consultar_agenda',
    description: 'Consulta eventos, reuniões, obras e manutenções programadas do condomínio.',
    parameters: { type: 'object', properties: { dias: { type: 'integer', description: 'Quantos dias à frente (padrão 30)' } } },
  },
  {
    name: 'agendar_lembrete',
    description: 'Agenda uma mensagem de lembrete para este morador em uma data e hora.',
    parameters: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'O que lembrar' },
        quando: { type: 'string', description: 'Data e hora no fuso de Brasília, formato AAAA-MM-DDTHH:MM' },
      },
      required: ['texto', 'quando'],
    },
  },
  {
    name: 'salvar_memoria',
    description: 'Guarda um fato útil e duradouro sobre o morador para lembrar nas próximas conversas (ex.: como prefere ser chamado, tem um cachorro, trabalha à noite). Não guarde dados de saúde, religião, política, vida íntima ou finanças pessoais.',
    parameters: { type: 'object', properties: { fato: { type: 'string' } }, required: ['fato'] },
  },
  {
    name: 'preferencia_avisos',
    description: 'Liga ou desliga o recebimento de avisos gerais do condomínio para este morador, quando ele pedir.',
    parameters: { type: 'object', properties: { aceita: { type: 'boolean' } }, required: ['aceita'] },
  },
  {
    name: 'encaminhar_administracao',
    description: 'Encaminha à administração/síndico um assunto que você não pode resolver: dúvida sem resposta nos documentos, pedido de autorização, financeiro, conflito sério ou quando o morador pedir para falar com uma pessoa.',
    parameters: {
      type: 'object',
      properties: { assunto: { type: 'string' }, resumo: { type: 'string' } },
      required: ['assunto', 'resumo'],
    },
  },
];

async function executar(nome, args, ctx) {
  const { morador } = ctx;
  switch (nome) {
    case 'abrir_chamado': {
      const ch = await sv.abrirChamado({ morador, ...args, categoria: args.categoria || 'manutencao', foto: ctx.foto || null, video: ctx.video || null });
      ctx.acoes.push(`chamado ${ch.id}`);
      if (ctx.foto || ctx.video) ctx.limparMidias?.();
      return { ok: true, numero: ch.id, foto_anexada: Boolean(ctx.foto), video_anexado: Boolean(ctx.video) };
    }
    case 'consultar_meus_chamados': {
      const l = ok(await db.from('chamados').select('id, titulo, status, criado_em, observacao_equipe').eq('morador_id', morador.id).order('criado_em', { ascending: false }).limit(6));
      return l.map((c) => ({ numero: c.id, titulo: c.titulo, status: sv.ROTULO_STATUS[c.status], aberto_em: dataHora(c.criado_em), observacao: c.observacao_equipe || undefined }));
    }
    case 'registrar_reclamacao': {
      const r = await sv.registrarReclamacao({ morador, ...args });
      ctx.acoes.push(`reclamação ${r.id}`);
      return { ok: true, protocolo: r.id, portaria_avisada: true };
    }
    case 'consultar_agenda': {
      const dias = Math.min(Math.max(Number(args.dias) || 30, 1), 180);
      const ate = new Date(Date.now() + dias * 86400000).toISOString();
      const l = ok(await db.from('eventos').select('titulo, descricao, local, inicio, fim, publico').gte('inicio', new Date(Date.now() - 6 * 3600000).toISOString()).lte('inicio', ate).order('inicio'));
      const bloco = (morador.unidade?.bloco || '').toLowerCase();
      return l
        .filter((e) => e.publico === 'todos' || e.publico.slice(6).toLowerCase() === bloco)
        .map((e) => ({ titulo: e.titulo, quando: dataExtenso(e.inicio), ate: e.fim ? dataExtenso(e.fim) : undefined, local: e.local || undefined, detalhes: e.descricao || undefined }));
    }
    case 'agendar_lembrete': {
      const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(args.quando) ? args.quando : `${args.quando.slice(0, 16)}:00-03:00`);
      if (isNaN(d) || d < new Date()) return { ok: false, erro: 'Data inválida ou no passado.' };
      ok(await db.from('lembretes').insert({ morador_id: morador.id, texto: args.texto, enviar_em: d.toISOString() }));
      return { ok: true, quando: dataExtenso(d.toISOString()) };
    }
    case 'salvar_memoria': {
      ok(await db.from('memoria').insert({ morador_id: morador.id, fato: String(args.fato).slice(0, 300), origem: 'conversa' }));
      return { ok: true };
    }
    case 'preferencia_avisos': {
      ok(await db.from('moradores').update({ aceita_avisos: !!args.aceita }).eq('id', morador.id));
      return { ok: true };
    }
    case 'encaminhar_administracao': {
      const ch = await sv.abrirChamado({ morador, titulo: args.assunto, descricao: args.resumo, local: rotuloUnidade(morador.unidade), categoria: 'administracao', prioridade: 'normal' });
      ctx.acoes.push(`encaminhado ${ch.id}`);
      return { ok: true, protocolo: ch.id };
    }
    default:
      return { ok: false, erro: 'Ferramenta desconhecida' };
  }
}

// O prompt é dividido em duas partes para aproveitar o cache da OpenAI:
// 1) parte fixa do prédio (regras + documentos), igual para todos os moradores e todas as mensagens.
//    A OpenAI reaproveita esse começo idêntico e cobra cerca de 1/4 do preço dele.
// 2) parte variável (data/hora, quem está falando, memória), que vem depois.
// Não coloque nada que muda (data, nome, número) dentro da parte fixa, senão o cache deixa de funcionar.
async function montarParteFixa(cfg) {
  const docs = ok(await db.from('documentos').select('titulo, conteudo').eq('ativo', true).order('criado_em'));
  let textoDocs = docs.map((d) => `### ${d.titulo}\n${d.conteudo}`).join('\n\n');
  if (textoDocs.length > LIMITE_DOCS) textoDocs = textoDocs.slice(0, LIMITE_DOCS) + '\n[...documento cortado...]';

  return `Você é "${cfg.nome_assistente}", o assistente oficial de WhatsApp do ${cfg.nome_predio}. Você conversa individualmente com cada morador. Os dados de quem está falando e a data de hoje vêm na próxima mensagem do sistema.

COMO SE COMPORTAR
- Português do Brasil, cordial e direto. Mensagens curtas, próprias de WhatsApp. Sem markdown, sem títulos, no máximo um emoji quando fizer sentido.
- Chame a pessoa pelo primeiro nome ou como ela preferir.
- Resolva usando as ferramentas: abrir chamado, registrar reclamação, consultar agenda, agendar lembrete. Depois de usar uma, informe o número/protocolo.
- Dúvidas sobre regras: responda SOMENTE com base nos documentos abaixo e cite o artigo ou documento. Se não estiver nos documentos, diga que vai encaminhar e use encaminhar_administracao. Nunca invente regra, valor, data ou nome.
- Reclamações: garanta ao morador que o nome dele não será revelado. Não julgue nem exponha o vizinho.
- Nunca fale de dívidas, inadimplência ou dados de outros moradores. Nunca revele informações de outras unidades.
- Assuntos financeiros (boleto, valores, acordos): encaminhe à administração.
- Quando aprender algo duradouro e útil sobre a pessoa, use salvar_memoria (sem dados sensíveis).
- Se perguntarem se você é humano, diga que é o assistente virtual do condomínio, com acompanhamento da administração.
- Horário da administração: ${cfg.horario_administracao}.
${cfg.instrucoes_extras ? `\nINSTRUÇÕES DA ADMINISTRAÇÃO\n${cfg.instrucoes_extras}\n` : ''}
DOCUMENTOS DO CONDOMÍNIO
${textoDocs || '(nenhum documento cadastrado ainda: encaminhe dúvidas de regras à administração)'}`;
}

async function montarParteVariavel(morador) {
  const [fatos, abertos] = await Promise.all([
    db.from('memoria').select('fato, criado_em').eq('morador_id', morador.id).order('criado_em', { ascending: false }).limit(40).then(ok),
    db.from('chamados').select('id, titulo, status').eq('morador_id', morador.id).in('status', ['aberto', 'em_andamento']).limit(10).then(ok),
  ]);
  return `Hoje: ${hojeParaIA()}.

QUEM ESTÁ FALANDO
Nome: ${morador.nome} (primeiro nome: ${primeiroNome(morador.nome)})
Unidade: ${rotuloUnidade(morador.unidade)}
Vaga de garagem: ${morador.vaga || 'não informada'}
Vínculo: ${morador.tipo}
Resumo do perfil: ${morador.resumo_perfil || 'ainda sem resumo'}
O que você já sabe sobre essa pessoa:
${fatos.length ? fatos.map((f) => `- ${f.fato}`).join('\n') : '- nada ainda'}
Chamados em aberto: ${abertos.length ? abertos.map((c) => `nº ${c.id} ${c.titulo} (${sv.ROTULO_STATUS[c.status]})`).join('; ') : 'nenhum'}`;
}

// Mostra no log quanto do prompt veio do cache, para conferir a economia
function registrarUso(uso) {
  if (!uso) return;
  const cache = uso.prompt_tokens_details?.cached_tokens || 0;
  const pct = uso.prompt_tokens ? Math.round((cache / uso.prompt_tokens) * 100) : 0;
  console.log(`[agente] tokens: entrada ${uso.prompt_tokens} (cache ${cache}, ${pct}%), saída ${uso.completion_tokens}`);
}

async function responder(morador, texto, { foto = null, video = null, limparMidias } = {}) {
  const cfg = await getConfig();
  const anteriores = ok(await db.from('mensagens').select('direcao, texto').eq('telefone', morador.telefone).order('criado_em', { ascending: false }).limit(HISTORICO + 1)).reverse();
  // A última mensagem de entrada é a atual (já gravada); o restante é o histórico
  if (anteriores.length && anteriores[anteriores.length - 1].direcao === 'entrada') anteriores.pop();

  let variavel = await montarParteVariavel(morador);
  if (!anteriores.some((m) => m.direcao === 'entrada')) {
    variavel += `\n\nPRIMEIRA CONVERSA: apresente-se como ${cfg.nome_assistente} e diga em até 3 linhas curtas o que você faz (abre chamados de manutenção, registra reclamações sem expor quem reclamou, tira dúvidas sobre as regras do prédio e avisa sobre eventos e obras). Depois responda ao que a pessoa pediu.`;
  }
  if (foto || video) {
    const oQue = [foto && 'foto', video && 'vídeo'].filter(Boolean).join(' e ');
    variavel += `\n\nO morador mandou ${oQue} há pouco. Se você abrir um chamado agora, ${foto && video ? 'eles são anexados' : 'é anexado'} automaticamente; diga isso a ele.`;
  }
  variavel += '\n\nFORMATOS: áudios chegam transcritos; fotos chegam com a descrição do que aparece; vídeos você não assiste, mas ficam guardados; "[respondendo em cima de ...]" indica que a pessoa respondeu citando uma mensagem anterior: use isso para entender a que ela se refere.';

  const mensagens = [
    { role: 'system', content: await montarParteFixa(cfg) },
    { role: 'system', content: variavel },
    ...anteriores.map((m) => ({ role: m.direcao === 'entrada' ? 'user' : 'assistant', content: m.texto })),
    { role: 'user', content: texto },
  ];

  const ctx = { morador, acoes: [], foto, video, limparMidias };
  const tools = FERRAMENTAS.map((f) => ({ type: 'function', function: f }));

  for (let volta = 0; volta < 6; volta++) {
    const r = await openai().chat.completions.create({ model: env.OPENAI_MODEL, messages: mensagens, tools, temperature: 0.4 });
    registrarUso(r.usage);
    const msg = r.choices[0].message;
    if (!msg.tool_calls?.length) return (msg.content || '').trim();
    mensagens.push(msg);
    for (const call of msg.tool_calls) {
      let resultado;
      try {
        resultado = await executar(call.function.name, JSON.parse(call.function.arguments || '{}'), ctx);
      } catch (e) {
        console.error('[agente] ferramenta', call.function.name, e.message);
        resultado = { ok: false, erro: 'Falha interna ao executar. Peça desculpas e diga que a administração será avisada.' };
      }
      mensagens.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(resultado) });
    }
  }
  return 'Registrei sua mensagem e a administração vai dar retorno.';
}

// Mantém o resumo do perfil atualizado a cada algumas conversas
async function atualizarResumo(morador) {
  const total = (await db.from('mensagens').select('*', { count: 'exact', head: true }).eq('morador_id', morador.id).eq('direcao', 'entrada')).count || 0;
  if (total < 4 || total % 8 !== 0) return;
  const [msgs, fatos, grupo] = await Promise.all([
    db.from('mensagens').select('direcao, texto').eq('morador_id', morador.id).order('criado_em', { ascending: false }).limit(40).then(ok),
    db.from('memoria').select('fato').eq('morador_id', morador.id).limit(60).then(ok),
    db.from('grupo_mensagens').select('texto').eq('morador_id', morador.id).order('criado_em', { ascending: false }).limit(30).then(ok),
  ]);
  const resumo = await completar(
    'Você mantém a ficha de um morador de condomínio para o assistente de atendimento. Escreva um resumo de no máximo 5 linhas: como a pessoa se comunica, assuntos que mais traz, preferências e pendências. Seja respeitoso e factual. Não inclua dados de saúde, religião, política, vida íntima ou finanças.',
    `Resumo anterior: ${morador.resumo_perfil || '(nenhum)'}\n\nFatos guardados:\n${fatos.map((f) => '- ' + f.fato).join('\n')}\n\nConversas recentes (mais novas primeiro):\n${msgs.map((m) => `${m.direcao === 'entrada' ? 'Morador' : 'Assistente'}: ${m.texto}`).join('\n')}\n\nMensagens dele no grupo do prédio:\n${grupo.map((g) => '- ' + g.texto).join('\n') || '(nenhuma)'}`,
    { maxTokens: 300 },
  );
  if (resumo) await db.from('moradores').update({ resumo_perfil: resumo }).eq('id', morador.id);
}


// ================== Entrada das mensagens privadas ==================

const ESPERA_MS = 8000;        // espera a pessoa terminar de digitar (mensagens picadas)
const ESPERA_MAX_MS = 20000;   // nunca espera mais que isso desde a primeira mensagem
const LIMITE_POR_HORA = 30;    // proteção contra uso abusivo (custo de IA)
const MIDIA_VALIDA_MS = 30 * 60000;

const buffers = new Map();     // telefone -> { partes, timer, inicio, nome, temMidia }
const midiasPendentes = new Map(); // telefone -> { foto, video, em }
const contagemHora = new Map();   // telefone -> [timestamps]

function dentroDoLimite(tel) {
  const agora = Date.now();
  const lista = (contagemHora.get(tel) || []).filter((t) => agora - t < 3600000);
  lista.push(agora);
  contagemHora.set(tel, lista);
  return { ok: lista.length <= LIMITE_POR_HORA, primeiraVezAcima: lista.length === LIMITE_POR_HORA + 1 };
}

// Áudio: baixa pela Uazapi e transcreve com a OpenAI
async function transcreverAudio(ids) {
  const { buffer, mime } = await uazapi.baixarMidia(ids);
  const nome = /ogg|opus/.test(mime) ? 'audio.ogg' : 'audio.mp3';
  const r = await openai().audio.transcriptions.create({
    file: await toFile(buffer, nome, { type: mime || 'audio/mpeg' }),
    model: env.OPENAI_TRANSCRIBE_MODEL,
    language: 'pt',
  });
  return (r.text || '').trim();
}

function guardarPendente(tel, tipo, id) {
  const atual = midiasPendentes.get(tel);
  const m = atual && Date.now() - atual.em < MIDIA_VALIDA_MS ? atual : {};
  midiasPendentes.set(tel, { ...m, [tipo]: id, em: Date.now() });
}

// Foto: baixa, guarda e a IA descreve o que vê. Fica pronta para ser anexada ao próximo chamado.
async function guardarFotoDoMorador(tel, ids, legenda, { citada = false } = {}) {
  const { buffer, mime } = await uazapi.baixarMidia(ids, { citada });
  const tipo = /png/.test(mime) ? 'image/png' : /webp/.test(mime) ? 'image/webp' : 'image/jpeg';
  const id = await salvarFoto(buffer, tipo, 'moradores');
  guardarPendente(tel, 'foto', id);
  let descricao = '';
  try { descricao = await descreverImagem(buffer, tipo, legenda); } catch (e) { console.error('[agente] visão', e.message); }
  return { id, descricao };
}

// Vídeo: o assistente não assiste, mas guarda para anexar ao chamado
async function guardarVideoDoMorador(tel, ids, { citada = false } = {}) {
  const { buffer, mime } = await uazapi.baixarMidia(ids, { citada, limiteBytes: LIMITE_VIDEO });
  const id = await salvarVideo(buffer, String(mime).startsWith('video/') ? mime : 'video/mp4');
  guardarPendente(tel, 'video', id);
  return id;
}

function midiaPendente(tel) {
  const m = midiasPendentes.get(tel);
  if (!m || Date.now() - m.em > MIDIA_VALIDA_MS) return {};
  return { foto: m.foto || null, video: m.video || null };
}

// Nota de 1 a 5 depois de um chamado resolvido (sem gastar IA)
async function tratarAvaliacao(morador, texto) {
  const m = /^\s*(?:nota\s*)?([1-5])\s*(?:estrelas?)?\s*[.!]?\s*$/i.exec(texto);
  if (!m) return false;
  const desde = new Date(Date.now() - 3 * 86400000).toISOString();
  const [ch] = ok(await db.from('chamados').select('id').eq('morador_id', morador.id).is('avaliacao', null)
    .not('avaliacao_pedida_em', 'is', null).gte('avaliacao_pedida_em', desde).order('avaliacao_pedida_em', { ascending: false }).limit(1));
  if (!ch) return false;
  const nota = Number(m[1]);
  ok(await db.from('chamados').update({ avaliacao: nota }).eq('id', ch.id));
  await sv.registrarHistoricoChamado(ch.id, `Morador avaliou com nota ${nota}`, morador.nome);
  const resposta = nota >= 4
    ? `Obrigado pela nota ${nota}, ${primeiroNome(morador.nome)}! 😊 Qualquer coisa, é só chamar.`
    : `Obrigado por avaliar, ${primeiroNome(morador.nome)}. Sinto que não foi como esperado. Quer me contar o que podemos melhorar? Vou repassar para a administração.`;
  await sv.enviar(morador.telefone, resposta, morador.id);
  if (nota <= 2) await sv.avisarEquipe('sindico', `Avaliação baixa: chamado nº ${ch.id} recebeu nota ${nota} de ${morador.nome} (${rotuloUnidade(morador.unidade)}).`);
  return true;
}

async function atenderNaoCadastrado(tel, nome, texto) {
  const existente = ok(await db.from('contatos_pendentes').select('*').eq('telefone', tel).maybeSingle());
  const responderAgora = !existente || Date.now() - new Date(existente.atualizado_em).getTime() > 12 * 3600000;
  await db.from('contatos_pendentes').upsert({
    telefone: tel, nome_whatsapp: nome || existente?.nome_whatsapp || null, ultima_mensagem: String(texto || '[mídia]').slice(0, 500),
    vezes: (existente?.vezes || 0) + 1, atualizado_em: new Date().toISOString(),
  });
  if (responderAgora) {
    const cfg = await getConfig();
    await sv.enviar(tel, `Olá! Sou o assistente virtual do ${cfg.nome_predio}. Ainda não encontrei este número no cadastro de moradores. Já avisei a administração, que vai confirmar seus dados. Assim que for liberado, eu te atendo por aqui.`);
  }
}

// Processa tudo o que a pessoa mandou de uma vez
async function processar(tel) {
  const b = buffers.get(tel);
  buffers.delete(tel);
  if (!b) return;
  const texto = b.partes.filter(Boolean).join('\n').trim();
  if (!texto) return;

  return emSequencia(tel, async () => {
    // Número da administração: vira o assistente do síndico (comandos para avisos, agenda, chamados...)
    const admin = await require('./agente_admin').acharAdmin(tel);
    if (admin) return require('./agente_admin').atenderAdminWhatsApp(admin, tel, texto);

    const morador = await sv.acharMorador(tel);
    if (!morador || !morador.ativo) return atenderNaoCadastrado(tel, b.nome, texto);

    const limite = dentroDoLimite(tel);
    if (!limite.ok) {
      if (limite.primeiraVezAcima) await sv.enviar(tel, 'Recebi muitas mensagens em pouco tempo. Vou pausar as respostas automáticas por alguns minutos. Se for urgente, fale com a portaria.', morador.id);
      return;
    }

    await inserirMensagem({ morador_id: morador.id, telefone: morador.telefone, direcao: 'entrada', texto, wa_id: b.waId || null });
    await db.from('moradores').update({ ultima_interacao: new Date().toISOString() }).eq('id', morador.id);

    if (await tratarAvaliacao(morador, texto)) return;

    let resposta;
    try {
      resposta = await responder(morador, texto, { ...midiaPendente(tel), limparMidias: () => midiasPendentes.delete(tel) });
    } catch (e) {
      console.error('[agente] erro', e.message);
      resposta = 'Tive um problema técnico agora. Sua mensagem ficou registrada e a administração vai verificar.';
    }
    if (resposta) await sv.enviar(morador.telefone, resposta, morador.id);
    atualizarResumo(morador).catch((e) => console.error('[agente] resumo', e.message));
  });
}

// Entrada principal: chamada pelo webhook para cada mensagem privada
// Transforma cada formato (texto, áudio, foto, vídeo, documento...) em texto que o assistente entende
async function lerConteudo(tel, { texto, midia, ids, tipoMensagem, nomeArquivo }) {
  const legenda = texto ? ` Legenda: "${texto}".` : '';
  switch (midia) {
    case 'ignorar':
      return ''; // reação, figurinha, chamada: não responde
    case 'audio':
      try {
        const t = await transcreverAudio(ids);
        return t ? `[áudio transcrito] ${t}` : '[o morador mandou um áudio sem fala reconhecível]';
      } catch (e) {
        console.error('[agente] áudio', e.message);
        return '[o morador mandou um áudio que não consegui ouvir: peça para escrever ou mandar de novo]';
      }
    case 'imagem':
      try {
        const { descricao } = await guardarFotoDoMorador(tel, ids, texto);
        return `[o morador enviou uma foto.${legenda} Leitura automática da foto (pode errar; na dúvida, confirme com o morador): ${descricao || 'não consegui descrever'}. Se for um problema, ela é anexada ao chamado]`;
      } catch (e) {
        console.error('[agente] foto', e.message);
        return texto || '[o morador enviou uma foto que não consegui abrir: peça para mandar de novo]';
      }
    case 'video':
      try {
        await guardarVideoDoMorador(tel, ids);
        return `[o morador enviou um vídeo.${legenda} Você não consegue assistir vídeos: pergunte em poucas palavras o que ele mostra. O vídeo fica guardado e é anexado ao chamado, se abrir um]`;
      } catch (e) {
        console.error('[agente] vídeo', e.message);
        return `[o morador enviou um vídeo${e.grande ? ' grande demais para guardar' : ' que não consegui guardar'}.${legenda} Peça para descrever o que ele mostra${e.grande ? ' ou mandar um vídeo mais curto' : ''}]`;
      }
    case 'documento':
      return `[o morador enviou um documento${nomeArquivo ? ` (${nomeArquivo})` : ''} que você não consegue abrir.${legenda} Pergunte do que se trata ou encaminhe à administração]`;
    case 'localizacao':
      return '[o morador enviou uma localização]';
    case 'contato':
      return `[o morador enviou um contato]${legenda}`;
    default:
      if (texto) return texto;
      if (tipoMensagem) console.log('[agente] tipo de mensagem sem tratamento:', tipoMensagem);
      return '';
  }
}

// Quando a pessoa responde "em cima" de uma mensagem, descobre o que foi citado
async function lerCitacao(tel, { citadoId, citadoTexto }) {
  if (!citadoId && !citadoTexto) return '';
  let texto = citadoTexto;
  let quem = '';
  if (!texto && citadoId) {
    const r = await db.from('mensagens').select('direcao, texto').eq('wa_id', citadoId).limit(1);
    if (!r.error && r.data[0]) { texto = r.data[0].texto; quem = r.data[0].direcao === 'saida' ? 'sua mensagem' : 'mensagem dele'; }
  }
  if (!texto) {
    // Pode ser uma foto ou vídeo antigo: tenta baixar a mídia citada
    try {
      const { descricao } = await guardarFotoDoMorador(tel, [citadoId], '', { citada: true });
      return `[respondendo em cima de uma foto. O que aparece: ${descricao}] `;
    } catch {
      return '[respondendo em cima de uma mensagem anterior que não está no histórico] ';
    }
  }
  return `[respondendo em cima de ${quem || 'uma mensagem'}: "${String(texto).replace(/\s+/g, ' ').slice(0, 300)}"] `;
}

async function receberMensagemPrivada(ev) {
  const tel = normalizarTelefone(ev.telefone);
  if (!tel) return;

  const conteudo = await lerConteudo(tel, ev);
  if (!conteudo) return;
  let parte = conteudo;
  try { parte = (await lerCitacao(tel, ev)) + conteudo; } catch (e) { console.error('[agente] citação', e.message); }

  const agora = Date.now();
  const b = buffers.get(tel) || { partes: [], inicio: agora, nome: ev.nome };
  b.waId = ev.waId || b.waId;
  b.partes.push(parte);
  clearTimeout(b.timer);
  const espera = Math.max(0, Math.min(ESPERA_MS, ESPERA_MAX_MS - (agora - b.inicio)));
  b.timer = setTimeout(() => processar(tel).catch((e) => console.error('[agente]', e.message)), espera);
  buffers.set(tel, b);
}

// ================== Grupo: chamar no privado quem relata um problema ==================
// O assistente não responde no grupo. Se um morador cadastrado relatar um problema do prédio,
// ele recebe uma mensagem no privado oferecendo abrir o chamado (no máximo uma vez a cada 24h).
async function avaliarMensagemDoGrupo(morador, texto) {
  if (!morador || !morador.ativo || String(texto).length < 12) return;
  if (morador.abordado_grupo_em && Date.now() - new Date(morador.abordado_grupo_em).getTime() < 24 * 3600000) return;

  let r;
  try {
    const bruto = await completar(
      'Você lê mensagens do grupo de WhatsApp de um condomínio. Diga se a mensagem relata um problema concreto nas áreas comuns ou na estrutura do prédio que a equipe deveria resolver (algo quebrado, vazamento, sujeira, falta de luz/água, portão, elevador, segurança). Conversas, piadas, avisos, vendas e opiniões não contam. Responda só JSON: {"problema": true|false, "resumo": "até 8 palavras, ex.: o portão da garagem travado"}',
      String(texto).slice(0, 800),
      { maxTokens: 60, temperatura: 0 },
    );
    r = JSON.parse(bruto.replace(/```json|```/g, '').trim());
  } catch (e) { console.error('[grupo] classificação', e.message); return; }
  if (!r?.problema || !r.resumo) return;

  await db.from('moradores').update({ abordado_grupo_em: new Date().toISOString() }).eq('id', morador.id);
  await sv.enviar(morador.telefone, `Oi, ${primeiroNome(morador.nome)}! Vi sua mensagem no grupo sobre ${r.resumo}. Quer que eu abra um chamado para a equipe resolver? É só responder aqui. Se quiser, pode mandar uma foto ou um áudio.`, morador.id);
}

module.exports = { receberMensagemPrivada, avaliarMensagemDoGrupo };
