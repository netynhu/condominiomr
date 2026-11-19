// Assistente da administração: o síndico manda comandos pelo WhatsApp (ou pela tela "Assistente" do painel)
// e o agente executa no sistema: avisos, agenda, chamados, moradores e resumos.
// Regra de ouro: nada sai para os moradores sem uma prévia e um "sim" explícito.
const { db, ok, getConfig } = require('./db');
const { env } = require('./config');
const { openai, completar } = require('./ia');
const sv = require('./servicos');
const { variantesTelefone, normalizarTelefone, dataExtenso, dataHora, localParaISO, hojeParaIA } = require('./util');

const HISTORICO = 20;

async function acharAdmin(telefone) {
  const vars = variantesTelefone(telefone);
  if (!vars[0]) return null;
  const [u] = ok(await db.from('usuarios').select('id, nome, perfil, telefone').in('telefone', vars).eq('ativo', true).eq('perfil', 'admin').limit(1));
  return u || null;
}

const paraISO = (s) => (!s ? null : /[zZ]|[+-]\d\d:\d\d$/.test(s) ? new Date(s).toISOString() : localParaISO(s.slice(0, 16)));

const FERRAMENTAS = [
  {
    name: 'preparar_aviso',
    description: 'Cria o RASCUNHO de um aviso para os moradores e devolve a prévia. Não envia nada. Depois mostre a prévia ao síndico e pergunte se pode enviar.',
    parameters: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Curto, ex.: "Manutenção do elevador"' },
        texto: { type: 'string', description: 'Texto claro e educado, sem saudação inicial' },
        canal: { type: 'string', enum: ['grupo', 'privado'], description: 'grupo (padrão) ou privado de cada morador' },
        bloco: { type: 'string', description: 'Só para canal privado: limitar a um bloco' },
      },
      required: ['titulo', 'texto'],
    },
  },
  {
    name: 'enviar_aviso_confirmado',
    description: 'Envia um aviso que você preparou. Use SOMENTE depois que o síndico respondeu claramente que pode enviar (sim, pode, manda, ok) para ESTE aviso.',
    parameters: { type: 'object', properties: { aviso_id: { type: 'string' } }, required: ['aviso_id'] },
  },
  {
    name: 'criar_evento',
    description: 'Cadastra um evento na agenda do condomínio (reunião, obra, manutenção, festa, interrupção). O assistente dos moradores passa a saber dele e, se avisar_vespera, posta lembrete no grupo 24h antes.',
    parameters: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        inicio: { type: 'string', description: 'AAAA-MM-DDTHH:MM no horário de Brasília' },
        fim: { type: 'string', description: 'AAAA-MM-DDTHH:MM, opcional' },
        local: { type: 'string' },
        descricao: { type: 'string' },
        bloco: { type: 'string', description: 'Se for só para um bloco' },
        avisar_vespera: { type: 'boolean', description: 'Padrão true' },
      },
      required: ['titulo', 'inicio'],
    },
  },
  {
    name: 'consultar_agenda',
    description: 'Lista os próximos eventos da agenda.',
    parameters: { type: 'object', properties: { dias: { type: 'integer' } } },
  },
  {
    name: 'listar_chamados',
    description: 'Lista chamados. Por padrão, os em aberto.',
    parameters: { type: 'object', properties: { status: { type: 'string', enum: ['abertos', 'resolvido', 'todos'] } } },
  },
  {
    name: 'atualizar_chamado',
    description: 'Muda o status de um chamado. O morador que abriu é avisado no WhatsApp.',
    parameters: {
      type: 'object',
      properties: { numero: { type: 'integer' }, status: { type: 'string', enum: ['em_andamento', 'resolvido', 'cancelado'] }, observacao: { type: 'string' } },
      required: ['numero', 'status'],
    },
  },
  {
    name: 'abrir_chamado',
    description: 'Abre um chamado para o zelador.',
    parameters: {
      type: 'object',
      properties: { titulo: { type: 'string' }, local: { type: 'string' }, descricao: { type: 'string' }, prioridade: { type: 'string', enum: ['baixa', 'normal', 'alta', 'urgente'] } },
      required: ['titulo', 'local'],
    },
  },
  {
    name: 'listar_reclamacoes',
    description: 'Lista as reclamações novas e em tratamento (sem identificar quem reclamou).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'cadastrar_morador',
    description: 'Cadastra (ou atualiza) um morador para o assistente reconhecer o WhatsApp dele.',
    parameters: {
      type: 'object',
      properties: { nome: { type: 'string' }, telefone: { type: 'string' }, bloco: { type: 'string' }, apartamento: { type: 'string' }, vaga: { type: 'string' } },
      required: ['nome', 'telefone', 'apartamento'],
    },
  },
  {
    name: 'resumo_do_predio',
    description: 'Gera o resumo do dia ou responde a uma pergunta sobre os dados do prédio (chamados, reclamações, agenda, manutenção, grupo).',
    parameters: { type: 'object', properties: { pergunta: { type: 'string', description: 'Vazio para o resumo do dia' } } },
  },
];

async function unidadeId(bloco, numero) {
  bloco = String(bloco || '').trim().toUpperCase();
  numero = String(numero || '').trim();
  if (!numero) return null;
  const [u] = ok(await db.from('unidades').select('id').eq('bloco', bloco).eq('numero', numero).limit(1));
  if (u) return u.id;
  return ok(await db.from('unidades').insert({ bloco, numero }).select('id').single()).id;
}

async function executar(nome, args, ctx) {
  const { admin } = ctx;
  switch (nome) {
    case 'preparar_aviso': {
      const canal = args.canal === 'privado' ? 'privado' : 'grupo';
      const publico = canal === 'privado' && args.bloco ? `bloco:${String(args.bloco).trim().toUpperCase()}` : 'todos';
      const av = ok(await db.from('avisos').insert({ titulo: args.titulo, texto: args.texto, canal, publico, criado_por: `${admin.nome} (WhatsApp)` }).select().single());
      const cfg = await getConfig();
      const previa = canal === 'grupo'
        ? `📢 *${av.titulo}*\n\n${av.texto}\n\n_${cfg.nome_predio} · Administração_`
        : `Olá, (nome)!\n\n${av.titulo}\n\n${av.texto}`;
      ctx.avisoPreparado = av.id;
      return { aviso_id: av.id, canal, destino: canal === 'grupo' ? `grupo ${cfg.grupo_nome || '(nenhum grupo configurado!)'}` : (publico === 'todos' ? 'privado de todos os moradores' : `privado do bloco ${publico.slice(6)}`), previa };
    }
    case 'enviar_aviso_confirmado': {
      const av = ok(await db.from('avisos').select('*').eq('id', args.aviso_id).maybeSingle());
      if (!av || av.status !== 'rascunho') return { ok: false, erro: 'Aviso não encontrado ou já enviado.' };
      if (Date.now() - new Date(av.criado_em).getTime() > 2 * 3600000) return { ok: false, erro: 'Rascunho antigo. Prepare de novo.' };
      if (av.canal === 'grupo') {
        await sv.postarNoGrupo(av.titulo, av.texto);
        ok(await db.from('avisos').update({ status: 'enviado', total: 1, enviado_em: new Date().toISOString() }).eq('id', av.id));
        return { ok: true, enviado: 'postado no grupo' };
      }
      const total = await sv.enfileirar(av.publico, `${av.titulo}\n\n${av.texto}`, av.id);
      ok(await db.from('avisos').update({ status: total ? 'enviando' : 'enviado', total }).eq('id', av.id));
      return { ok: true, enviado: `na fila para ${total} moradores (sai aos poucos)` };
    }
    case 'criar_evento': {
      const inicio = paraISO(args.inicio);
      if (!inicio || isNaN(new Date(inicio))) return { ok: false, erro: 'Data de início inválida' };
      const ev = ok(await db.from('eventos').insert({
        titulo: args.titulo, inicio, fim: paraISO(args.fim), local: args.local || null, descricao: args.descricao || null,
        publico: args.bloco ? `bloco:${String(args.bloco).trim().toUpperCase()}` : 'todos', avisar_vespera: args.avisar_vespera !== false,
      }).select().single());
      return { ok: true, evento: ev.titulo, quando: dataExtenso(ev.inicio), lembrete_no_grupo_na_vespera: ev.avisar_vespera };
    }
    case 'consultar_agenda': {
      const dias = Math.min(Math.max(Number(args.dias) || 30, 1), 180);
      const l = ok(await db.from('eventos').select('titulo, inicio, local, publico').gte('inicio', new Date().toISOString()).lte('inicio', new Date(Date.now() + dias * 86400000).toISOString()).order('inicio').limit(20));
      return l.map((e) => ({ titulo: e.titulo, quando: dataExtenso(e.inicio), local: e.local || undefined, publico: e.publico }));
    }
    case 'listar_chamados': {
      let q = db.from('chamados').select('id, titulo, local, prioridade, status, criado_em').order('criado_em', { ascending: false }).limit(25);
      if (!args.status || args.status === 'abertos') q = q.in('status', ['aberto', 'em_andamento']);
      else if (args.status !== 'todos') q = q.eq('status', args.status);
      return ok(await q).map((c) => ({ numero: c.id, titulo: c.titulo, local: c.local, prioridade: c.prioridade, status: sv.ROTULO_STATUS[c.status], aberto_em: dataHora(c.criado_em) }));
    }
    case 'atualizar_chamado': {
      const ch = await sv.mudarStatusChamado(args.numero, args.status, (args.observacao || '').trim(), `${admin.nome} (WhatsApp)`);
      return { ok: true, numero: ch.id, status: sv.ROTULO_STATUS[ch.status], morador_avisado: Boolean(ch.morador) };
    }
    case 'abrir_chamado': {
      const ch = await sv.abrirChamado({ ...args, prioridade: args.prioridade || 'normal', origem: 'painel', usuarioNome: admin.nome });
      return { ok: true, numero: ch.id };
    }
    case 'listar_reclamacoes': {
      const l = ok(await db.from('reclamacoes').select('id, tipo, unidade_alvo, descricao, status, criado_em').in('status', ['nova', 'em_tratamento']).order('criado_em', { ascending: false }).limit(20));
      return l.map((r) => ({ numero: r.id, tipo: r.tipo, unidade: r.unidade_alvo, status: r.status, quando: dataHora(r.criado_em), descricao: r.descricao.slice(0, 200) }));
    }
    case 'cadastrar_morador': {
      const telefone = normalizarTelefone(args.telefone);
      if (telefone.length < 12) return { ok: false, erro: 'Telefone inválido: precisa do DDD.' };
      const m = ok(await db.from('moradores').upsert({ nome: args.nome, telefone, vaga: args.vaga || null, unidade_id: await unidadeId(args.bloco, args.apartamento) }, { onConflict: 'telefone' }).select('*, unidade:unidades(*)').single());
      await db.from('contatos_pendentes').delete().eq('telefone', telefone);
      let boasVindas = false;
      try { boasVindas = await sv.boasVindas(m); } catch (e) { console.error('[admin] boas-vindas', e.message); }
      return { ok: true, cadastrado: args.nome, boas_vindas_enviada_com_botao_do_grupo: boasVindas };
    }
    case 'resumo_do_predio': {
      const { panorama } = require('./rotas/inteligencia');
      const dados = await panorama();
      const pergunta = args.pergunta || 'Faça o resumo do dia: o que é urgente, o que está parado e os próximos compromissos, com o próximo passo de cada item.';
      return { texto: await completar('Você ajuda o síndico a decidir. Português do Brasil, direto, curto, próprio para WhatsApp (sem markdown pesado). Use só os dados fornecidos e nunca invente números.', `${pergunta}\n\nDADOS:\n${JSON.stringify(dados)}`, { maxTokens: 700 }) };
    }
    default:
      return { ok: false, erro: 'Ferramenta desconhecida' };
  }
}

async function sistema(admin, canal = 'whatsapp') {
  const cfg = await getConfig();
  return `Você é o assistente da administração do ${cfg.nome_predio}. Quem fala com você é ${admin.nome}, da administração (síndico/gestão), não um morador.
Hoje: ${hojeParaIA()}. Use isso para entender "amanhã", "terça", "dia 25" (sempre a próxima ocorrência a partir de hoje, no ano certo). Ao confirmar, escreva a data por extenso com o dia da semana.
Grupo dos moradores configurado: ${cfg.grupo_nome || 'nenhum'}.
${canal === 'painel' ? 'Você está na tela Assistente do painel (sistema logado): pode cadastrar moradores.' : 'Você está no WhatsApp. Cadastro de moradores NÃO é feito por aqui: se pedirem, explique que o cadastro é só no painel, na página Moradores ou na tela Assistente.'}

COMO TRABALHAR
- Respostas curtas, próprias de WhatsApp. Sem markdown pesado.
- Execute os pedidos com as ferramentas. Se faltar algo essencial (data, horário), pergunte uma coisa só.
- AVISOS: sempre use preparar_aviso, mostre a prévia exatamente como vai sair e pergunte "Posso enviar?". Só chame enviar_aviso_confirmado depois de um sim claro para aquele aviso. Se o síndico pedir mudança, prepare um novo rascunho.
- Pedido de "aviso de manutenção/obra/reunião numa data": crie o evento na agenda (criar_evento) E prepare o aviso para o grupo, mostrando a prévia.
- Ao atualizar chamado, confirme o número e o novo status.
- Reclamações: nunca tente descobrir quem reclamou.
- Ao final de cada ação, diga em uma linha o que foi feito.
- Se uma ferramenta devolver erro, conte ao síndico em linguagem simples qual foi o problema (ex.: grupo não configurado) e o que fazer. Não diga só que houve um problema técnico.`;
}

// Conversa com a administração. "canal" identifica o histórico: telefone do WhatsApp ou "painel-<id>"
async function responderAdmin(admin, canal, texto, ctx = { admin }) {
  const anteriores = ok(await db.from('mensagens').select('direcao, texto').eq('telefone', canal).order('criado_em', { ascending: false }).limit(HISTORICO + 1)).reverse();
  if (anteriores.length && anteriores[anteriores.length - 1].direcao === 'entrada') anteriores.pop();
  const mensagens = [
    { role: 'system', content: await sistema(admin, ctx.canal) },
    ...anteriores.map((m) => ({ role: m.direcao === 'entrada' ? 'user' : 'assistant', content: m.texto })),
    { role: 'user', content: texto },
  ];
  const SO_NO_PAINEL = ['cadastrar_morador'];
  const tools = FERRAMENTAS.filter((f) => ctx.canal === 'painel' || !SO_NO_PAINEL.includes(f.name)).map((f) => ({ type: 'function', function: f }));
  for (let volta = 0; volta < 8; volta++) {
    const r = await openai().chat.completions.create({ model: env.OPENAI_MODEL, messages: mensagens, tools, temperature: 0.2 });
    const msg = r.choices[0].message;
    if (!msg.tool_calls?.length) return (msg.content || '').trim();
    mensagens.push(msg);
    for (const call of msg.tool_calls) {
      let resultado;
      try { resultado = await executar(call.function.name, JSON.parse(call.function.arguments || '{}'), ctx); } catch (e) {
        console.error('[admin] ferramenta', call.function.name, e.message);
        resultado = { ok: false, erro: e.message };
      }
      mensagens.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(resultado) });
    }
  }
  return 'Fiz o que consegui. Confira no painel.';
}

// Mensagem da administração pelo WhatsApp
async function atenderAdminWhatsApp(admin, tel, texto) {
  ok(await db.from('mensagens').insert({ telefone: tel, direcao: 'entrada', texto }));
  let resposta;
  const ctx = { admin };
  try { resposta = await responderAdmin(admin, tel, texto, ctx); } catch (e) {
    console.error('[admin] erro', e.message);
    resposta = 'Tive um problema técnico para executar. Tente de novo ou use o painel.';
  }
  if (!resposta) return;
  // Aviso preparado: botões para confirmar ou ajustar (plano B: responder sim)
  if (ctx.avisoPreparado) {
    await sv.enviarBotoes(tel, resposta, ['✅ Pode enviar|confirmar_aviso', '✏️ Quero ajustar|ajustar_aviso'], { planoB: 'Responda "sim" para enviar ou diga o que ajustar.', rotulo: 'você, como síndico' });
  } else await sv.enviar(tel, resposta, null, 'você, como síndico');
}

// Mensagem da administração pela tela "Assistente" do painel
async function atenderAdminPainel(usuario, texto) {
  const canal = `painel-${usuario.id}`;
  ok(await db.from('mensagens').insert({ telefone: canal, direcao: 'entrada', texto }));
  const resposta = await responderAdmin({ ...usuario }, canal, texto, { admin: { ...usuario }, canal: 'painel' });
  ok(await db.from('mensagens').insert({ telefone: canal, direcao: 'saida', texto: resposta }));
  return resposta;
}

async function historicoPainel(usuarioId) {
  return ok(await db.from('mensagens').select('direcao, texto, criado_em').eq('telefone', `painel-${usuarioId}`).order('criado_em', { ascending: false }).limit(40)).reverse();
}

module.exports = { acharAdmin, atenderAdminWhatsApp, atenderAdminPainel, historicoPainel, _teste: { FERRAMENTAS, sistema } };
