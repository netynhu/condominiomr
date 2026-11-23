// Autocadastro pelo grupo: quem está no grupo dos moradores manda "Quero me cadastrar" no privado
// e o assistente pede os dados, um de cada vez. Quem não está no grupo é orientado a procurar a administração.
// A administração confere depois no painel (Moradores > Cadastros pelo grupo).
const { db, dbGlobal, ok, getConfig, listarCondominios } = require('./db');
const { noCondominio } = require('./contexto');
const uazapi = require('./uazapi');
const sv = require('./servicos');
const { variantesTelefone, primeiroNome } = require('./util');

const PEDIU_CADASTRO = /cadastr|me registrar|quero entrar no assistente/i;
const DIA = 24 * 3600000;

// ---------- Unidades válidas ----------
// Formato livre nas Configurações: "101-110, 201-210, 1201-1208" ou, com blocos, "A/101-104, B/101-104"
function lerUnidadesValidas(texto) {
  const lista = [];
  for (const parte of String(texto || '').split(/[,;\n]+/)) {
    const t = parte.trim();
    if (!t) continue;
    const m = /^(?:([A-Za-z0-9]{1,3})\s*[/:]\s*)?(\d{1,5})(?:\s*(?:-|a|até)\s*(\d{1,5}))?$/i.exec(t);
    if (!m) continue;
    const bloco = (m[1] || '').toUpperCase();
    const ini = Number(m[2]);
    const fim = m[3] ? Number(m[3]) : ini;
    for (let n = ini; n <= fim && n - ini < 2000; n++) lista.push({ bloco, numero: String(n) });
  }
  return lista;
}

// Entende "304", "apto 304", "bloco B 304", "B-304", "304 B"
function lerApartamento(texto, validas) {
  const t = String(texto || '').toUpperCase();
  const numero = (/(\d{1,5})/.exec(t) || [])[1];
  if (!numero) return null;
  const n = String(Number(numero));
  const usaBlocos = validas.some((v) => v.bloco);
  let bloco = '';
  if (usaBlocos) {
    const semNumero = t.replace(numero, ' ').replace(/\b(BLOCO|BL|APTO|APT|AP|APARTAMENTO|TORRE|NUMERO|NÚMERO|N)\b\.?/g, ' ');
    bloco = (/\b([A-Z0-9]{1,3})\b/.exec(semNumero) || [])[1] || '';
  }
  if (!validas.length) return { bloco: '', numero: n };
  const achou = validas.find((v) => v.numero === n && (!usaBlocos || v.bloco === bloco));
  if (achou) return achou;
  // Sem bloco informado, mas o número só existe em um bloco
  if (usaBlocos && !bloco) {
    const so = validas.filter((v) => v.numero === n);
    if (so.length === 1) return so[0];
    if (so.length > 1) return { faltaBloco: true, numero: n, blocos: so.map((v) => v.bloco) };
  }
  return { invalido: true, numero: n, bloco };
}

const rotuloApto = (a) => (a.bloco ? `bloco ${a.bloco}, apto ${a.numero}` : `apto ${a.numero}`);
const ROTULO_TIPO = { proprietario: 'Proprietário', inquilino: 'Inquilino', morador: 'Mora com o titular' };

// ---------- Estado da conversa (fica em contatos_pendentes.dados) ----------
async function lerPendente(tel) {
  const r = await dbGlobal.from('contatos_pendentes').select('*').in('telefone', variantesTelefone(tel)).limit(1);
  if (r.error) throw new Error(r.error.message);
  return r.data[0] || null;
}

async function salvarPendente(tel, nome, texto, dados, anterior) {
  ok(await db.from('contatos_pendentes').upsert({
    telefone: anterior?.telefone || tel, nome_whatsapp: nome || anterior?.nome_whatsapp || null,
    ultima_mensagem: String(texto).slice(0, 300), vezes: (anterior?.vezes || 0) + 1, dados, atualizado_em: new Date().toISOString(),
  }, { onConflict: 'telefone' }));
}

async function estaNoGrupo(tel, cfg) {
  const tels = await uazapi.participantesDoGrupo(cfg.grupo_jid);
  return variantesTelefone(tel).some((v) => tels.has(v));
}

// ---------- Mensagens ----------
const botoes = (tel, texto, escolhas, planoB) => sv.enviarBotoes(tel, texto, escolhas, { planoB });

async function perguntarApto(tel, validas) {
  const usaBlocos = validas.some((v) => v.bloco);
  return sv.enviar(tel, usaBlocos
    ? 'Qual é o seu bloco e apartamento? Ex.: *A 304*'
    : 'Qual é o número do seu apartamento? Ex.: *304*');
}

async function perguntarTipo(tel) {
  return botoes(tel, 'Qual é o seu vínculo com o apartamento?',
    ['🏠 Proprietário|cad_tipo_proprietario', '🔑 Inquilino|cad_tipo_inquilino', '👨‍👩‍👧 Moro com o titular|cad_tipo_morador'],
    'Responda: proprietário, inquilino ou moro com o titular.');
}

async function perguntarVaga(tel) {
  return botoes(tel, 'Você tem vaga de garagem com número fixo? Se tiver, mande o número da vaga.',
    ['🚗 Não tenho vaga fixa|cad_sem_vaga'], 'Se não tiver vaga fixa, responda "não".');
}

async function mostrarResumo(tel, d) {
  const texto = `Confere os seus dados:\n\n👤 *${d.nome}*\n🏢 ${rotuloApto(d)}\n🔖 ${ROTULO_TIPO[d.tipo] || 'Morador'}\n🚗 ${d.vaga ? `Vaga ${d.vaga}` : 'Sem vaga fixa'}\n\nEstá tudo certo?`;
  return botoes(tel, texto, ['✅ Está certo|cad_confirmar', '✏️ Corrigir|cad_corrigir'], 'Responda "sim" para confirmar ou "corrigir" para começar de novo.');
}

// ---------- Entrada: de qual condomínio é o cadastro ----------
// Vários condomínios podem usar o mesmo número. O pedido de cadastro vale para o condomínio
// em cujo grupo a pessoa está. Retorna true se tratou a mensagem.
async function atender(tel, nomeWhatsapp, texto) {
  const pendente = await lerPendente(tel);
  // Conversa de cadastro já em andamento num condomínio
  if (pendente?.condominio_id && pendente.dados?.etapa) {
    return noCondominio(pendente.condominio_id, () => fluxo(tel, nomeWhatsapp, texto, pendente));
  }
  const escolha = (/\[\[cad_cond_([0-9a-f-]{36})\]\]/.exec(texto) || [])[1];
  if (!escolha && !PEDIU_CADASTRO.test(texto)) return false;
  const anterior = pendente?.dados || {};
  if (!escolha && anterior.fora_do_grupo && Date.now() - new Date(anterior.fora_do_grupo).getTime() < DIA) return true; // não repete a orientação

  // Condomínios com cadastro pelo grupo ligado e cujo grupo tem este número
  const candidatos = [];
  for (const c of await listarCondominios()) {
    if (escolha && c.id !== escolha) continue;
    try {
      const cfg = await noCondominio(c.id, getConfig);
      if (cfg.autocadastro === '0' || !cfg.grupo_jid) continue;
      if (await estaNoGrupo(tel, cfg)) candidatos.push({ id: c.id, nome: cfg.nome_predio });
    } catch (e) { console.error('[autocadastro] grupo', c.nome, e.message); }
  }

  if (!candidatos.length) {
    await salvarPendente(tel, nomeWhatsapp, texto, { fora_do_grupo: new Date().toISOString() }, pendente);
    await sv.enviar(tel, 'Olá! Não encontrei este número no grupo dos moradores de nenhum condomínio atendido por aqui, então não consigo fazer o seu cadastro.\n\nPor favor, procure a administração do seu condomínio para fazer o cadastro.');
    return true;
  }
  if (candidatos.length > 1) {
    await sv.enviarBotoes(tel, 'Olá! Encontrei este número no grupo de mais de um condomínio. Em qual deles você quer se cadastrar?',
      candidatos.slice(0, 3).map((c) => `🏢 ${c.nome}|cad_cond_${c.id}`), { planoB: `Responda com o nome do prédio: ${candidatos.map((c) => c.nome).join(' ou ')}.` });
    return true;
  }
  return noCondominio(candidatos[0].id, () => fluxo(tel, nomeWhatsapp, '[[cad_iniciar]]', null));
}

// ---------- Fluxo (dentro do condomínio escolhido) ----------
async function fluxo(tel, nomeWhatsapp, texto, pendente) {
  const cfg = await getConfig();
  const d = { ...(pendente?.dados || {}) };
  const botao = (/\[\[(cad_[a-z0-9_-]+)\]\]/.exec(texto) || [])[1] || '';
  // Tirar a citação: ao tocar num botão (ou responder "em cima"), o texto chega com a mensagem citada
  // na frente, e ela contém palavras como "Corrigir" que não foram escritas pela pessoa
  let corpo = String(texto);
  if (corpo.startsWith('[respondendo')) {
    const fimCitacao = corpo.lastIndexOf('"] ');
    const fimSimples = corpo.indexOf('] ');
    corpo = fimCitacao >= 0 ? corpo.slice(fimCitacao + 3) : fimSimples >= 0 ? corpo.slice(fimSimples + 2) : corpo;
  }
  // Com botão tocado, vale só o botão
  const limpo = botao ? '' : corpo.replace(/\[\[cad_[a-z0-9_-]+\]\]/g, '').trim();
  texto = botao ? `[[${botao}]]` : limpo;
  // Pediu de novo no meio do caminho, ou largou a conversa há mais de 7 dias: recomeça
  if (d.etapa && ((PEDIU_CADASTRO.test(limpo) && d.etapa !== 'consentimento') || Date.now() - new Date(d.inicio || 0).getTime() > 7 * DIA)) {
    for (const k of Object.keys(d)) delete d[k];
  }

  // Ainda não começou: só responde quem pede o cadastro
  if (!d.etapa) {
    // Quem chega aqui já foi conferido no grupo deste condomínio (função atender)
    if (!PEDIU_CADASTRO.test(texto) && botao !== 'cad_iniciar') return false;
    await salvarPendente(tel, nomeWhatsapp, texto, { etapa: 'consentimento', inicio: new Date().toISOString() }, pendente);
    await botoes(tel,
      `Olá${nomeWhatsapp ? `, ${primeiroNome(nomeWhatsapp)}` : ''}! Sou o ${cfg.nome_assistente} do ${cfg.nome_predio}. 👋\n\nPara fazer o seu cadastro, vou pedir: nome, apartamento, vínculo com o apartamento e vaga de garagem.\n\nEsses dados ficam só com a administração do condomínio e servem para atender você: chamados, avisos e dúvidas sobre o prédio. Podemos seguir?`,
      ['✅ Concordo|cad_ok', 'Agora não|cad_nao'], 'Responda "sim" para continuar.');
    return true;
  }

  const validas = lerUnidadesValidas(cfg.unidades_validas);
  const salvar = (novo) => salvarPendente(tel, nomeWhatsapp, texto, novo, pendente);

  // Desistiu no meio
  if (/^(cancelar|parar|desistir|sair)$/i.test(limpo)) {
    await db.from('contatos_pendentes').delete().eq('telefone', pendente.telefone);
    await sv.enviar(tel, 'Tudo bem, cancelei o cadastro. Quando quiser, é só mandar "Quero me cadastrar".');
    return true;
  }

  switch (d.etapa) {
    case 'consentimento': {
      if (botao === 'cad_nao' || /^(n[ãa]o|agora n[ãa]o)\s*[.!]?$/i.test(limpo)) {
        await db.from('contatos_pendentes').delete().eq('telefone', pendente.telefone);
        await sv.enviar(tel, 'Tudo bem! Quando quiser se cadastrar, é só mandar "Quero me cadastrar".');
        return true;
      }
      if (botao !== 'cad_ok' && !/^(sim|s|concordo|ok|pode|claro|bora|vamos|aceito|certo)\b/i.test(limpo)) {
        await sv.enviar(tel, 'Para continuar, toque em "Concordo" ou responda "sim". Para cancelar, responda "não".');
        return true;
      }
      await salvar({ ...d, etapa: 'nome' });
      await sv.enviar(tel, 'Ótimo! Qual é o seu nome completo?');
      return true;
    }
    case 'nome': {
      const nome = limpo.replace(/^(meu nome é|me chamo|sou o|sou a|sou)\s+/i, '').replace(/\s+/g, ' ').trim();
      if (nome.length < 3 || nome.length > 80 || /\d/.test(nome) || botao) {
        await sv.enviar(tel, 'Não entendi o nome. Pode escrever o seu nome completo?');
        return true;
      }
      await salvar({ ...d, etapa: 'apto', nome: nome.replace(/\b\p{L}/gu, (l) => l.toUpperCase()) });
      await perguntarApto(tel, validas);
      return true;
    }
    case 'apto': {
      const a = lerApartamento(limpo, validas);
      const tentativas = (d.tentativas_apto || 0) + 1;
      if (!a || a.invalido || a.faltaBloco) {
        if (tentativas >= 3) {
          await db.from('contatos_pendentes').delete().eq('telefone', pendente.telefone);
          await sv.enviar(tel, `Não consegui encontrar o seu apartamento. Para não errar o cadastro, procure a administração do condomínio (${cfg.horario_administracao}).`);
          return true;
        }
        await salvar({ ...d, tentativas_apto: tentativas });
        if (a?.faltaBloco) await sv.enviar(tel, `O apartamento ${a.numero} existe nos blocos ${a.blocos.join(', ')}. Qual é o seu bloco? Ex.: *${a.blocos[0]} ${a.numero}*`);
        else if (a?.invalido) await sv.enviar(tel, `Não encontrei o ${rotuloApto(a)} no ${cfg.nome_predio}. Confere o número e manda de novo?`);
        else await perguntarApto(tel, validas);
        return true;
      }
      await salvar({ ...d, etapa: 'tipo', bloco: a.bloco, numero: a.numero, tentativas_apto: 0 });
      await perguntarTipo(tel);
      return true;
    }
    case 'tipo': {
      let tipo = (/^cad_tipo_(proprietario|inquilino|morador)$/.exec(botao) || [])[1];
      if (!tipo) {
        if (/propriet|dono|dona/i.test(limpo)) tipo = 'proprietario';
        else if (/inquilin|alug|locat/i.test(limpo)) tipo = 'inquilino';
        else if (/moro com|titular|famil|filh|espos|marido|mulher|pai|m[ãa]e/i.test(limpo)) tipo = 'morador';
      }
      if (!tipo) { await perguntarTipo(tel); return true; }
      await salvar({ ...d, etapa: 'vaga', tipo });
      await perguntarVaga(tel);
      return true;
    }
    case 'vaga': {
      let vaga = null;
      if (botao !== 'cad_sem_vaga' && !/^n[ãa]o\b|n[ãa]o tenho|sem vaga|nenhuma/i.test(limpo)) {
        const nums = limpo.match(/\d{1,4}/g);
        if (!nums) { await perguntarVaga(tel); return true; }
        vaga = nums.slice(0, 3).join(', ');
      }
      const novo = { ...d, etapa: 'confirmar', vaga };
      await salvar(novo);
      await mostrarResumo(tel, novo);
      return true;
    }
    case 'confirmar': {
      if (botao === 'cad_corrigir' || /corrig|errad|mudar|alterar|n[ãa]o\b/i.test(limpo)) {
        await salvar({ etapa: 'nome', inicio: d.inicio });
        await sv.enviar(tel, 'Sem problema, vamos de novo. Qual é o seu nome completo?');
        return true;
      }
      if (botao !== 'cad_confirmar' && !/^(sim|s|certo|isso|ok|confirmo|est[aá] certo|correto|pode)\b/i.test(limpo)) {
        await mostrarResumo(tel, d);
        return true;
      }
      await concluir(tel, d, cfg, pendente);
      return true;
    }
    default:
      await db.from('contatos_pendentes').delete().eq('telefone', pendente.telefone);
      return false;
  }
}

async function concluir(tel, d, cfg, pendente) {
  const unidade_id = await sv.unidadeId(d.bloco, d.numero);
  const dados = { nome: d.nome, telefone: tel, tipo: d.tipo || 'morador', vaga: d.vaga || null, unidade_id, ativo: true, aceita_avisos: true, autocadastro: true, conferido: false };
  const r = await db.from('moradores').upsert(dados, { onConflict: 'condominio_id,telefone' }).select('id').single();
  if (r.error) {
    console.error('[autocadastro] gravar', r.error.message);
    await sv.enviar(tel, `Tive um problema para gravar o seu cadastro agora. Tente de novo mais tarde mandando "Quero me cadastrar", ou procure a administração (${cfg.horario_administracao}).`);
    return;
  }
  await db.from('contatos_pendentes').delete().eq('telefone', pendente.telefone);
  const bloqueiaReclamacao = cfg.autocadastro_reclamacao_conferido !== '0';
  await sv.enviar(tel,
    `Pronto, ${primeiroNome(d.nome)}! Seu cadastro está feito. ✅\n\nA partir de agora você pode falar comigo por aqui, a qualquer hora:\n• abrir chamado de manutenção (pode mandar foto ou áudio)\n• tirar dúvidas sobre as regras do prédio\n• receber os avisos da administração\n\nA administração vai conferir os seus dados nos próximos dias.${bloqueiaReclamacao ? ' Depois dessa conferência, você também poderá registrar reclamações.' : ''}`,
    r.data.id);
}

module.exports = { atender, lerUnidadesValidas, lerApartamento };
