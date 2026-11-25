// O assistente que conversa com cada morador no privado
const { db, ok, getConfig } = require('./db');
const { noCondominio } = require('./contexto');
const { env } = require('./config');
const { toFile } = require('openai');
const { openai, completar, descreverImagem } = require('./ia');
const sv = require('./servicos');
const uazapi = require('./uazapi');
const { salvarFoto, salvarVideo, LIMITE_VIDEO } = require('./fotos');
const { inserirMensagem } = require('./db');
const { rotuloUnidade, dataExtenso, primeiroNome, normalizarTelefone, dataHora, hojeParaIA } = require('./util');

const LIMITE_DOCS = 100000; // caracteres de documentos enviados ao modelo (cerca de 25 mil tokens; com cache, custo baixo)
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
    description: 'Registra uma reclamação de convivência (barulho, vaga, animal, lixo, obra, comportamento). O nome de quem reclama nunca é mostrado à portaria nem a outros moradores. Antes, siga a REGRA dos horários permitidos: obra, serviço ou mudança dentro do horário permitido não vira reclamação.',
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
    name: 'reabrir_reclamacao',
    description: 'Reabre uma reclamação DESTE morador que já foi tratada, quando ele avisa que o problema continua ou voltou. Avisa a portaria e o síndico.',
    parameters: {
      type: 'object',
      properties: { numero: { type: 'integer' }, descricao: { type: 'string', description: 'O que está acontecendo agora' } },
      required: ['numero'],
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
    name: 'consultar_manutencoes',
    description: 'Consulta o histórico de manutenções do prédio (o que foi feito, quando e por qual empresa) e as próximas programadas. Use quando perguntarem, por exemplo, quando foi a última limpeza da caixa d’água, a última manutenção do elevador ou a recarga dos extintores.',
    parameters: { type: 'object', properties: { assunto: { type: 'string', description: 'Do que se trata, ex.: "caixa d’água", "elevador", "extintores". Vazio para tudo.' } } },
  },
  {
    name: 'consultar_minhas_reservas',
    description: 'Lista as reservas de espaços (salão, churrasqueira...) do morador, das próximas e de hoje. As reservas são feitas com a administração; você não cria reservas.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'consultar_encomendas',
    description: 'Lista as encomendas do apartamento do morador que estão na portaria esperando retirada. Use quando ele perguntar se chegou algo ou se tem encomenda.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'confirmar_retirada_encomenda',
    description: 'Marca uma encomenda como retirada quando o morador disser que já pegou (ex.: "peguei", "já retirei"). Sem número, usa a única encomenda esperando; se houver mais de uma, devolve a lista para você perguntar qual.',
    parameters: { type: 'object', properties: { numero: { type: 'number', description: 'Número da encomenda (opcional)' } } },
  },
  {
    name: 'fora_do_assunto',
    description: 'Chame quando a mensagem do morador é um pedido ou pergunta que NÃO tem nada a ver com o condomínio, o prédio, a convivência ou o atendimento (ex.: receita, futebol, política, piada, tarefa da escola, pedir para escrever texto ou código, conversa sem propósito). NÃO chame para cumprimentos, agradecimentos, despedidas, "ok", nem para assuntos do prédio. Devolve o que dizer.',
    parameters: { type: 'object', properties: { assunto: { type: 'string', description: 'Do que se trata, em poucas palavras' } }, required: ['assunto'] },
  },
  {
    name: 'perguntar_administracao',
    description: 'Use quando o morador faz uma PERGUNTA cuja resposta não está escrita nos documentos, nas instruções nem nas respostas da administração. Registra a dúvida e avisa a administração na hora pelo WhatsApp. Quando ela responder, o morador recebe a resposta e você aprende. Devolve o número da dúvida.',
    parameters: {
      type: 'object',
      properties: {
        pergunta: { type: 'string', description: 'A pergunta do morador, clara e completa, como uma pergunta geral sobre o prédio (ex.: "Como faço o cadastro no controle de acesso do prédio?")' },
        contexto: { type: 'string', description: 'Detalhes que ajudam a administração a responder (opcional)' },
      },
      required: ['pergunta'],
    },
  },
  {
    name: 'encaminhar_administracao',
    description: 'Encaminha à administração/síndico um PEDIDO que precisa de ação ou decisão de uma pessoa: autorização, assunto financeiro (boleto, valores, acordos), conflito sério ou quando o morador pede para falar com uma pessoa. Para perguntas sem resposta nos documentos, use perguntar_administracao.',
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
      if (morador.autocadastro && morador.conferido === false && (await getConfig()).autocadastro_reclamacao_conferido !== '0') {
        return { ok: false, erro: 'O cadastro deste morador foi feito pelo grupo e ainda não foi conferido pela administração. Explique com gentileza que reclamações ficam liberadas depois dessa conferência, que costuma levar poucos dias. Se for algo urgente ou perigoso, oriente a falar com a portaria agora. Chamados de manutenção e dúvidas funcionam normalmente.' };
      }
      const r = await sv.registrarReclamacao({ morador, ...args });
      ctx.acoes.push(`reclamação ${r.id}`);
      return { ok: true, protocolo: r.id, portaria_avisada: true };
    }
    case 'reabrir_reclamacao': {
      const r = await sv.reabrirReclamacao(Number(args.numero), morador, args.descricao);
      if (r.jaAberta) return { ok: true, numero: r.id, observacao: 'A reclamação já está aberta e em análise.' };
      ctx.acoes.push(`reclamação ${r.id} reaberta`);
      return { ok: true, numero: r.id, reaberta: true, portaria_avisada: true };
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
    case 'consultar_manutencoes': {
      const r = await require('./manutencoes').consultar(args.assunto);
      if (!r.feitas.length && !r.programadas.length) return { nada_registrado: true, instrucao: 'Não há registro dessa manutenção no sistema. Diga isso com sinceridade e use perguntar_administracao para a administração informar.' };
      return r;
    }
    case 'consultar_minhas_reservas': {
      const r = await db.from('reservas').select('inicio, fim, status, entrada_em, saida_em, token, espaco:espacos(nome)').eq('morador_id', morador.id)
        .in('status', ['agendada', 'em_uso']).gte('fim', new Date().toISOString()).order('inicio').limit(5);
      if (r.error) return { nenhuma: true };
      return r.data.length ? r.data.map((x) => ({ espaco: x.espaco?.nome, quando: dataExtenso(x.inicio), ate: dataExtenso(x.fim), checkin_feito: Boolean(x.entrada_em),
        link_checkin: !x.entrada_em && new Date(x.inicio) <= new Date() ? `${env.APP_URL}/r/${x.token}/entrada` : undefined,
        link_checkout: !x.saida_em && new Date(x.fim) <= new Date() ? `${env.APP_URL}/r/${x.token}/saida` : undefined })) : { nenhuma: true, observacao: 'Ele não tem reserva marcada. Reservas são feitas com a administração.' };
    }
    case 'consultar_encomendas': {
      const l = await require('./encomendas').doMorador(morador);
      return l.length ? l.map((e) => ({ numero: e.id, desde: dataHora(e.recebida_em), observacao: e.observacao || undefined })) : { nenhuma: true, observacao: 'Não há encomenda aguardando retirada no apartamento dele.' };
    }
    case 'confirmar_retirada_encomenda': {
      const enc = require('./encomendas');
      let id = Number(args.numero) || 0;
      if (!id) {
        const l = await enc.doMorador(morador);
        if (!l.length) return { ok: false, erro: 'Não há encomenda aguardando retirada no apartamento dele.' };
        if (l.length > 1) return { ok: false, erro: 'Há mais de uma encomenda. Pergunte qual ele retirou.', encomendas: l.map((e) => ({ numero: e.id, observacao: e.observacao || undefined, desde: dataHora(e.recebida_em) })) };
        id = l[0].id;
      }
      const r = await enc.retirar(id, { morador });
      return { ok: r.ok, resultado: r.msg };
    }
    case 'fora_do_assunto': {
      const r = await registrarForaDoAssunto(morador, args.assunto);
      if (r.bloqueado) ctx.bloqueadoAte = r.ate;
      if (r.vez && r.vez === r.limite - 1) ctx.avisoPausa = r.horas; // o próximo fora do assunto pausa
      return r.bloqueado
        ? { ok: true, pausado: true, instrucao: 'O atendimento foi pausado. Não responda ao assunto.' }
        : r.desligado
          ? { ok: true, instrucao: 'Não responda ao assunto. Diga com gentileza que você só atende assuntos do condomínio e ofereça ajuda com o prédio.' }
          : { ok: true, vez: r.vez, limite: r.limite, instrucao: 'Não responda ao assunto. Diga com gentileza, em uma frase, que você só atende assuntos do condomínio e ofereça ajuda com o prédio. Não fale de pausa: o sistema avisa sozinho.' };
    }
    case 'perguntar_administracao': {
      const d = await require('./duvidas').registrar({ morador, pergunta: args.pergunta, contexto: args.contexto });
      ctx.acoes.push(`dúvida ${d.id}`);
      return { ok: true, numero_da_duvida: d.id, administracao_avisada: true };
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
  // O que a administração já respondeu e marcou para o assistente aprender
  const aprendido = await require('./duvidas').conhecimento();
  const textoAprendido = aprendido.length
    ? `\nRESPOSTAS DA ADMINISTRAÇÃO (perguntas que moradores já fizeram; use como informação oficial)\n${aprendido.map((x) => `- Pergunta: ${x.pergunta}\n  Resposta: ${x.resposta}`).join('\n')}\n`
    : '';

  return `Você é "${cfg.nome_assistente}", o assistente oficial de WhatsApp do ${cfg.nome_predio}. Você conversa individualmente com cada morador. Os dados de quem está falando e a data de hoje vêm na próxima mensagem do sistema.

COMO SE COMPORTAR
- Português do Brasil, cordial e direto. Mensagens curtas, próprias de WhatsApp. Sem markdown, sem títulos, no máximo um emoji quando fizer sentido.
- Chame a pessoa pelo primeiro nome ou como ela preferir.
- Resolva usando as ferramentas: abrir chamado, registrar reclamação, consultar agenda, agendar lembrete. Depois de usar uma, informe o número/protocolo.
- Dúvidas sobre o prédio: responda SOMENTE com o que está escrito nos documentos, nas instruções da administração ou nas respostas da administração (abaixo). Cite o artigo ou documento quando houver. Nunca invente regra, valor, data, nome, procedimento ou responsável.

QUANDO VOCÊ NÃO SABE A RESPOSTA (muito importante)
- Se a resposta não está escrita nas fontes acima, você NÃO sabe. Não deduza e não suponha. Isso vale também para "existe X no prédio?" (academia, bicicletário, salão, serviço): se não estiver escrito, não afirme que existe nem que não existe. Não diga coisas como "isso é feito pela administração", "procure a portaria" ou "é só pedir à manutenção" se isso não estiver escrito.
- Seja sincero: diga que ainda não tem essa informação e que vai perguntar à administração. Chame perguntar_administracao com a pergunta na mesma hora (não pergunte se pode perguntar). Depois diga o número da dúvida e que você avisa aqui mesmo assim que a administração responder.
- Nunca diga que encaminhou, avisou alguém ou gerou protocolo sem ter chamado a ferramenta e recebido o número de volta.

MANUTENÇÕES DO PRÉDIO
- Para perguntas sobre manutenção (última limpeza da caixa d’água, elevador, extintores, dedetização...), use consultar_manutencoes e responda com a data e a empresa registradas. Se não houver registro, diga que não tem essa informação e use perguntar_administracao.

RESERVAS DE ESPAÇOS
- As reservas são feitas com a administração (siga o que o regulamento diz). Você não cria reservas. Se o morador perguntar da reserva dele ou pedir o link do check-in/check-out, use consultar_minhas_reservas.

ENCOMENDAS
- A portaria registra as encomendas e você avisa o morador. Se ele perguntar se chegou algo, use consultar_encomendas. Se disser que já pegou ("peguei", "já retirei"), use confirmar_retirada_encomenda para parar os avisos.

ASSUNTOS FORA DO CONDOMÍNIO
- Você só atende assuntos do condomínio. Se a pessoa pedir algo que não tem nada a ver com o prédio (receita, futebol, política, piada, tarefa da escola, escrever textos, conversa sem propósito), não responda ao assunto: chame fora_do_assunto e siga a instrução que ela devolver.
- Cumprimentos, agradecimentos, "ok" e despedidas não são fora do assunto. Na dúvida se é do prédio, trate como do prédio.
- Reclamações: garanta ao morador que o nome dele não será revelado. Não julgue nem exponha o vizinho.
- Nunca fale de dívidas, inadimplência ou dados de outros moradores. Nunca revele informações de outras unidades.
- Assuntos financeiros (boleto, 2ª via, valores, acordos, cobrança): você não tem acesso a valores nem a dívidas e nunca fala deles. ${cfg.adm_nome ? 'Diga onde e com quem resolver, usando os dados da ADMINISTRADORA abaixo (link, WhatsApp, telefone, e-mail, horário e nome do contato, o que houver). Isso vale também para "quanto está o condomínio": indique a administradora já com o contato na mesma resposta (não pergunte se pode passar); não use perguntar_administracao nem diga que vai encaminhar.' : 'A administradora ainda não foi cadastrada: use perguntar_administracao para pedir o contato.'}
- Quando aprender algo duradouro e útil sobre a pessoa, use salvar_memoria (sem dados sensíveis).
- Se perguntarem se você é humano, diga que é o assistente virtual do condomínio, com acompanhamento da administração.
- Horário da administração: ${cfg.horario_administracao}.

${cfg.adm_nome ? `ADMINISTRADORA DO CONDOMÍNIO (boletos, 2ª via, valores, acordos)
- Empresa: ${cfg.adm_nome}${cfg.adm_contato ? `
- Falar com: ${cfg.adm_contato}` : ''}${cfg.adm_portal ? `
- 2ª via e portal do condômino: ${cfg.adm_portal}` : ''}${cfg.adm_whatsapp ? `
- WhatsApp: ${cfg.adm_whatsapp}` : ''}${cfg.adm_telefone ? `
- Telefone: ${cfg.adm_telefone}` : ''}${cfg.adm_email ? `
- E-mail: ${cfg.adm_email}` : ''}${cfg.adm_horario ? `
- Horário: ${cfg.adm_horario}` : ''}${cfg.adm_observacoes ? `
- Observações: ${cfg.adm_observacoes}` : ''}

` : ''}HORÁRIOS PERMITIDOS DO PRÉDIO (definidos pela administração)
- Obras, reformas e serviços nos apartamentos (furadeira, martelo, marceneiro, pintor etc.): ${cfg.horario_obras}
- Mudanças: ${cfg.horario_mudancas}
- Silêncio obrigatório: ${cfg.horario_silencio}
REGRA ANTES DE REGISTRAR RECLAMAÇÃO DE BARULHO, OBRA, SERVIÇO OU MUDANÇA:
1. Compare o dia da semana e a hora de AGORA (está nos dados de quem fala) com os horários acima.
2. Se o barulho for de obra, reforma, serviço ou mudança e estiver DENTRO do horário permitido: NÃO registre a reclamação. Explique com educação que esse horário é permitido, informe até quando vai e diga que, se continuar depois disso, é só avisar que você registra.
3. Barulho comum (som, festa, conversa alta) fora do horário de silêncio: explique que ainda não é horário de silêncio e que o volume deve respeitar os vizinhos; só registre se a pessoa disser que está excessivo ou insistir.
4. Fora do horário permitido ou no horário de silêncio: registre normalmente.
5. Se o morador disser que o barulho está acontecendo há dias ou de forma abusiva, registre mesmo dentro do horário, deixando isso claro na descrição.

ACOMPANHAMENTO DE RECLAMAÇÕES
- Quando uma reclamação do morador foi resolvida e ele disser que o problema continua ou voltou, use reabrir_reclamacao com o número dela, em vez de abrir uma nova.
${cfg.instrucoes_extras ? `\nINSTRUÇÕES DA ADMINISTRAÇÃO\n${cfg.instrucoes_extras}\n` : ''}${textoAprendido}
DOCUMENTOS DO CONDOMÍNIO
${textoDocs || '(nenhum documento cadastrado ainda: encaminhe dúvidas de regras à administração)'}`;
}

async function montarParteVariavel(morador) {
  const [fatos, abertos, reclamacoes] = await Promise.all([
    db.from('memoria').select('fato, criado_em').eq('morador_id', morador.id).order('criado_em', { ascending: false }).limit(40).then(ok),
    db.from('chamados').select('id, titulo, status').eq('morador_id', morador.id).in('status', ['aberto', 'em_andamento']).limit(10).then(ok),
    db.from('reclamacoes').select('id, tipo, status, tratativa, criado_em').eq('autor_morador_id', morador.id).gte('criado_em', new Date(Date.now() - 15 * 86400000).toISOString()).order('criado_em', { ascending: false }).limit(5).then(ok),
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
Chamados em aberto: ${abertos.length ? abertos.map((c) => `nº ${c.id} ${c.titulo} (${sv.ROTULO_STATUS[c.status]})`).join('; ') : 'nenhum'}
Reclamações dele nos últimos 15 dias: ${reclamacoes.length ? reclamacoes.map((r) => `nº ${r.id} ${r.tipo} (${r.status.replace('_', ' ')}${r.tratativa ? `; tratativa: ${r.tratativa}` : ''})`).join('; ') : 'nenhuma'}`;
}

// Mostra no log quanto do prompt veio do cache, para conferir a economia
function registrarUso(uso) {
  if (!uso) return;
  const cache = uso.prompt_tokens_details?.cached_tokens || 0;
  const pct = uso.prompt_tokens ? Math.round((cache / uso.prompt_tokens) * 100) : 0;
  console.log(`[agente] tokens: entrada ${uso.prompt_tokens} (cache ${cache}, ${pct}%), saída ${uso.completion_tokens}`);
}

// ================== Trava para assuntos fora do condomínio ==================
// Conta as mensagens fora do assunto em 24h. Ao chegar no limite (Ajustes), pausa o atendimento do número.
// Urgências (vazamento, incêndio, gás, elevador...) passam mesmo com a pausa.
const URGENCIA = /urg[êe]n|emerg[êe]n|socorro|inc[êe]ndio|fogo|fuma[çc]a|cheiro de g[áa]s|vazamento|vazando|alagad|inunda|preso no elevador|elevador (parado|preso|travado) com|curto.?circuito|choque|desmai|ferid|assalt|invas|arromba|ladr[ãa]o/i;

async function registrarForaDoAssunto(morador, assunto) {
  const cfg = await getConfig();
  const limite = Number(cfg.fora_assunto_limite ?? 3);
  const horas = Number(cfg.fora_assunto_horas || 12);
  if (!limite) return { desligado: true };
  const recente = morador.fora_assunto_em && Date.now() - new Date(morador.fora_assunto_em).getTime() < 24 * 3600000;
  const vez = (recente ? morador.fora_assunto_vezes || 0 : 0) + 1;
  const dados = { fora_assunto_vezes: vez, fora_assunto_em: new Date().toISOString() };
  let ate = null;
  if (vez >= limite) {
    ate = new Date(Date.now() + horas * 3600000).toISOString();
    Object.assign(dados, { bloqueado_ate: ate, fora_assunto_vezes: 0 });
  }
  const r = await db.from('moradores').update(dados).eq('id', morador.id);
  if (r.error) { console.error('[fora do assunto]', r.error.message); return { desligado: true }; } // migração 009 ainda não rodou
  Object.assign(morador, dados);
  console.log(`[fora do assunto] ${morador.nome}: ${vez}/${limite} (${String(assunto || '').slice(0, 60)})${ate ? ' -> pausado' : ''}`);
  return ate ? { bloqueado: true, ate, horas } : { vez, limite, horas };
}

function mensagemDePausa(morador, ate) {
  const quando = new Date(ate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', hour: '2-digit', minute: '2-digit' });
  return `${primeiroNome(morador.nome)}, como as últimas mensagens não eram sobre o condomínio, pausei o atendimento automático deste número até ${quando}. Sou o assistente do prédio e só consigo ajudar com assuntos do condomínio.\n\nSe for urgente (vazamento, incêndio, gás, alguém preso no elevador), pode escrever que eu atendo mesmo assim. Para outros assuntos, fale com a administração ou a portaria.`;
}

// Rede de segurança: se o assistente disse que encaminhou, avisou ou vai verificar com a administração,
// mas não chamou nenhuma ferramenta, registra a dúvida de verdade (a administração é avisada) e informa o número.
// Só afirmações ("encaminhei", "vou verificar", "protocolo gerado"); oferecer ("quer que eu encaminhe?") não conta.
const PROMETEU_ENCAMINHAR = /protocolo (gerado|n[ºo°]|registrado)|(j[áa] )?encaminhei|vou encaminhar|estou encaminhando|repassei|vou repassar|vou (verificar|confirmar|perguntar|checar|consultar)|avisei a administra|a administra[çc][ãa]o (j[áa] foi avisada|(vai|ir[áa]) (te )?(retornar|responder|entrar em contato))/i;
const SO_OFERECEU = /(quer|deseja|gostaria) que eu|posso (encaminhar|repassar|perguntar)/i;
async function garantirEncaminhamento(resposta, morador, pergunta, ctx) {
  if (!resposta || ctx.acoes.length || !PROMETEU_ENCAMINHAR.test(resposta) || SO_OFERECEU.test(resposta)) return resposta;
  try {
    const d = await require('./duvidas').registrar({ morador, pergunta: String(pergunta).replace(/^\[[^\]]*\]\s*/, '').slice(0, 500), contexto: `Resposta dada pelo assistente: ${resposta.slice(0, 400)}` });
    ctx.acoes.push(`dúvida ${d.id}`);
    console.log('[agente] prometeu encaminhar sem ferramenta: dúvida', d.id, 'registrada');
    // Troca a resposta inteira: a do modelo pode ter número de protocolo inventado
    return `${primeiroNome(morador.nome)}, ainda não tenho essa informação. Já perguntei à administração (pergunta nº ${d.id}) e te aviso aqui assim que responderem. Posso ajudar em mais alguma coisa?`;
  } catch (e) {
    console.error('[agente] registrar dúvida automática', e.message);
    return resposta;
  }
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
    if (!msg.tool_calls?.length) {
      const final = await garantirEncaminhamento((msg.content || '').trim(), morador, texto, ctx);
      // Aviso fixo antes da pausa (não depende da IA lembrar)
      return ctx.avisoPausa ? `${final}

⚠️ Atenção: se a próxima mensagem também não for sobre o condomínio, o atendimento automático fica pausado por ${ctx.avisoPausa} horas.` : final;
    }
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
    // Chegou no limite de assuntos fora do condomínio: responde com a mensagem fixa de pausa
    if (ctx.bloqueadoAte) return mensagemDePausa(morador, ctx.bloqueadoAte);
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

// Quem não é morador cadastrado (nem da administração): só é atendido se pedir o cadastro.
// Quem está no grupo dos moradores se cadastra sozinho; quem não está é orientado a procurar a administração.
// Qualquer outra mensagem de número desconhecido é ignorada (não responde e não grava).
async function atenderNaoCadastrado(tel, nome, texto) {
  try { await require('./autocadastro').atender(tel, nome, texto); } catch (e) { console.error('[autocadastro]', e.message); }
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
    if (admin) {
      // A imagem que o síndico mandou (para um aviso com imagem no grupo)
      const { foto } = midiaPendente(tel);
      return noCondominio(admin.condominio_id, () => require('./agente_admin').atenderAdminWhatsApp(admin, tel, texto, { foto, limpar: () => midiasPendentes.delete(tel) }));
    }

    // De qual condomínio é este morador. Número desconhecido: só o pedido de cadastro é atendido.
    const cadastros = (await sv.moradorEmTodos(tel)).filter((m) => m.ativo);
    if (!cadastros.length) {
      if ((await sv.moradorEmTodos(tel)).length) return; // cadastrado, mas desativado
      return atenderNaoCadastrado(tel, b.nome, texto);
    }
    const escolhido = await escolherCondominio(tel, cadastros, texto);
    if (!escolhido) return;
    return noCondominio(escolhido.condominioId, () => atenderMorador(tel, b, escolhido.texto));
  });
}

// Quem mora (ou tem apartamento) em mais de um condomínio atendido pelo mesmo número:
// usa o prédio escolhido nas últimas 2 horas; se não houver, pergunta com botões.
async function escolherCondominio(tel, cadastros, texto) {
  if (cadastros.length === 1) return { condominioId: cadastros[0].condominio_id, texto };
  const { dbGlobal } = require('./db');
  const botao = (/\[\[cond_([0-9a-f-]{36})\]\]/.exec(texto) || [])[1];
  if (botao) {
    const m = cadastros.find((c) => c.condominio_id === botao);
    if (m) {
      await dbGlobal.from('moradores').update({ conversa_em: new Date().toISOString() }).eq('id', m.id);
      const resto = texto.replace(/\[\[cond_[0-9a-f-]{36}\]\]/g, '').trim();
      if (!resto) {
        await noCondominio(m.condominio_id, () => sv.enviar(tel, `Certo, ${primeiroNome(m.nome)}! Agora estamos falando do ${m.condominio.nome}. Pode mandar sua mensagem. Para trocar de prédio, escreva "trocar de condomínio".`, m.id));
        return null;
      }
      return { condominioId: m.condominio_id, texto: resto };
    }
  }
  const trocar = /trocar (de )?(condom[ií]nio|pr[eé]dio)/i.test(texto);
  const recente = trocar ? null : cadastros
    .filter((c) => c.conversa_em && Date.now() - new Date(c.conversa_em).getTime() < 2 * 3600000)
    .sort((a, b) => new Date(b.conversa_em) - new Date(a.conversa_em))[0];
  if (recente) {
    await dbGlobal.from('moradores').update({ conversa_em: new Date().toISOString() }).eq('id', recente.id);
    return { condominioId: recente.condominio_id, texto };
  }
  await noCondominio(cadastros[0].condominio_id, () => sv.enviarBotoes(tel,
    `Olá, ${primeiroNome(cadastros[0].nome)}! Você está cadastrado(a) em mais de um condomínio. Sobre qual prédio é a sua mensagem?`,
    cadastros.slice(0, 3).map((c) => `🏢 ${c.condominio.nome}|cond_${c.condominio_id}`),
    { planoB: `Responda com o nome do prédio: ${cadastros.map((c) => c.condominio.nome).join(' ou ')}.`, moradorId: cadastros[0].id }));
  return null;
}

async function atenderMorador(tel, b, texto) {
  {
    const morador = await sv.acharMorador(tel);
    if (!morador || !morador.ativo) return;
    // Botão "Já retirei" da encomenda: resolve direto, sem IA
    const retirei = /\[\[enc_retirei:(\d+)\]\]/.exec(texto);
    if (retirei) {
      const r = await require('./encomendas').retirar(Number(retirei[1]), { morador });
      await sv.enviar(morador.telefone, r.msg, morador.id);
      return;
    }
    // Botão antigo do cadastro clicado por quem já está cadastrado: não interessa ao assistente
    if (/^\s*(\[\[cad_[a-z_]+\]\]\s*)+$/.test(texto)) return;

    const limite = dentroDoLimite(tel);
    if (!limite.ok) {
      if (limite.primeiraVezAcima) await sv.enviar(tel, 'Recebi muitas mensagens em pouco tempo. Vou pausar as respostas automáticas por alguns minutos. Se for urgente, fale com a portaria.', morador.id);
      return;
    }

    await inserirMensagem({ morador_id: morador.id, telefone: morador.telefone, direcao: 'entrada', texto, wa_id: b.waId || null });
    await db.from('moradores').update({ ultima_interacao: new Date().toISOString() }).eq('id', morador.id);

    // Atendimento pausado por assuntos fora do condomínio: só passam urgências (a mensagem fica registrada)
    if (morador.bloqueado_ate && new Date(morador.bloqueado_ate) > new Date() && !URGENCIA.test(texto)) {
      console.log(`[fora do assunto] ${morador.nome} pausado até ${morador.bloqueado_ate}: mensagem não respondida`);
      return;
    }

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
  }
}

// Entrada principal: chamada pelo webhook para cada mensagem privada
// Transforma cada formato (texto, áudio, foto, vídeo, documento...) em texto que o assistente entende
// O que cada botão clicado significa para o assistente
const BOTOES = {
  abrir_chamado_grupo: 'Sim, quero abrir um chamado sobre o que eu falei no grupo.',
  nao_precisa: 'Não precisa, obrigado.',
  confirmar_aviso: 'Sim, pode enviar o aviso.',
  ajustar_aviso: 'Quero ajustar o aviso antes de enviar.',
};

async function lerConteudo(tel, { texto, midia, ids, tipoMensagem, nomeArquivo, botao }) {
  if (botao) {
    if (BOTOES[botao]) return BOTOES[botao];
    if (/^cad_[a-z0-9_-]+$/.test(botao)) return `[[${botao}]]`; // botões do autocadastro
    if (/^cond_[0-9a-f-]{36}$/.test(botao)) return `[[${botao}]]`; // escolha do condomínio
    if (/^enc_retirei:\d+$/.test(botao)) return `[[${botao}]]`; // "Já retirei" da encomenda
    const voltou = /^reclamacao_voltou:(\d+)$/.exec(botao);
    if (voltou) return `O problema da reclamação nº ${voltou[1]} voltou a acontecer.`;
    if (botao === 'reclamacao_ok') return 'Está resolvido, obrigado!';
    if (/^[1-5]$/.test(botao)) return botao; // nota do atendimento
    return `[clicou no botão: ${texto || botao}]`;
  }
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
  await sv.enviarBotoes(morador.telefone, `Oi, ${primeiroNome(morador.nome)}! Vi sua mensagem no grupo sobre ${r.resumo}. Quer que eu abra um chamado para a equipe resolver? Se quiser, pode mandar uma foto ou um áudio.`,
    ['🔧 Abrir chamado|abrir_chamado_grupo', 'Não precisa|nao_precisa'], { planoB: 'É só responder aqui.', moradorId: morador.id });
}

module.exports = { receberMensagemPrivada, avaliarMensagemDoGrupo, _teste: { montarParteFixa, FERRAMENTAS, responder } };
