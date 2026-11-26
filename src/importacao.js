// Importação da convenção / regulamento em Markdown (.md). O navegador manda o texto em partes;
// no fim, o sistema monta o documento do assistente e a IA sugere horários, regras e contradições.
const { db, dbGlobal, ok, getConfig, setConfig } = require('./db');
const { env } = require('./config');
const { openai } = require('./ia');

const LIMITE_PAGINAS = 300;

async function criar(nome, paginas) {
  const n = Math.min(Math.max(1, Number(paginas) || 1), LIMITE_PAGINAS);
  return ok(await db.from('importacoes').insert({ nome: String(nome || 'documento.md').slice(0, 120), paginas: n }).select('id, paginas').single());
}

async function daVez(id) {
  return ok(await db.from('importacoes').select('*').eq('id', id).maybeSingle()); // filtrado pelo condomínio da vez
}

async function salvarPagina(id, pagina, { texto }) {
  const imp = await daVez(id);
  if (!imp) throw new Error('Importação não encontrada.');
  if (imp.status !== 'enviando') throw new Error('Esta importação já foi concluída.');
  const n = Number(pagina);
  if (!Number.isInteger(n) || n < 1 || n > imp.paginas) throw new Error('Parte inválida.');
  const conteudo = String(texto || '').trim();
  if (!conteudo) throw new Error('Parte vazia.');
  ok(await dbGlobal.from('importacao_paginas').upsert({ importacao_id: imp.id, pagina: n, texto: conteudo.slice(0, 40000) }, { onConflict: 'importacao_id,pagina' }));
  return { pagina: n, caracteres: conteudo.length };
}

// A IA lê o documento inteiro e devolve o que serve para a ficha
async function extrairSugestoes(paginas) {
  const corpo = paginas.map((p) => p.texto).join('\n\n').slice(0, 600000);
  const r = await openai().chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `Você analisa a convenção e o regulamento interno de um condomínio residencial brasileiro para configurar o assistente de WhatsApp dos moradores. Leia o documento inteiro e responda SOMENTE com um JSON com estas chaves (use "" quando o documento não disser):
{
 "nome_condominio": "", "endereco": "",
 "unidades": "faixas de apartamentos, ex.: 101-110, 201-210, 401-408 (com blocos: A/101-104)",
 "horario_obras": "dias e horários permitidos para obras/reformas, em linguagem simples",
 "horario_mudancas": "", "horario_silencio": "",
 "regra_lixo": "", "regra_encomendas": "", "regra_reservas": "como e com quanto tempo reservar salão/espaço gourmet/churrasqueira",
 "regra_lazer": "piscina, academia, brinquedoteca: horários e regras principais", "regra_outros": "pets, garagem, bicicletas, visitantes: o principal, em poucas frases",
 "contradicoes": [ { "assunto": "ex.: horário de mudanças", "convencao": "o que diz a convenção (com artigo)", "regulamento": "o que diz o regulamento (com artigo)" } ],
 "resumo": "2 frases sobre o prédio (torres, andares, áreas comuns)"
}
Regras: escreva em português simples, como o morador entende. Cite o artigo quando houver. Em "unidades", escreva só as faixas separadas por vírgula, sem texto. Só aponte contradição real entre dois trechos do documento sobre o mesmo assunto. Não invente nada que não esteja escrito.` },
      { role: 'user', content: corpo },
    ],
  });
  let sugestoes = {};
  try { sugestoes = JSON.parse(r.choices[0]?.message?.content || '{}'); } catch { sugestoes = {}; }
  // Contradições têm uma leitura só delas: numa leitura geral, com tudo junto, elas passam batido
  const extras = await extrairContradicoes(corpo).catch((e) => { console.error('[importação] contradições', e.message); return []; });
  const vistas = new Set((sugestoes.contradicoes || []).map((c) => String(c.assunto).toLowerCase()));
  sugestoes.contradicoes = [...(sugestoes.contradicoes || []), ...extras.filter((c) => !vistas.has(String(c.assunto).toLowerCase()))];
  sugestoes.unidades = normalizarUnidades(sugestoes.unidades);
  return sugestoes;
}

// Segunda leitura, só para achar contradições entre a convenção e o regulamento (ou dentro do mesmo documento)
async function extrairContradicoes(corpo) {
  // Comparar trechos exige um modelo maior (roda uma vez por documento)
  const modelo = env.OPENAI_MODEL_FORTE;
  const r = await openai().chat.completions.create({
    model: modelo,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `Você revisa a convenção e o regulamento interno de um condomínio. Procure CONTRADIÇÕES: dois trechos do documento que dão regras diferentes para o mesmo assunto (ex.: a convenção proíbe transportar móveis das 8h às 20h e o regulamento permite mudanças das 8h às 17h).
Compare com atenção, um por um, estes assuntos: mudanças e transporte de móveis; obras e reformas (dias e horários); horário de silêncio e barulho; animais; uso do salão de festas/espaço gourmet (horários, antecedência da reserva); piscina; garagem e vagas; multas (valores e reincidência); lixo; locação de vagas; atividades comerciais nos apartamentos.
É CONTRADIÇÃO só quando seguir um trecho faz desrespeitar o outro: horários diferentes para a mesma coisa, um proíbe e o outro permite, valores diferentes.
NÃO é contradição: os dois dizerem a mesma coisa; um detalhar ou completar o outro; um falar de área comum e o outro de apartamento; regras parecidas sem conflito prático.
Responda SOMENTE com JSON: { "contradicoes": [ { "assunto": "", "convencao": "o que diz o primeiro trecho, com o artigo", "regulamento": "o que diz o segundo trecho, com o artigo", "por_que_conflita": "em uma frase, o que o morador faria de diferente conforme o trecho que seguir" } ] }
Se não houver contradição real, devolva a lista vazia.` },
      { role: 'user', content: corpo },
    ],
  });
  let lista = [];
  try { lista = JSON.parse(r.choices[0]?.message?.content || '{}').contradicoes || []; } catch { lista = []; }
  // 1º filtro: descarta o que a própria explicação diz que não conflita, ou onde falta um dos lados
  const NEGA = /n[ãa]o h[áa] (contradi|trecho|conflito)|sem contradi|s[ãa]o (id[êe]nticos|equivalentes|iguais)|complementa|mesm[ao]s? (regras|disposi|termos|valores)|n[ãa]o (traz|menciona|trata)/i;
  lista = lista.filter((c) => String(c.por_que_conflita || '').trim().length > 10 && !NEGA.test(`${c.por_que_conflita} ${c.regulamento} ${c.convencao}`));
  if (!lista.length) return [];
  // 2º filtro: checagem curta só com os pares de trechos
  const v = await openai().chat.completions.create({
    model: modelo,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'Para cada item, decida se os dois trechos são uma CONTRADIÇÃO REAL: o morador não consegue obedecer aos dois ao mesmo tempo (horários diferentes para a mesma atividade, um permite e o outro proíbe a mesma coisa, valores diferentes). Se um só detalha, completa, é mais amplo ou fala de outro lugar (área comum x apartamento), NÃO é contradição. Responda só JSON: {"reais": [índices dos itens que são contradição real]}' },
      { role: 'user', content: JSON.stringify(lista.map((c, i) => ({ indice: i, assunto: c.assunto, trecho1: c.convencao, trecho2: c.regulamento }))) },
    ],
  });
  let reais = [];
  try { reais = JSON.parse(v.choices[0]?.message?.content || '{}').reais || []; } catch { reais = []; }
  return lista.filter((_, i) => reais.includes(i)).map(({ assunto, convencao, regulamento }) => ({ assunto, convencao, regulamento }));
}

// "1º pavimento: 101-110; 2º: 201-210" -> "101-110, 201-210" (o formato que o cadastro dos moradores entende)
function normalizarUnidades(texto) {
  const faixas = [...String(texto || '').matchAll(/(?:\b([A-Z])\s*\/\s*)?\b(\d{2,5})\s*(?:-|–|a|até)\s*(\d{2,5})\b/gi)]
    .map(([, bloco, ini, fim]) => `${bloco ? bloco.toUpperCase() + '/' : ''}${ini}-${fim}`);
  return faixas.length ? [...new Set(faixas)].join(', ') : String(texto || '');
}

// Conclui: monta o documento do assistente e as sugestões (roda em segundo plano; a página acompanha pelo status)
async function concluir(id) {
  const imp = await daVez(id);
  if (!imp) throw new Error('Importação não encontrada.');
  ok(await db.from('importacoes').update({ status: 'processando' }).eq('id', imp.id));
  try {
    const paginas = ok(await dbGlobal.from('importacao_paginas').select('pagina, texto').eq('importacao_id', imp.id).order('pagina'));
    if (paginas.length < imp.paginas) throw new Error('O arquivo não chegou inteiro. Envie de novo.');
    const sugestoes = await extrairSugestoes(paginas);
    const titulo = imp.nome.replace(/\.(md|markdown|txt)$/i, '').replace(/[_-]+/g, ' ').trim() || 'Convenção e regulamento';
    const conteudo = `${titulo}\n\n${paginas.map((p) => p.texto).join('\n\n')}`;
    const doc = ok(await db.from('documentos').insert({ titulo, conteudo, ativo: true }).select('id').single());
    ok(await db.from('importacoes').update({ status: 'pronto', sugestoes, documento_id: doc.id, erro: null }).eq('id', imp.id));
    // A ficha passa a mostrar as sugestões nos campos vazios e as contradições para resolver
    await setConfig({ ficha_sugestoes: JSON.stringify(sugestoes) });
    return { documento: doc.id, sugestoes };
  } catch (e) {
    console.error('[importação]', e.message);
    await db.from('importacoes').update({ status: 'erro', erro: e.message.slice(0, 300) }).eq('id', imp.id);
    throw e;
  }
}

async function situacao(id) {
  const imp = await daVez(id);
  if (!imp) return null;
  const lidas = (await dbGlobal.from('importacao_paginas').select('pagina', { count: 'exact', head: true }).eq('importacao_id', imp.id)).count || 0;
  return { status: imp.status, paginas: imp.paginas, lidas, erro: imp.erro, contradicoes: (imp.sugestoes?.contradicoes || []).length };
}

// Sugestões guardadas para a ficha
async function sugestoesDaFicha() {
  try { return JSON.parse((await getConfig()).ficha_sugestoes || '{}'); } catch { return {}; }
}

module.exports = { criar, salvarPagina, concluir, situacao, sugestoesDaFicha, LIMITE_PAGINAS, _teste: { extrairSugestoes } };
