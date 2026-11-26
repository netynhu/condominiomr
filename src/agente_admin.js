// Assistente da administração: o síndico manda comandos pelo WhatsApp (ou pela tela "Assistente" do painel)
// e o agente executa no sistema: avisos, agenda, chamados, moradores e resumos.
// Regra de ouro: nada sai para os moradores sem uma prévia e um "sim" explícito.
const { db, dbGlobal, ok, getConfig } = require('./db');
const { env } = require('./config');
const { openai, completar } = require('./ia');
const sv = require('./servicos');
const { noCondominio } = require('./contexto');
const { variantesTelefone, normalizarTelefone, dataExtenso, dataHora, localParaISO, hojeParaIA } = require('./util');

const HISTORICO = 20;

// Quem da equipe pode dar comandos pelo WhatsApp: o número precisa estar cadastrado na Equipe do condomínio.
// Cada perfil só usa as ferramentas dele (o síndico e a administração usam todas).
const PERFIS_COM_COMANDOS = ['admin', 'sindico', 'portaria', 'zelador'];
const PERMITIDAS = {
  portaria: ['preparar_aviso', 'enviar_aviso_confirmado', 'registrar_encomenda', 'listar_encomendas', 'entregar_encomenda', 'abrir_chamado', 'consultar_agenda', 'trocar_condominio'],
  zelador: ['registrar_encomenda', 'listar_encomendas', 'entregar_encomenda', 'listar_chamados', 'atualizar_chamado', 'abrir_chamado', 'registrar_manutencao', 'consultar_agenda', 'trocar_condominio'],
};
const podeUsar = (pessoa, ferramenta) => !PERMITIDAS[pessoa?.perfil] || PERMITIDAS[pessoa.perfil].includes(ferramenta);
const PAPEL = { admin: 'da administração', sindico: 'o síndico', portaria: 'da portaria', zelador: 'da manutenção (zeladoria)' };
const ROTULO = { admin: 'você, da administração', sindico: 'você, como síndico', portaria: 'você, da portaria', zelador: 'você, da manutenção' };

async function acharAdmin(telefone) {
  const vars = variantesTelefone(telefone);
  if (!vars[0]) return null;
  const [u] = ok(await dbGlobal.from('usuarios').select('id, nome, perfil, telefone, dono, condominio_atual').in('telefone', vars).eq('ativo', true).in('perfil', PERFIS_COM_COMANDOS).limit(1));
  if (!u) return null;
  // Em qual condomínio ele está trabalhando: o escolhido por último, ou o primeiro da lista
  u.condominios = await sv.condominiosDoUsuario(u);
  if (!u.condominios.length) return null;
  u.condominio_id = (u.condominios.find((c) => c.id === u.condominio_atual) || u.condominios[0]).id;
  return u;
}

// ---------- Equipe com mais de um prédio: de qual prédio é a mensagem ----------
// 1) Citou o prédio ("aviso no Smile") -> é dele. 2) Está no meio de uma conversa (últimos 30 min) -> mesmo prédio.
// 3) Senão, pergunta com botões e guarda o pedido até a escolha. Toda resposta mostra o prédio (🏢 Nome).
const CONVERSA_MS = 30 * 60000;
const aguardandoPredio = new Map(); // telefone -> { texto, em }
const normal = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const COMUNS = new Set(['edificio', 'condominio', 'residencial', 'predio', 'torre', 'torres', 'parque', 'jardim', 'jardins', 'conjunto', 'residence', 'village', 'bloco', 'vila', 'solar', 'home', 'parada', 'vista', 'alto', 'central', 'nova', 'novo', 'santa', 'santo', 'park', 'plaza', 'garden', 'flores', 'bela', 'belo', 'sul', 'norte', 'leste', 'oeste', 'mais']);

// O nome do prédio aparece no texto como prédio, e não como nome de pessoa?
// "Encomenda para Teste do 302" fala da moradora Teste, não do condomínio Teste.
const PREPOSICAO = new Set(['no', 'na', 'o', 'a', 'do', 'da', 'condominio', 'predio', 'edificio', 'residencial', 'torre', 'em']);
function citaComoPredio(t, nome) {
  const palavras = nome.split(' ');
  let i = t.indexOf(` ${nome} `);
  while (i >= 0) {
    const antes = t.slice(0, i).trim().split(' ').pop();
    const depois = t.slice(i + nome.length + 2).trim().split(' ');
    const ehPessoa = /^\d/.test(depois[0] || '') || (['do', 'da', 'apto', 'ap', 'apartamento', 'bloco'].includes(depois[0]) && /^\d/.test(depois[1] || ''));
    // Nome de uma palavra só ("Teste", "Smile"): precisa de "no/do/condomínio..." antes, para não confundir com pessoa
    if (!ehPessoa && (palavras.length > 1 || PREPOSICAO.has(antes))) return true;
    i = t.indexOf(` ${nome} `, i + 1);
  }
  return false;
}

function predioCitado(texto, lista) {
  const t = ` ${normal(texto).replace(/[^a-z0-9]+/g, ' ')} `;
  const nomeTodo = lista.filter((c) => citaComoPredio(t, normal(c.nome).replace(/[^a-z0-9]+/g, ' ').trim()));
  if (nomeTodo.length === 1) return nomeTodo[0];
  const porPalavra = lista.filter((c) => normal(c.nome).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !COMUNS.has(w)).some((w) => citaComoPredio(t, w)));
  return porPalavra.length === 1 ? porPalavra[0] : null;
}

async function escolherPredioDaEquipe(admin, tel, texto) {
  const lista = admin.condominios || [];
  if (lista.length <= 1) return { condominioId: admin.condominio_id, texto };
  const guardado = aguardandoPredio.get(tel);
  const pendente = guardado && Date.now() - guardado.em < CONVERSA_MS ? guardado : null;
  const botao = (/\[\[eqcond_([0-9a-f-]{36})\]\]/.exec(texto) || [])[1];
  const resto = texto.replace(/\[\[eqcond_[0-9a-f-]{36}\]\]/g, '').trim();
  const escolhido = (botao && lista.find((c) => c.id === botao)) || predioCitado(resto, lista);

  if (escolhido) {
    await dbGlobal.from('usuarios').update({ condominio_atual: escolhido.id }).eq('id', admin.id);
    // Resposta à pergunta "qual prédio?": segue com o pedido que estava guardado
    if (pendente && (botao || resto.length <= 60)) {
      aguardandoPredio.delete(tel);
      return { condominioId: escolhido.id, texto: pendente.texto };
    }
    aguardandoPredio.delete(tel);
    if (!resto) { // tocou no botão, mas o pedido guardado já expirou
      await noCondominio(escolhido.id, () => sv.enviar(tel, `🏢 *${escolhido.nome}*\nCerto! Pode mandar o pedido.`, null, ROTULO[admin.perfil]));
      return null;
    }
    return { condominioId: escolhido.id, texto: resto };
  }

  // No meio de uma conversa: continua no mesmo prédio (ex.: "sim, pode enviar").
  // Imagem nova é um pedido novo: sempre pergunta o prédio (a não ser que a legenda cite o nome).
  const imagemNova = /\[o morador enviou uma foto/.test(texto);
  if (!pendente && !imagemNova) {
    const [ultima] = ok(await dbGlobal.from('mensagens').select('condominio_id, criado_em').eq('telefone', tel).not('condominio_id', 'is', null)
      .gte('criado_em', new Date(Date.now() - CONVERSA_MS).toISOString()).order('criado_em', { ascending: false }).limit(1));
    if (ultima && lista.some((c) => c.id === ultima.condominio_id)) return { condominioId: ultima.condominio_id, texto };
  }

  // Pergunta com botões e guarda o pedido
  const pedido = pendente ? `${pendente.texto}\n${texto}` : texto;
  aguardandoPredio.set(tel, { texto: pedido, em: Date.now() });
  const resumo = pedido.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  await sv.enviarBotoes(tel, `Para qual condomínio é isso?${resumo ? `\n\n"${resumo}${resumo.length >= 80 ? '...' : ''}"` : ''}`,
    lista.slice(0, 10).map((c) => `🏢 ${c.nome}|eqcond_${c.id}`),
    { tipo: lista.length > 3 ? 'list' : 'button', botaoLista: 'Escolher o prédio', planoB: `Responda com o nome do prédio: ${lista.map((c) => c.nome).join(', ')}.` });
  return null;
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
        com_imagem: { type: 'boolean', description: 'true quando mandaram uma imagem (cartaz, comunicado) para ir junto no grupo, agora ou no rascunho anterior (ao ajustar, a imagem do rascunho é reaproveitada). Só funciona no canal grupo.' },
        so_imagem: { type: 'boolean', description: 'true quando pedirem para postar SÓ a imagem, sem palavras: vai sem título, sem texto e sem assinatura. Título e texto podem ficar vazios.' },
      },
      required: [],
    },
  },
  {
    name: 'enviar_aviso_confirmado',
    description: 'Envia o aviso que você preparou (o último rascunho). Use SOMENTE depois que responderam claramente que pode enviar (sim, pode, manda, ok). NÃO prepare o aviso de novo para enviar: só chame esta ferramenta. aviso_id é opcional.',
    parameters: { type: 'object', properties: { aviso_id: { type: 'string', description: 'Opcional. Sem ele, envia o último rascunho desta pessoa.' } } },
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
    description: 'Abre um chamado para a equipe de manutenção.',
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
    name: 'listar_duvidas',
    description: 'Lista as perguntas de moradores que o assistente não soube responder e que esperam resposta da administração.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'responder_duvida',
    description: 'Responde uma pergunta de morador que o assistente não soube responder. O morador recebe a resposta no WhatsApp e, se ensinar=true, o assistente passa a usar essa resposta nas próximas perguntas. Use quando o síndico escrever algo como "resposta 3: ..." ou responder a uma pergunta listada.',
    parameters: {
      type: 'object',
      properties: {
        numero: { type: 'number', description: 'Número da dúvida' },
        resposta: { type: 'string', description: 'A resposta, escrita de forma clara para o morador' },
        ensinar: { type: 'boolean', description: 'true (padrão) para o assistente aprender; false se a resposta vale só para este morador' },
      },
      required: ['numero', 'resposta'],
    },
  },
  {
    name: 'registrar_manutencao',
    description: 'Registra no histórico uma manutenção que foi feita (ex.: "a caixa d’água foi limpa hoje pela Hidro Limp"). Se combinar com um item da manutenção preventiva, agenda a próxima. O assistente dos moradores passa a responder com essa informação.',
    parameters: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'O que foi feito, ex.: "Limpeza da caixa d’água"' },
        feita_em: { type: 'string', description: 'Data AAAA-MM-DD (hoje se não for dita)' },
        empresa: { type: 'string', description: 'Empresa ou responsável (opcional)' },
        observacao: { type: 'string' },
      },
      required: ['titulo'],
    },
  },
  {
    name: 'registrar_encomenda',
    description: 'Registra uma encomenda que chegou para um apartamento. Os moradores do apartamento são avisados na hora pelo WhatsApp (com a foto, se houver) e cobrados até retirarem. Ex.: "encomenda para 305 Julia" + foto.',
    parameters: {
      type: 'object',
      properties: {
        apartamento: { type: 'string', description: 'Número do apartamento, ex.: "305"' },
        bloco: { type: 'string', description: 'Bloco/torre, se o prédio tiver' },
        para: { type: 'string', description: 'Nome de quem vai receber, se disseram (ex.: "Julia")' },
        observacao: { type: 'string', description: 'Detalhe útil, ex.: "Mercado Livre, caixa grande"' },
        com_foto: { type: 'boolean', description: 'true quando mandaram a foto da encomenda (aparece como "[o morador enviou uma foto...]")' },
      },
      required: ['apartamento'],
    },
  },
  {
    name: 'listar_encomendas',
    description: 'Lista as encomendas que ainda esperam retirada (todas ou de um apartamento).',
    parameters: { type: 'object', properties: { apartamento: { type: 'string' }, bloco: { type: 'string' } } },
  },
  {
    name: 'entregar_encomenda',
    description: 'Marca uma encomenda como entregue/retirada (para de cobrar o morador). Use o número da lista de encomendas.',
    parameters: { type: 'object', properties: { numero: { type: 'integer' } }, required: ['numero'] },
  },
  {
    name: 'trocar_condominio',
    description: 'Troca o condomínio em que você está trabalhando com o síndico (quando ele administra mais de um). Use quando ele pedir para falar de outro prédio.',
    parameters: { type: 'object', properties: { nome: { type: 'string', description: 'Nome (ou parte do nome) do condomínio' } }, required: ['nome'] },
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

// Apartamento do prédio: o que já está no cadastro ou, se ainda não tem ninguém, um da lista
// "Apartamentos do prédio" (Configurações). Número fora da lista não vale (evita erro de digitação).
async function acharUnidade(bloco, numero) {
  numero = String(numero || '').replace(/\D/g, '');
  if (!numero) return null;
  let q = db.from('unidades').select('id, bloco, numero').eq('numero', String(Number(numero)));
  if (String(bloco || '').trim()) q = q.eq('bloco', String(bloco).trim().toUpperCase());
  const lista = ok(await q.limit(5));
  if (lista.length) return lista.length === 1 ? lista[0] : { varios: lista };
  const { lerUnidadesValidas, lerApartamento } = require('./autocadastro');
  const validas = lerUnidadesValidas((await getConfig()).unidades_validas);
  if (!validas.length) return null;
  const a = lerApartamento(`${bloco || ''} ${numero}`, validas);
  if (!a || a.invalido) return null;
  if (a.faltaBloco) return { varios: a.blocos.map((b) => ({ bloco: b })) };
  return { id: await sv.unidadeId(a.bloco, a.numero), bloco: a.bloco, numero: a.numero };
}

async function executar(nome, args, ctx) {
  const { admin } = ctx;
  if (!podeUsar(admin, nome)) return { ok: false, erro: 'Esse pedido não é liberado para o seu perfil. Fale com o síndico ou a administração.' };
  switch (nome) {
    case 'registrar_encomenda': {
      const un = await acharUnidade(args.bloco, args.apartamento);
      if (!un) return { ok: false, erro: `Não encontrei o apartamento ${args.apartamento}${args.bloco ? ` do bloco ${args.bloco}` : ''} no cadastro. Confira o número.` };
      if (un.varios) return { ok: false, erro: `Existe o ${args.apartamento} em mais de um bloco (${un.varios.map((u) => u.bloco).join(', ')}). Pergunte qual é o bloco.` };
      if (args.com_foto && !ctx.foto) return { ok: false, erro: 'Não recebi a foto. Peça para mandar a foto de novo, junto com o apartamento.' };
      const foto = args.com_foto ? ctx.foto : null;
      if (foto) ctx.limparMidia?.();
      const observacao = [args.para && `Para ${String(args.para).trim()}`, args.observacao && String(args.observacao).trim()].filter(Boolean).join(' · ');
      const r = await require('./encomendas').registrar({ unidadeId: un.id, observacao, foto, por: `${admin.nome} (WhatsApp)` });
      return { ok: true, numero: r.encomenda.id, apartamento: `${un.bloco ? `${un.bloco}/` : ''}${un.numero}`, com_foto: Boolean(foto), moradores_avisados: r.avisados,
        aviso: r.moradores ? undefined : 'Nenhum morador desse apartamento está cadastrado: ninguém foi avisado. A encomenda ficou registrada.' };
    }
    case 'listar_encomendas': {
      let q = db.from('encomendas').select('id, observacao, recebida_em, unidade:unidades(bloco, numero)').eq('status', 'aguardando').order('recebida_em').limit(30);
      if (args.apartamento) {
        const un = await acharUnidade(args.bloco, args.apartamento);
        if (!un || un.varios) return { ok: false, erro: 'Apartamento não encontrado (ou falta o bloco).' };
        q = q.eq('unidade_id', un.id);
      }
      const l = ok(await q);
      return l.length ? l.map((e) => ({ numero: e.id, apartamento: `${e.unidade?.bloco ? `${e.unidade.bloco}/` : ''}${e.unidade?.numero || '?'}`, detalhe: e.observacao || undefined, chegou: dataHora(e.recebida_em) })) : { nenhuma: true };
    }
    case 'entregar_encomenda': {
      const r = await require('./encomendas').retirar(Number(args.numero), { por: `${admin.nome} (WhatsApp)` });
      return { ok: r.ok, ja_estava_entregue: Boolean(r.jaFeito), erro: r.ok ? undefined : r.msg };
    }
    case 'preparar_aviso': {
      const canal = args.canal === 'privado' ? 'privado' : 'grupo';
      const publico = canal === 'privado' && args.bloco ? `bloco:${String(args.bloco).trim().toUpperCase()}` : 'todos';
      const soImagem = Boolean(args.so_imagem);
      const comImagem = Boolean(args.com_imagem || soImagem);
      let imagem = comImagem ? ctx.foto : null;
      // Ajuste de um aviso com imagem: a imagem já está no rascunho anterior desta pessoa
      if (comImagem && !imagem) {
        const [anterior] = ok(await db.from('avisos').select('imagem').eq('criado_por', `${admin.nome} (WhatsApp)`).eq('status', 'rascunho').not('imagem', 'is', null)
          .gte('criado_em', new Date(Date.now() - 2 * 3600000).toISOString()).order('criado_em', { ascending: false }).limit(1));
        imagem = anterior?.imagem || null;
      }
      if (comImagem && !imagem) return { ok: false, erro: 'Não recebi a imagem. Peça para mandar a imagem de novo, junto com o pedido.' };
      if (comImagem && canal !== 'grupo') return { ok: false, erro: 'Aviso com imagem só pode ir para o grupo.' };
      if (!soImagem && (!String(args.titulo || '').trim() || !String(args.texto || '').trim())) return { ok: false, erro: 'Falta o título ou o texto do aviso.' };
      // Só a imagem: vai sem legenda nenhuma (o título fica só para o histórico do painel)
      const dados = soImagem
        ? { titulo: String(args.titulo || '').trim() || 'Imagem no grupo', texto: '', canal, publico, criado_por: `${admin.nome} (WhatsApp)` }
        : { titulo: args.titulo, texto: args.texto, canal, publico, criado_por: `${admin.nome} (WhatsApp)` };
      if (imagem) { dados.imagem = imagem; if (imagem === ctx.foto) ctx.limparMidia?.(); }
      const av = ok(await db.from('avisos').insert(dados).select().single());
      const cfg = await getConfig();
      const previa = soImagem ? '(só a imagem, sem nenhum texto)'
        : canal === 'grupo'
          ? `📢 *${av.titulo}*\n\n${av.texto}\n\n_${cfg.nome_predio} · Administração_`
          : `Olá, (nome)!\n\n${av.titulo}\n\n${av.texto}`;
      ctx.avisoPreparado = av.id;
      return { aviso_id: av.id, canal, com_imagem: Boolean(av.imagem), destino: canal === 'grupo' ? `grupo ${cfg.grupo_nome || '(nenhum grupo configurado!)'}` : (publico === 'todos' ? 'privado de todos os moradores' : `privado do bloco ${publico.slice(6)}`), previa };
    }
    case 'enviar_aviso_confirmado': {
      // Sem o número do aviso (o histórico da conversa não guarda): vale o último rascunho desta pessoa
      const porId = /^[0-9a-f-]{36}$/.test(String(args.aviso_id || ''));
      const av = porId
        ? ok(await db.from('avisos').select('*').eq('id', args.aviso_id).maybeSingle())
        : ok(await db.from('avisos').select('*').eq('criado_por', `${admin.nome} (WhatsApp)`).eq('status', 'rascunho')
          .gte('criado_em', new Date(Date.now() - 2 * 3600000).toISOString()).order('criado_em', { ascending: false }).limit(1))[0];
      if (!av || av.status !== 'rascunho') return { ok: false, erro: 'Aviso não encontrado ou já enviado.' };
      if (Date.now() - new Date(av.criado_em).getTime() > 2 * 3600000) return { ok: false, erro: 'Rascunho antigo. Prepare de novo.' };
      if (av.canal === 'grupo') {
        await sv.postarNoGrupo(av.titulo, av.texto, av.imagem);
        ok(await db.from('avisos').update({ status: 'enviado', total: 1, enviado_em: new Date().toISOString() }).eq('id', av.id));
        return { ok: true, enviado: av.imagem ? 'postado no grupo com a imagem' : 'postado no grupo' };
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
      const m = ok(await db.from('moradores').upsert({ nome: args.nome, telefone, vaga: args.vaga || null, unidade_id: await unidadeId(args.bloco, args.apartamento) }, { onConflict: 'condominio_id,telefone' }).select('*, unidade:unidades(*)').single());
      await db.from('contatos_pendentes').delete().eq('telefone', telefone);
      let boasVindas = false;
      try { boasVindas = await sv.boasVindas(m); } catch (e) { console.error('[admin] boas-vindas', e.message); }
      return { ok: true, cadastrado: args.nome, boas_vindas_enviada_com_botao_do_grupo: boasVindas };
    }
    case 'listar_duvidas': {
      const l = ok(await db.from('duvidas').select('id, pergunta, criado_em, morador:moradores(nome)').eq('status', 'aberta').order('criado_em').limit(20));
      return l.length ? l.map((d) => ({ numero: d.id, pergunta: d.pergunta, de: d.morador?.nome || 'morador', quando: dataHora(d.criado_em) })) : { nenhuma: true };
    }
    case 'responder_duvida': {
      const { responder } = require('./duvidas');
      const atual = await db.from('duvidas').select('id, status').eq('id', Number(args.numero)).maybeSingle();
      if (atual.error || !atual.data) return { ok: false, erro: `Não existe dúvida nº ${args.numero}.` };
      const r = await responder(Number(args.numero), args.resposta, { ensinar: args.ensinar !== false, usuarioNome: admin.nome });
      return { ok: true, numero: r.duvida.id, morador_recebeu: r.enviado, assistente_aprendeu: r.duvida.ensinar };
    }
    case 'registrar_manutencao': {
      // Liga ao item programado com nome parecido (para agendar a próxima)
      const normal = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const progs = ok(await db.from('manutencoes').select('id, titulo'));
      const alvo = normal(args.titulo);
      const item = progs.find((p) => alvo.includes(normal(p.titulo)) || normal(p.titulo).includes(alvo))
        || progs.find((p) => normal(p.titulo).split(/\W+/).filter((w) => w.length > 4).some((w) => alvo.includes(w)));
      const r = await require('./manutencoes').registrar({ manutencaoId: item?.id, titulo: args.titulo, feitaEm: args.feita_em, empresa: args.empresa, observacao: args.observacao, por: `${admin.nome} (WhatsApp)` });
      if (r.erro) return { ok: false, erro: r.erro };
      return { ok: true, registrado: r.titulo, em: r.feitaEm, item_programado: item?.titulo, proxima_agendada: r.proxima || undefined };
    }
    case 'trocar_condominio': {
      const lista = admin.condominios || [];
      const busca = String(args.nome || '').toLowerCase();
      const alvo = lista.find((c) => c.nome.toLowerCase() === busca) || lista.find((c) => c.nome.toLowerCase().includes(busca));
      if (!alvo) return { ok: false, erro: `Não encontrei esse condomínio. Os dele são: ${lista.map((c) => c.nome).join(', ')}.` };
      ok(await dbGlobal.from('usuarios').update({ condominio_atual: alvo.id }).eq('id', admin.id));
      return { ok: true, agora_trabalhando_em: alvo.nome, observacao: 'Vale a partir da próxima mensagem do síndico.' };
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
  const restrito = PERMITIDAS[admin.perfil];
  const quem = PAPEL[admin.perfil] || 'da administração';
  return `Você é o assistente da equipe do ${cfg.nome_predio}. Quem fala com você é ${admin.nome}, ${quem}, não um morador.
${restrito ? `Pelo WhatsApp, ${admin.nome} só pode: ${admin.perfil === 'portaria' ? 'registrar e entregar encomendas, preparar avisos para o grupo (com prévia e confirmação), abrir chamados e consultar a agenda' : 'registrar e entregar encomendas, ver e atualizar chamados, abrir chamados, registrar manutenções feitas e consultar a agenda'}. Outros pedidos: explique com educação que é com o síndico ou a administração.` : ''}
- ENCOMENDAS: "encomenda para 305 Julia" com foto = registrar_encomenda (apartamento 305, para Julia, com_foto=true se veio foto). Registre direto, sem pedir confirmação, e responda em uma linha: número da encomenda, apartamento e quantos moradores foram avisados. Se faltar o apartamento, pergunte só isso. Se vier só a foto sem apartamento, pergunte o apartamento.
Hoje: ${hojeParaIA()}. Use isso para entender "amanhã", "terça", "dia 25" (sempre a próxima ocorrência a partir de hoje, no ano certo). Ao confirmar, escreva a data por extenso com o dia da semana.
Condomínio em que você está trabalhando agora: ${cfg.nome_predio}.${(admin.condominios || []).length > 1 ? ` ${admin.nome} atende: ${admin.condominios.map((c) => c.nome).join(', ')}. Este pedido é do ${cfg.nome_predio} (o sistema já confirmou). Ao concluir uma ação, diga que foi no ${cfg.nome_predio}. Se no meio da conversa ele pedir algo de outro prédio, use trocar_condominio e peça para repetir o pedido citando o nome do prédio.` : ''}
Grupo dos moradores configurado: ${cfg.grupo_nome || 'nenhum'}.
${canal === 'painel' ? 'Você está na tela Assistente do painel (sistema logado): pode cadastrar moradores.' : 'Você está no WhatsApp. Cadastro de moradores NÃO é feito por aqui: se pedirem, explique que o cadastro é só no painel, na página Moradores ou na tela Assistente.'}

COMO TRABALHAR
- Respostas curtas, próprias de WhatsApp. Sem markdown pesado.
- Execute os pedidos com as ferramentas. Se faltar algo essencial (data, horário), pergunte uma coisa só.
- AVISOS: sempre use preparar_aviso, mostre a prévia exatamente como vai sair e pergunte "Posso enviar?". Se o síndico mandou uma imagem (aparece como "[o morador enviou uma foto...]") e quer postar no grupo, use com_imagem=true e diga na prévia que a imagem vai junto. Só chame enviar_aviso_confirmado depois de um sim claro para aquele aviso. Se o síndico pedir mudança, prepare um novo rascunho (se o anterior tinha imagem, use com_imagem=true de novo: a imagem é reaproveitada, não peça para mandar outra vez). Se pedirem só a imagem, sem palavras/sem texto (já na primeira mensagem, ex.: imagem com a legenda "só manda a imagem, não escreve nada", ou depois, no ajuste), use so_imagem=true e diga que vai só a imagem, sem texto nenhum. Quando confirmarem o envio, chame só enviar_aviso_confirmado (sem preparar de novo).
- Pedido de "aviso de manutenção/obra/reunião numa data": crie o evento na agenda (criar_evento) E prepare o aviso para o grupo, mostrando a prévia.
- Ao atualizar chamado, confirme o número e o novo status.
- Reclamações: nunca tente descobrir quem reclamou.
- DÚVIDAS DE MORADORES: quando o síndico escrever "resposta N: texto" (ou responder a uma pergunta que você listou), use responder_duvida. A resposta vai para o morador e o assistente aprende. Se a resposta só vale para aquele morador, use ensinar=false.
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
  const tools = FERRAMENTAS.filter((f) => (ctx.canal === 'painel' ? f.name !== 'trocar_condominio' : !SO_NO_PAINEL.includes(f.name)))
    .filter((f) => podeUsar(admin, f.name)).map((f) => ({ type: 'function', function: f }));
  let cobrado = false;
  for (let volta = 0; volta < 8; volta++) {
    const r = await openai().chat.completions.create({ model: env.OPENAI_MODEL, messages: mensagens, tools, temperature: 0.2 });
    const msg = r.choices[0].message;
    if (!msg.tool_calls?.length) {
      const final = (msg.content || '').trim();
      // Escreveu uma prévia e perguntou "posso enviar?" sem criar o rascunho: o "sim" depois não teria o que enviar
      if (!cobrado && !ctx.avisoPreparado && podeUsar(admin, 'preparar_aviso') && /posso (enviar|mandar|postar)|pr[eé]via do aviso/i.test(final)) {
        cobrado = true;
        mensagens.push({ role: 'assistant', content: final });
        mensagens.push({ role: 'system', content: 'Você mostrou uma prévia, mas NÃO chamou preparar_aviso, então nada foi preparado. Chame preparar_aviso agora com esse aviso (com_imagem=true se havia imagem; so_imagem=true se é só a imagem) e depois responda com a prévia.' });
        continue;
      }
      return final;
    }
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

// Textos dos botões (iguais aos de BOTOES em agente.js)
const BOTAO_PODE_ENVIAR = 'Sim, pode enviar o aviso.';
const BOTAO_IMAGEM = {
  so: 'Quero postar só a imagem no grupo, sem texto.',
  texto: 'Quero postar a imagem no grupo com um texto. Prepare o aviso com a imagem (título e texto curtos, a partir do que aparece nela).',
  encomenda: 'Esta imagem é de uma encomenda.',
};

// A última mensagem enviada a esta pessoa foi uma prévia de aviso (com os botões Pode enviar / Ajustar)?
async function ultimaFoiPrevia(tel) {
  const [m] = ok(await db.from('mensagens').select('texto, criado_em').eq('telefone', tel).eq('direcao', 'saida').order('criado_em', { ascending: false }).limit(1));
  return Boolean(m && /Pode enviar/.test(m.texto) && Date.now() - new Date(m.criado_em).getTime() < 2 * 3600000);
}

// Mensagem da administração pelo WhatsApp
async function atenderAdminWhatsApp(admin, tel, texto, midia = {}) {
  ok(await db.from('mensagens').insert({ telefone: tel, direcao: 'entrada', texto }));
  let resposta;
  const ctx = { admin, foto: midia.foto || null, limparMidia: midia.limpar };
  const fazAviso = podeUsar(admin, 'preparar_aviso');
  const imagem = fazAviso && ctx.foto && /\[o morador enviou uma foto/.test(texto);
  const legenda = (/Legenda: "([^"]*)"/.exec(texto) || [])[1] || '';
  const soImagem = (t) => /s[oó] ((manda|mande|envia|envie|posta|poste|coloca|coloque) )?(a |essa |esta )?(imagem|foto)|apenas (a )?(imagem|foto)|sem (texto|palavras?|legenda)|n[aã]o (escreve|escreva|coloque|p[oõ]e) (nada|texto)/i.test(t);

  // "Só a imagem" (botão, legenda ou pedido escrito): prepara o rascunho direto, sem passar pela IA
  if ((imagem && soImagem(legenda)) || (fazAviso && new RegExp(`${BOTAO_IMAGEM.so.replace('.', '\\.')}\\s*$`).test(texto))) {
    const r = await executar('preparar_aviso', { so_imagem: true }, ctx);
    resposta = r.erro
      ? `Não achei a imagem: ${r.erro}`
      : `Prévia: vai *só a imagem*, sem texto nenhum, no ${r.destino}.\n\nPosso enviar?`;
  } else if (imagem && !/encomenda|pacote|correio|sedex|entrega|mercado ?livre|amazon|shopee/i.test(legenda)) {
    // Imagem sem um pedido claro: pergunta com botões o que fazer com ela
    const botoes = [`🖼️ Só a imagem|eqimg_so`, `📝 Imagem com texto|eqimg_texto`];
    if (podeUsar(admin, 'registrar_encomenda')) botoes.push(`📦 É encomenda|eqimg_encomenda`);
    let pergunta = 'Recebi a imagem. O que faço com ela?';
    if ((admin.condominios || []).length > 1) pergunta = `🏢 *${(await getConfig()).nome_predio}*\n${pergunta}`;
    await sv.enviarBotoes(tel, pergunta, botoes, { planoB: 'Responda: "só a imagem", "com texto" ou "é encomenda".', rotulo: ROTULO[admin.perfil] || 'você, como síndico' });
    return;
  } else if (new RegExp(`${BOTAO_IMAGEM.encomenda.replace('.', '\\.')}\\s*$`).test(texto)) {
    resposta = 'Certo! Para qual apartamento (e para quem) é a encomenda?';
  } else if (/^\s*(sim|pode|pode sim|pode enviar|pode mandar|manda|envia|ok|isso)[\s.!]*$/i.test(texto) && fazAviso && (await ultimaFoiPrevia(tel))) {
    // "sim" escrito logo depois de uma prévia: mesmo caminho do botão "Pode enviar"
    texto = BOTAO_PODE_ENVIAR;
  }

  if (resposta) { /* já respondido acima */ } else if (/Sim, pode enviar o aviso\.\s*$/.test(texto)) {
    // Tocou em "Pode enviar": envia o último rascunho direto, sem passar pela IA
    try {
      const r = await executar('enviar_aviso_confirmado', {}, ctx);
      resposta = r.ok ? `✅ Aviso enviado: ${r.enviado}.` : `Não consegui enviar: ${r.erro} Se quiser, mande o pedido de novo.`;
    } catch (e) {
      console.error('[admin] enviar aviso', e.message);
      resposta = `Não consegui enviar o aviso: ${e.message}`;
    }
  } else try { resposta = await responderAdmin(admin, tel, texto, ctx); } catch (e) {
    console.error('[admin] erro', e.message);
    resposta = 'Tive um problema técnico para executar. Tente de novo ou use o painel.';
  }
  if (!resposta) return;
  // Quem atende mais de um prédio sempre vê em qual prédio a ação foi feita
  if ((admin.condominios || []).length > 1 && !resposta.startsWith('🏢')) resposta = `🏢 *${(await getConfig()).nome_predio}*\n${resposta}`;
  // Aviso preparado: botões para confirmar ou ajustar (plano B: responder sim)
  if (ctx.avisoPreparado) {
    await sv.enviarBotoes(tel, resposta, ['✅ Pode enviar|confirmar_aviso', '✏️ Quero ajustar|ajustar_aviso'], { planoB: 'Responda "sim" para enviar ou diga o que ajustar.', rotulo: ROTULO[admin.perfil] || 'você, como síndico' });
  } else await sv.enviar(tel, resposta, null, ROTULO[admin.perfil] || 'você, como síndico');
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

module.exports = { acharAdmin, escolherPredioDaEquipe, atenderAdminWhatsApp, atenderAdminPainel, historicoPainel, _teste: { FERRAMENTAS, sistema, executar, podeUsar, predioCitado, aguardandoPredio } };
