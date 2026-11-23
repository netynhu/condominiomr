// Reservas de espaços com checklist de entrada (check-in) e saída (check-out).
// A administração cadastra a reserva. No início, o morador recebe no WhatsApp o link do check-in;
// no fim, o do check-out. O sistema compara os dois e avisa a administração se algo piorou.
const crypto = require('crypto');
const { db, dbGlobal, ok, getConfig } = require('./db');
const { env } = require('./config');
const sv = require('./servicos');
const { dataExtenso, dataHora, primeiroNome, agoraBR } = require('./util');

const ETAPA = { entrada: 'check-in', saida: 'check-out' };
const linkDa = (r, etapa) => `${env.APP_URL}/r/${r.token}/${etapa}`;

// Hora curta: "18:00"
const hora = (iso) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

async function carregar(id) {
  return ok(await db.from('reservas').select('*, espaco:espacos(nome, itens), morador:moradores(id, nome, telefone, ativo)').eq('id', id).maybeSingle());
}

async function criar({ espacoId, moradorId, inicio, fim, observacao, por }) {
  if (!(new Date(fim) > new Date(inicio))) throw new Error('O fim da reserva precisa ser depois do início.');
  const r = ok(await db.from('reservas').insert({
    espaco_id: espacoId, morador_id: moradorId, inicio, fim, observacao: observacao || null, criada_por: por || null,
    token: crypto.randomBytes(20).toString('hex'),
  }).select('id').single());
  const res = await carregar(r.id);
  // Confirmação ao morador
  if (res.morador?.ativo) {
    const cfg = await getConfig();
    await sv.enviar(res.morador.telefone,
      `📅 Olá, ${primeiroNome(res.morador.nome)}! Sua reserva do *${res.espaco.nome}* está confirmada para ${dataExtenso(res.inicio)}, até as ${hora(res.fim)}.\n\nNo horário de início, eu mando aqui o link do *check-in*: uma lista rápida para conferir como o espaço está. No fim, mando o do *check-out*. Isso protege você e o condomínio.${res.observacao ? `\n\nObservação da administração: ${res.observacao}` : ''}\n\n_${cfg.nome_predio} · Administração_`,
      res.morador.id);
  }
  return res;
}

async function cancelar(id, por) {
  const r = await carregar(id);
  if (!r || ['concluida', 'cancelada'].includes(r.status)) return r;
  ok(await db.from('reservas').update({ status: 'cancelada', observacao: [r.observacao, `Cancelada por ${por}`].filter(Boolean).join(' · ') }).eq('id', id));
  if (r.morador?.ativo) await sv.enviar(r.morador.telefone, `Olá, ${primeiroNome(r.morador.nome)}. A sua reserva do ${r.espaco.nome} de ${dataExtenso(r.inicio)} foi cancelada pela administração.`, r.morador.id);
  return r;
}

// Manda (ou lembra) o link do check-in ou do check-out
async function enviarLink(r, etapa, { lembrete = false } = {}) {
  if (!r.morador?.ativo) return false;
  const nome = primeiroNome(r.morador.nome);
  const texto = etapa === 'entrada'
    ? (lembrete
      ? `⏰ ${nome}, você ainda não fez o check-in do ${r.espaco.nome}. Leva 1 minuto e protege você se algo já estiver com problema.`
      : `🔑 ${nome}, sua reserva do ${r.espaco.nome} começou. Antes de usar, faça o *check-in*: confira os itens e tire as fotos pedidas. Se algo já estiver com problema, é só marcar.`)
    : (lembrete
      ? `⏰ ${nome}, falta o check-out do ${r.espaco.nome}. Sem ele, a administração não consegue confirmar que o espaço foi entregue em ordem.`
      : `✅ ${nome}, sua reserva do ${r.espaco.nome} terminou. Faça o *check-out*: confira os mesmos itens e tire as fotos pedidas.`);
  return sv.enviarBotoes(r.morador.telefone, texto, [`📋 Fazer o ${ETAPA[etapa]}|${linkDa(r, etapa)}`],
    { rodape: 'Checklist do espaço', planoB: `👉 ${linkDa(r, etapa)}`, moradorId: r.morador.id });
}

// Grava o checklist enviado pela página. respostas: [{ ok, obs, foto (id) }] na ordem dos itens do espaço.
async function salvarChecklist(r, etapa, respostas) {
  const itens = r.espaco.itens || [];
  const lista = itens.map((it, i) => ({ texto: it.texto, ok: respostas[i]?.ok !== false, obs: (respostas[i]?.obs || '').slice(0, 300), foto: respostas[i]?.foto || null }));
  const agora = new Date().toISOString();
  const patch = etapa === 'entrada'
    ? { entrada: lista, entrada_em: agora, status: 'em_uso' }
    : { saida: lista, saida_em: agora, status: 'concluida' };
  // O que piorou: estava OK na entrada e não está na saída (ou piorou sem entrada feita)
  let problemas = '';
  if (etapa === 'saida') {
    const antes = r.entrada || [];
    const piorou = lista.filter((it, i) => !it.ok && (antes[i] ? antes[i].ok : true));
    problemas = piorou.map((it) => `• ${it.texto}${it.obs ? `: ${it.obs}` : ''}`).join('\n');
    patch.problemas = problemas || null;
  }
  ok(await db.from('reservas').update(patch).eq('id', r.id));

  const quem = `${r.morador?.nome || 'Morador'}`;
  const link = `${env.APP_URL}/reservas/${r.id}`;
  if (etapa === 'entrada') {
    const ruins = lista.filter((it) => !it.ok);
    if (ruins.length) {
      await avisarAdministracao(`⚠️ *Check-in do ${r.espaco.nome}* (${quem}): o espaço foi recebido com problema.\n${ruins.map((it) => `• ${it.texto}${it.obs ? `: ${it.obs}` : ''}`).join('\n')}\n\nFica registrado que não foi esse morador. Detalhes e fotos: ${link}`);
    }
  } else if (problemas) {
    await avisarAdministracao(`🚨 *Check-out do ${r.espaco.nome}* (${quem}): algo piorou durante a reserva.\n${problemas}\n\nCompare as fotos de antes e depois: ${link}`);
  }
  return { lista, problemas };
}

async function avisarAdministracao(texto) {
  for (const tel of await require('./duvidas').telefonesDaAdministracao()) await sv.enviar(tel, texto, null, 'síndico');
}

// Rotina (a cada 5 min, por condomínio): manda os links na hora certa, lembra e avisa a administração
async function acompanhar() {
  const agora = Date.now();
  const minutos = (iso) => (agora - new Date(iso).getTime()) / 60000;
  const ativas = ok(await db.from('reservas').select('*, espaco:espacos(nome, itens), morador:moradores(id, nome, telefone, ativo)')
    .in('status', ['agendada', 'em_uso']).lte('inicio', new Date(agora).toISOString()).order('inicio').limit(100));
  const { hora: h } = agoraBR();
  for (const r of ativas) {
    const set = (patch) => db.from('reservas').update(patch).eq('id', r.id).then(ok);
    // Check-in: link no início; lembrete 30 min depois; administração avisada depois de 1h sem check-in
    if (!r.entrada_em && minutos(r.fim) < 0) {
      if (!r.entrada_link_em) { await enviarLink(r, 'entrada'); await set({ entrada_link_em: new Date().toISOString() }); }
      else if (!r.entrada_lembrete_em && minutos(r.entrada_link_em) >= 30) { await enviarLink(r, 'entrada', { lembrete: true }); await set({ entrada_lembrete_em: new Date().toISOString() }); }
      else if (!r.administracao_avisada_em && r.entrada_lembrete_em && minutos(r.entrada_link_em) >= 60) {
        await avisarAdministracao(`⏰ ${r.morador?.nome || 'O morador'} não fez o check-in do ${r.espaco.nome} (reserva das ${hora(r.inicio)}). Sem o check-in, não há registro de como o espaço foi entregue.`);
        await set({ administracao_avisada_em: new Date().toISOString() });
      }
      continue;
    }
    // Check-out: link no fim; lembrete 30 min depois; administração avisada depois de 2h (só de dia)
    if (minutos(r.fim) >= 0 && !r.saida_em) {
      if (!r.saida_link_em) { await enviarLink(r, 'saida'); await set({ saida_link_em: new Date().toISOString() }); }
      else if (!r.saida_lembrete_em && minutos(r.saida_link_em) >= 30 && h >= 8 && h < 22) { await enviarLink(r, 'saida', { lembrete: true }); await set({ saida_lembrete_em: new Date().toISOString() }); }
      else if (r.saida_lembrete_em && minutos(r.saida_link_em) >= 120 && h >= 8 && h < 21 && !(r.administracao_avisada_em && r.administracao_avisada_em > r.fim)) {
        await avisarAdministracao(`⏰ ${r.morador?.nome || 'O morador'} não fez o check-out do ${r.espaco.nome} (reserva até ${hora(r.fim)} de ${dataHora(r.fim).slice(0, 5)}). Vale conferir o espaço.`);
        await set({ administracao_avisada_em: new Date().toISOString() });
      }
    }
  }
}

// Página pública do checklist: acha a reserva pelo token (em qualquer condomínio)
async function porToken(token) {
  if (!/^[0-9a-f]{40}$/.test(String(token || ''))) return null;
  const r = await dbGlobal.from('reservas').select('id, condominio_id').eq('token', token).maybeSingle();
  return r.error ? null : r.data;
}

module.exports = { criar, cancelar, carregar, enviarLink, salvarChecklist, acompanhar, porToken, hora, ETAPA };
