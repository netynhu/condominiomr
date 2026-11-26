// Rotinas automáticas que rodam enquanto o servidor estiver ligado
const { db, dbGlobal, ok, getConfig, listarCondominios } = require('./db');
const { noCondominio } = require('./contexto');
const { env } = require('./config');
const uazapi = require('./uazapi');
const sv = require('./servicos');
const { agoraBR, dataExtenso, primeiroNome } = require('./util');

let proximoEnvio = 0;
let enviando = false;

function dentroDoHorario() {
  const { hora } = agoraBR();
  return hora >= env.ENVIO_HORA_INICIO && hora < env.ENVIO_HORA_FIM;
}

// Envia uma mensagem da fila por vez, com intervalo aleatório, para proteger o número.
// A fila é uma só para todos os condomínios, porque o número de WhatsApp é o mesmo.
async function processarFila() {
  if (enviando || Date.now() < proximoEnvio || !dentroDoHorario()) return;
  enviando = true;
  try {
    const [item] = ok(await dbGlobal.from('fila_envio').select('*').eq('status', 'pendente').lte('agendado_para', new Date().toISOString()).order('id').limit(1));
    if (!item) return;
    await noCondominio(item.condominio_id, () => enviarItem(item));
    const min = env.ENVIO_INTERVALO_MIN * 1000;
    const max = Math.max(min, env.ENVIO_INTERVALO_MAX * 1000);
    proximoEnvio = Date.now() + min + Math.random() * (max - min);
  } finally {
    enviando = false;
  }
}

async function enviarItem(item) {
  {
    try {
      await uazapi.enviarTexto(item.telefone, item.texto);
      await db.from('fila_envio').update({ status: 'enviado', enviado_em: new Date().toISOString() }).eq('id', item.id);
      const m = await sv.acharMorador(item.telefone);
      await db.from('mensagens').insert({ morador_id: m?.id || null, telefone: item.telefone, direcao: 'saida', texto: item.texto });
    } catch (e) {
      const tentativas = item.tentativas + 1;
      await db.from('fila_envio').update({
        tentativas, erro: e.message.slice(0, 500), status: tentativas >= 3 ? 'erro' : 'pendente',
        agendado_para: new Date(Date.now() + 5 * 60000).toISOString(),
      }).eq('id', item.id);
    }
    if (item.aviso_id) {
      const restantes = (await db.from('fila_envio').select('*', { count: 'exact', head: true }).eq('aviso_id', item.aviso_id).eq('status', 'pendente')).count;
      if (restantes === 0) await db.from('avisos').update({ status: 'enviado', enviado_em: new Date().toISOString() }).eq('id', item.aviso_id);
    }
  }
}

// Lembretes pessoais pedidos pelos moradores
async function enviarLembretes() {
  const l = ok(await db.from('lembretes').select('*, morador:moradores(id, nome, telefone, ativo)').eq('enviado', false).lte('enviar_em', new Date().toISOString()).limit(20));
  for (const r of l) {
    await db.from('lembretes').update({ enviado: true }).eq('id', r.id);
    if (r.morador?.ativo) await sv.enviar(r.morador.telefone, `Oi, ${primeiroNome(r.morador.nome)}! Passando para lembrar: ${r.texto}`, r.morador.id);
  }
}

// Aviso na véspera dos eventos da agenda
async function lembrarEventos() {
  const agora = Date.now();
  const l = ok(await db.from('eventos').select('*').eq('avisar_vespera', true).eq('lembrete_enviado', false)
    .gt('inicio', new Date(agora).toISOString()).lte('inicio', new Date(agora + 24 * 3600000).toISOString()));
  for (const ev of l) {
    await db.from('eventos').update({ lembrete_enviado: true }).eq('id', ev.id);
    // Evento cadastrado já dentro das 24h (ex.: "hoje às 22h30"): o aviso acabou de sair, o lembrete seria repetido
    if (ev.criado_em && new Date(ev.criado_em).getTime() > new Date(ev.inicio).getTime() - 24 * 3600000) continue;
    const titulo = `Lembrete: ${ev.publico.startsWith('bloco:') ? `Bloco ${ev.publico.slice(6)} · ` : ''}${ev.titulo}`;
    const texto = `🗓️ ${dataExtenso(ev.inicio)}${ev.local ? `\n📍 ${ev.local}` : ''}${ev.descricao ? `\n\n${ev.descricao}` : ''}`;
    // Lembrete vai para o grupo (uma mensagem só). Sem grupo configurado, cai na fila do privado.
    try { await sv.postarNoGrupo(titulo, texto); } catch { await sv.enfileirar(ev.publico, `${titulo}\n${texto}`, null); }
  }
}

// Manutenção preventiva: abre chamado e avisa o síndico quando o prazo se aproxima
async function verificarManutencoes() {
  const hoje = agoraBR().dataISO;
  const l = ok(await db.from('manutencoes').select('*'));
  for (const m of l) {
    const limite = new Date(new Date(m.proxima_data + 'T12:00:00-03:00').getTime() - m.antecedencia_dias * 86400000).toISOString().slice(0, 10);
    if (hoje < limite || m.alerta_enviado_para === m.proxima_data) continue;
    await db.from('manutencoes').update({ alerta_enviado_para: m.proxima_data }).eq('id', m.id);
    const ch = await sv.abrirChamado({
      titulo: `Manutenção preventiva: ${m.titulo}`, descricao: `${m.descricao || ''}\nPrazo: ${m.proxima_data.split('-').reverse().join('/')}`.trim(),
      local: 'Áreas comuns', categoria: 'manutencao', prioridade: 'alta', origem: 'manutencao_preventiva', usuarioNome: 'Rotina automática',
    });
    await sv.avisarEquipe('sindico', `Manutenção preventiva próxima do prazo: ${m.titulo} (até ${m.proxima_data.split('-').reverse().join('/')}). Chamado nº ${ch.id} aberto.`);
  }
}

// Uma vez por dia (a partir das 9h), lembra a administração das perguntas de moradores sem resposta
async function lembrarDuvidas() {
  const { hora, dataISO } = agoraBR();
  if (hora < 9 || hora >= 20) return;
  const cfg = await getConfig();
  if (cfg.duvidas_lembrete_em === dataISO) return;
  const r = await db.from('duvidas').select('id, pergunta, criado_em').eq('status', 'aberta').lte('criado_em', new Date(Date.now() - 12 * 3600000).toISOString()).order('criado_em').limit(10);
  if (r.error) return; // migração 008 ainda não rodou
  await require('./db').setConfig({ duvidas_lembrete_em: dataISO });
  if (!r.data.length) return;
  const link = env.APP_URL ? `\n\nResponda pelo painel: ${env.APP_URL}/duvidas` : '';
  const lista = r.data.map((d) => `• nº ${d.id}: ${d.pergunta.slice(0, 120)}`).join('\n');
  const titulo = r.data.length === 1 ? '1 pergunta de morador espera' : `${r.data.length} perguntas de moradores esperam`;
  const texto = `❓ *${titulo} resposta*\n\n${lista}\n\nPara responder por aqui, escreva: *resposta N:* e o texto.${link}`;
  for (const tel of await require('./duvidas').telefonesDaAdministracao()) await sv.enviar(tel, texto, null, 'síndico');
}

function seguro(nome, fn) {
  return () => fn().catch((e) => console.error(`[rotina ${nome}]`, e.message));
}

// Roda a rotina em cada condomínio, um de cada vez (o erro de um não para os outros)
function porCondominio(nome, fn) {
  return async () => {
    for (const c of await listarCondominios()) {
      await noCondominio(c.id, fn).catch((e) => console.error(`[rotina ${nome}] ${c.nome}:`, e.message));
    }
  };
}

function iniciar() {
  setInterval(seguro('fila', processarFila), 5000);
  setInterval(seguro('lembretes', porCondominio('lembretes', enviarLembretes)), 60000);
  setInterval(seguro('eventos', porCondominio('eventos', lembrarEventos)), 5 * 60000);
  setInterval(seguro('manutencao', porCondominio('manutencao', verificarManutencoes)), 60 * 60000);
  setInterval(seguro('duvidas', porCondominio('duvidas', lembrarDuvidas)), 30 * 60000);
  setInterval(seguro('encomendas', porCondominio('encomendas', () => require('./encomendas').cobrarRetiradas())), 30 * 60000);
  setInterval(seguro('reservas', porCondominio('reservas', () => require('./reservas').acompanhar())), 60000);
  setTimeout(seguro('manutencao', porCondominio('manutencao', verificarManutencoes)), 15000);
  console.log('[rotinas] fila de envio, lembretes, eventos e manutenção ativos');
}

module.exports = { iniciar };
