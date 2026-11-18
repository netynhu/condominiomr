// O assistente que conversa com cada morador no privado
const { db, ok, getConfig } = require('./db');
const { env } = require('./config');
const { openai, completar } = require('./ia');
const sv = require('./servicos');
const { rotuloUnidade, dataExtenso, primeiroNome, normalizarTelefone, dataHora } = require('./util');

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
      const ch = await sv.abrirChamado({ morador, ...args, categoria: args.categoria || 'manutencao' });
      ctx.acoes.push(`chamado ${ch.id}`);
      return { ok: true, numero: ch.id };
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
  return `Agora: ${dataExtenso(new Date().toISOString())} (horário de Brasília).

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

async function responder(morador, texto) {
  const cfg = await getConfig();
  const anteriores = ok(await db.from('mensagens').select('direcao, texto').eq('telefone', morador.telefone).order('criado_em', { ascending: false }).limit(HISTORICO + 1)).reverse();
  // A última mensagem de entrada é a atual (já gravada); o restante é o histórico
  if (anteriores.length && anteriores[anteriores.length - 1].direcao === 'entrada') anteriores.pop();

  const mensagens = [
    { role: 'system', content: await montarParteFixa(cfg) },
    { role: 'system', content: await montarParteVariavel(morador) },
    ...anteriores.map((m) => ({ role: m.direcao === 'entrada' ? 'user' : 'assistant', content: m.texto })),
    { role: 'user', content: texto },
  ];

  const ctx = { morador, acoes: [] };
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

// Entrada principal: chamada pelo webhook para cada mensagem privada
async function receberMensagemPrivada({ telefone, nome, texto, tipoMensagem }) {
  const tel = normalizarTelefone(telefone);
  if (!tel) return;
  return emSequencia(tel, async () => {
    const morador = await sv.acharMorador(tel);

    if (!morador || !morador.ativo) {
      const existente = ok(await db.from('contatos_pendentes').select('*').eq('telefone', tel).maybeSingle());
      const responderAgora = !existente || Date.now() - new Date(existente.atualizado_em).getTime() > 12 * 3600000;
      await db.from('contatos_pendentes').upsert({
        telefone: tel, nome_whatsapp: nome || existente?.nome_whatsapp || null, ultima_mensagem: (texto || `[${tipoMensagem}]`).slice(0, 500),
        vezes: (existente?.vezes || 0) + 1, atualizado_em: new Date().toISOString(),
      });
      if (responderAgora) {
        const cfg = await getConfig();
        await sv.enviar(tel, `Olá! Sou o assistente virtual do ${cfg.nome_predio}. Ainda não encontrei este número no cadastro de moradores. Já avisei a administração, que vai confirmar seus dados. Assim que for liberado, eu te atendo por aqui.`);
      }
      return;
    }

    const conteudo = texto || (tipoMensagem ? `[o morador enviou uma mensagem do tipo ${tipoMensagem}, sem texto]` : '');
    if (!conteudo) return;
    ok(await db.from('mensagens').insert({ morador_id: morador.id, telefone: morador.telefone, direcao: 'entrada', texto: conteudo }));
    await db.from('moradores').update({ ultima_interacao: new Date().toISOString() }).eq('id', morador.id);

    let resposta;
    try {
      resposta = await responder(morador, conteudo);
    } catch (e) {
      console.error('[agente] erro', e.message);
      resposta = 'Tive um problema técnico agora. Sua mensagem ficou registrada e a administração vai verificar.';
    }
    if (resposta) await sv.enviar(morador.telefone, resposta, morador.id);
    atualizarResumo(morador).catch((e) => console.error('[agente] resumo', e.message));
  });
}

module.exports = { receberMensagemPrivada };
