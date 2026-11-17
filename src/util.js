const TZ = 'America/Sao_Paulo';

const soDigitos = (s) => String(s || '').replace(/\D/g, '');

// Normaliza telefone brasileiro para o formato com DDI: 5511999998888
function normalizarTelefone(s) {
  let d = soDigitos(s);
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}

// O WhatsApp às vezes entrega números brasileiros sem o 9 extra.
// Gera as duas formas para encontrar o morador de qualquer jeito.
function variantesTelefone(tel) {
  const d = normalizarTelefone(tel);
  const v = new Set([d]);
  if (d.startsWith('55')) {
    if (d.length === 13 && d[4] === '9') v.add(d.slice(0, 4) + d.slice(5));
    if (d.length === 12) v.add(d.slice(0, 4) + '9' + d.slice(4));
  }
  return [...v];
}

// Extrai o número de um JID do WhatsApp (5511999998888@s.whatsapp.net ou 5511...:12@s.whatsapp.net)
function telefoneDoJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  if (!jid.includes('@s.whatsapp.net') && !jid.includes('@c.us')) return '';
  return soDigitos(jid.split('@')[0].split(':')[0]);
}

function formatarTelefone(t) {
  const d = soDigitos(t);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const n = d.slice(4);
    return `(${ddd}) ${n.slice(0, n.length - 4)}-${n.slice(-4)}`;
  }
  return d;
}

const fmt = (iso, opts) => (iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...opts }).format(new Date(iso)) : '');
const dataHora = (iso) => fmt(iso, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const data = (iso) => fmt(iso, { day: '2-digit', month: '2-digit', year: 'numeric' });
const dataExtenso = (iso) => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

// Data/hora no fuso de Brasília: partes para comparar horário
function agoraBR() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return { dataISO: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) % 24, minuto: Number(p.minute) };
}

// <input type="datetime-local"> -> ISO com fuso de Brasília (sem horário de verão desde 2019)
function localParaISO(s) {
  if (!s) return null;
  const base = s.length === 16 ? s + ':00' : s;
  return new Date(base + '-03:00').toISOString();
}
function isoParaLocal(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() - 3 * 3600 * 1000);
  return d.toISOString().slice(0, 16);
}

function rotuloUnidade(u) {
  if (!u) return 'sem unidade';
  return u.bloco ? `Bloco ${u.bloco}, apto ${u.numero}` : `Apto ${u.numero}`;
}

const primeiroNome = (n) => String(n || '').trim().split(/\s+/)[0] || '';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  soDigitos, normalizarTelefone, variantesTelefone, telefoneDoJid, formatarTelefone,
  dataHora, data, dataExtenso, agoraBR, localParaISO, isoParaLocal, rotuloUnidade, primeiroNome, esperar, TZ,
};
