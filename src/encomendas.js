// Encomendas: a portaria registra, o WhatsApp avisa todos os moradores do apartamento e cobra a retirada
// (1 dia, 3 dias, depois a cada 2 dias) até alguém tocar em "Já retirei" ou a portaria marcar como entregue.
// Passou do prazo (Ajustes, padrão 7 dias), a administração é avisada uma vez.
const { db, ok, getConfig } = require('./db');
const sv = require('./servicos');
const uazapi = require('./uazapi');
const { lerFoto } = require('./fotos');
const { agoraBR, dataHora, primeiroNome, rotuloUnidade } = require('./util');

const TIPOS = { pacote: 'pacote', envelope: 'envelope', comida: 'comida (retire logo)', volumoso: 'volume grande', outro: 'encomenda' };
const DIA = 24 * 3600000;

async function moradoresDaUnidade(unidadeId) {
  if (!unidadeId) return [];
  return ok(await db.from('moradores').select('id, nome, telefone').eq('unidade_id', unidadeId).eq('ativo', true));
}

// "pacote · Mercado Livre · caixa grande"
const detalhe = (e) => [TIPOS[e.tipo] || 'encomenda', e.remetente, e.observacao].filter(Boolean).join(' · ');

// Avisa os moradores do apartamento: foto (se houver) e botão "Já retirei"
async function avisarMoradores(e, { lembrete = false } = {}) {
  const unidade = e.unidade_id ? ok(await db.from('unidades').select('bloco, numero').eq('id', e.unidade_id).maybeSingle()) : null;
  const moradores = await moradoresDaUnidade(e.unidade_id);
  const cfg = await getConfig();
  let buffer = null;
  if (e.foto) { try { buffer = (await lerFoto(e.foto)).buffer; } catch { /* segue sem foto */ } }
  let avisados = 0;
  for (const m of moradores) {
    const nome = primeiroNome(m.nome);
    const corpo = lembrete
      ? `📦 Oi, ${nome}! Lembrete: tem uma encomenda sua esperando na portaria do ${cfg.nome_predio}, desde ${dataHora(e.recebida_em)}.
(${detalhe(e)})`
      : `📦 Oi, ${nome}! Chegou uma encomenda para você na portaria do ${cfg.nome_predio}.
(${detalhe(e)})

Pode retirar quando quiser.`;
    try {
      if (buffer) {
        await uazapi.enviarFoto(m.telefone, buffer, corpo);
        await db.from('mensagens').insert({ morador_id: m.id, telefone: m.telefone, direcao: 'saida', texto: `[foto da encomenda] ${corpo}` });
        const ok1 = await sv.enviarBotoes(m.telefone, 'Quando retirar, toque abaixo para eu parar de avisar.', [`✅ Já retirei|enc_retirei:${e.id}`],
          { planoB: 'Quando retirar, responda "peguei" para eu parar de avisar.', moradorId: m.id });
        if (ok1) avisados++;
      } else if (await sv.enviarBotoes(m.telefone, `${corpo}\n\nQuando retirar, toque abaixo para eu parar de avisar.`, [`✅ Já retirei|enc_retirei:${e.id}`],
        { planoB: 'Quando retirar, responda "peguei" para eu parar de avisar.', moradorId: m.id })) avisados++;
    } catch (err) { console.error('[encomenda] aviso', m.telefone, err.message); }
  }
  ok(await db.from('encomendas').update({ avisos: (e.avisos || 0) + 1, ultimo_aviso_em: new Date().toISOString() }).eq('id', e.id));
  return { avisados, moradores: moradores.length };
}

// A portaria registra uma encomenda e os moradores são avisados na hora
async function registrar({ unidadeId, remetente, tipo, observacao, foto, por }) {
  const e = ok(await db.from('encomendas').insert({
    unidade_id: unidadeId, remetente: (remetente || '').trim() || null, tipo: TIPOS[tipo] ? tipo : 'pacote',
    observacao: (observacao || '').trim().slice(0, 200) || null, foto: foto || null, recebida_por: por || null,
  }).select().single());
  const r = await avisarMoradores(e);
  return { encomenda: e, ...r };
}

// Alguém retirou: o morador (botão ou conversa) ou a portaria. Para os avisos.
async function retirar(id, { morador = null, por = null, devolvida = false } = {}) {
  const e = ok(await db.from('encomendas').select('*').eq('id', id).maybeSingle());
  if (!e) return { ok: false, msg: 'Não encontrei essa encomenda.' };
  if (morador && e.unidade_id !== morador.unidade_id) return { ok: false, msg: 'Não encontrei essa encomenda no seu apartamento.' };
  if (e.status !== 'aguardando') return { ok: true, jaFeito: true, msg: 'Essa encomenda já estava marcada como retirada. Obrigado!' };
  ok(await db.from('encomendas').update({
    status: devolvida ? 'devolvida' : 'retirada', retirada_em: new Date().toISOString(),
    retirada_por: morador ? morador.nome : (por || 'Portaria'),
  }).eq('id', id));
  return { ok: true, msg: `Obrigado, ${primeiroNome(morador?.nome || '')}! Marquei como retirada e não vou mais avisar sobre essa encomenda. ✅`.replace(', !', '!') };
}

// Encomendas do apartamento do morador que ainda aguardam retirada
async function doMorador(morador) {
  if (!morador.unidade_id) return [];
  return ok(await db.from('encomendas').select('id, remetente, tipo, observacao, recebida_em').eq('unidade_id', morador.unidade_id).eq('status', 'aguardando').order('recebida_em'));
}

// Rotina (a cada 30 min, por condomínio): lembretes ao morador e aviso à administração
async function cobrarRetiradas() {
  const { hora } = agoraBR();
  if (hora < 9 || hora >= 20) return;
  const cfg = await getConfig();
  const prazo = Math.max(1, Number(cfg.encomenda_prazo_dias) || 7);
  const abertas = ok(await db.from('encomendas').select('*').eq('status', 'aguardando').order('recebida_em').limit(200));
  const agora = Date.now();
  for (const e of abertas) {
    const desdeAviso = agora - new Date(e.ultimo_aviso_em || e.recebida_em).getTime();
    // 1 dia depois da chegada, depois 2 dias depois, e a cada 2 dias (limite de 8 avisos)
    const espera = e.avisos <= 1 ? 1 * DIA : 2 * DIA;
    if (e.avisos < 8 && desdeAviso >= espera) await avisarMoradores(e, { lembrete: true });
  }
  // Passou do prazo: a administração recebe a lista uma vez por encomenda
  const atrasadas = abertas.filter((e) => !e.sindico_avisado_em && agora - new Date(e.recebida_em).getTime() >= prazo * DIA);
  if (!atrasadas.length) return;
  const unidades = ok(await db.from('unidades').select('id, bloco, numero'));
  const lista = atrasadas.slice(0, 15).map((e) => {
    const u = unidades.find((x) => x.id === e.unidade_id);
    return `• ${u ? rotuloUnidade(u) : 'unidade ?'}: ${e.remetente || TIPOS[e.tipo]} (desde ${dataHora(e.recebida_em).slice(0, 5)})`;
  }).join('\n');
  const texto = `📦 *${atrasadas.length === 1 ? '1 encomenda parada' : `${atrasadas.length} encomendas paradas`} na portaria há mais de ${prazo} dias*\n\n${lista}\n\nOs moradores já foram avisados várias vezes. Vale falar com eles ou devolver ao remetente.`;
  for (const tel of await require('./duvidas').telefonesDaAdministracao()) await sv.enviar(tel, texto, null, 'síndico');
  for (const e of atrasadas) await db.from('encomendas').update({ sindico_avisado_em: new Date().toISOString() }).eq('id', e.id);
}

module.exports = { registrar, retirar, doMorador, cobrarRetiradas, avisarMoradores, TIPOS };
