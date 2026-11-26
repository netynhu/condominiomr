// Ficha de implantação: o síndico ou a administradora preenche por um link (sem senha), em partes.
// O que é preenchido já vai para o sistema (ajustes, administradora, horários, regras, manutenções, espaços).
// A lista "Pronto para ativar" mostra, pelo estado real do sistema, o que ainda falta.
const crypto = require('crypto');
const { db, dbGlobal, ok, getConfig, setConfig, contar } = require('./db');
const { condominioAtual } = require('./contexto');
const sv = require('./servicos');

const PARTES = [
  { id: 'predio', titulo: 'Prédio' },
  { id: 'documentos', titulo: 'Convenção e regulamento' },
  { id: 'equipe', titulo: 'Equipe' },
  { id: 'administradora', titulo: 'Administração e administradora' },
  { id: 'horarios', titulo: 'Horários permitidos' },
  { id: 'dia_a_dia', titulo: 'Regras do dia a dia' },
  { id: 'manutencoes', titulo: 'Últimas manutenções' },
  { id: 'espacos', titulo: 'Espaços reserváveis (opcional)' },
  { id: 'grupo', titulo: 'Grupo dos moradores' },
];

// Manutenções que a ficha já sugere (o síndico completa a data e a empresa)
const MANUTENCOES_SUGERIDAS = ["Limpeza da caixa d'água", 'Manutenção do elevador', 'Recarga dos extintores', 'Dedetização', 'Manutenção das bombas', 'Manutenção do portão', 'AVCB (vistoria dos bombeiros)', 'Para-raios'];
const MARCA = 'Ficha de implantação'; // identifica o que a ficha criou, para poder refazer sem duplicar

const json = (v, padrao) => { try { return v ? JSON.parse(v) : padrao; } catch { return padrao; } };
const lista = (v) => [].concat(v ?? []);

// Link da ficha (cria na primeira vez)
async function token() {
  const cfg = await getConfig();
  if (cfg.ficha_token) return cfg.ficha_token;
  const t = crypto.randomBytes(18).toString('hex');
  await setConfig({ ficha_token: t, ficha_criada_em: new Date().toISOString() });
  return t;
}

// Acha o condomínio pelo link da ficha
async function condominioDoToken(t) {
  if (!/^[0-9a-f]{36}$/.test(String(t || ''))) return null;
  const r = await dbGlobal.from('config').select('condominio_id').eq('chave', 'ficha_token').eq('valor', t).limit(1);
  return r.error ? null : r.data[0]?.condominio_id || null;
}

async function partesFeitas() {
  return json((await getConfig()).ficha_partes, []);
}

async function marcarFeita(parte) {
  const feitas = new Set(await partesFeitas());
  feitas.add(parte);
  await setConfig({ ficha_partes: JSON.stringify([...feitas]), ficha_atualizada_em: new Date().toISOString() });
}

// Grava uma parte da ficha no sistema
async function salvarParte(parte, b) {
  const t = (v) => String(v ?? '').trim();
  switch (parte) {
    case 'predio':
      await setConfig({ nome_predio: t(b.nome_predio), endereco: t(b.endereco), unidades_validas: t(b.unidades_validas).replace(/\s*\n\s*/g, ', ') });
      break;
    case 'documentos':
      await setConfig({ ficha_doc_link: t(b.doc_link), ficha_doc_por_email: b.doc_por_email === 'on' ? '1' : '0' });
      break;
    case 'equipe': {
      // Guarda a equipe informada; os acessos são criados no painel (Implantação), com a senha definida lá
      const nomes = lista(b.eq_nome);
      const equipe = nomes.map((n, i) => ({ nome: t(n), perfil: t(lista(b.eq_perfil)[i]), email: t(lista(b.eq_email)[i]).toLowerCase(), whatsapp: t(lista(b.eq_whatsapp)[i]), horario: t(lista(b.eq_horario)[i]) }))
        .filter((p) => p.nome && ['sindico', 'admin', 'zelador', 'portaria'].includes(p.perfil));
      await setConfig({ ficha_equipe: JSON.stringify(equipe) });
      break;
    }
    case 'administradora':
      await setConfig({
        horario_administracao: t(b.horario_administracao), adm_nome: t(b.adm_nome), adm_contato: t(b.adm_contato), adm_portal: t(b.adm_portal),
        adm_whatsapp: t(b.adm_whatsapp), adm_telefone: t(b.adm_telefone), adm_email: t(b.adm_email), adm_horario: t(b.adm_horario),
      });
      break;
    case 'horarios':
      await setConfig({ horario_obras: t(b.horario_obras), horario_mudancas: t(b.horario_mudancas), horario_silencio: t(b.horario_silencio) });
      break;
    case 'dia_a_dia':
      await setConfig({ regra_lixo: t(b.regra_lixo), regra_encomendas: t(b.regra_encomendas), regra_reservas: t(b.regra_reservas), regra_lazer: t(b.regra_lazer), regra_outros: t(b.regra_outros) });
      break;
    case 'manutencoes':
      await salvarManutencoes(b);
      break;
    case 'espacos':
      await salvarEspacos(b);
      break;
    case 'grupo':
      await setConfig({ grupo_convite: t(b.grupo_convite), ficha_grupo_ok: b.grupo_ok === 'on' ? '1' : '0' });
      break;
    default:
      throw new Error('Parte desconhecida');
  }
  await marcarFeita(parte);
}

// Manutenções: histórico (última vez) e programação (próxima), refazendo o que a ficha criou antes
async function salvarManutencoes(b) {
  const itens = lista(b.mn_item).map((item, i) => ({
    item: String(item || '').trim(), data: lista(b.mn_data)[i] || '', empresa: String(lista(b.mn_empresa)[i] || '').trim(),
    meses: Number(lista(b.mn_meses)[i]) || 0,
  })).filter((x) => x.item && (x.data || x.meses));
  await setConfig({ ficha_manutencoes: JSON.stringify(itens) });
  await db.from('manutencao_registros').delete().eq('registrada_por', MARCA);
  await db.from('manutencoes').delete().eq('descricao', MARCA);
  for (const x of itens) {
    let manutencaoId = null;
    if (x.meses && x.data) {
      const proxima = new Date(new Date(`${x.data}T12:00:00-03:00`).getTime() + x.meses * 30.44 * 86400000).toISOString().slice(0, 10);
      manutencaoId = ok(await db.from('manutencoes').insert({ titulo: x.item, descricao: MARCA, proxima_data: proxima, periodicidade_dias: Math.round(x.meses * 30.44), antecedencia_dias: 15 }).select('id').single()).id;
    }
    if (x.data) {
      const r = await db.from('manutencao_registros').insert({ manutencao_id: manutencaoId, titulo: x.item, feita_em: x.data, empresa: x.empresa || null, registrada_por: MARCA });
      if (r.error) console.error('[ficha] manutenção', r.error.message); // migração 013 ainda não rodou
    }
  }
}

// Espaços reserváveis com o checklist (um item por linha; "(foto)" no fim pede foto)
async function salvarEspacos(b) {
  const espacos = lista(b.es_nome).map((nome, i) => ({
    nome: String(nome || '').trim(),
    itens: String(lista(b.es_itens)[i] || '').split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => ({ texto: l.replace(/\(foto\)\s*$/i, '').trim(), foto: /\(foto\)\s*$/i.test(l) })),
  })).filter((e) => e.nome && e.itens.length);
  for (const e of espacos) {
    const r = await db.from('espacos').select('id').eq('nome', e.nome).eq('ativo', true).limit(1);
    if (r.error) { console.error('[ficha] espaços', r.error.message); return; } // migração 012 ainda não rodou
    if (r.data[0]) ok(await db.from('espacos').update({ itens: e.itens }).eq('id', r.data[0].id));
    else ok(await db.from('espacos').insert({ nome: e.nome, itens: e.itens }));
  }
}

// Cria os acessos da equipe informada na ficha (quem ainda não existe). Senha aleatória: definida depois no painel.
async function criarEquipeDaFicha() {
  const bcrypt = require('bcryptjs');
  const { normalizarTelefone } = require('./util');
  const equipe = json((await getConfig()).ficha_equipe, []);
  const criados = [];
  for (const p of equipe) {
    const telefone = normalizarTelefone(p.whatsapp) || null;
    const email = p.email || `${p.perfil}.${crypto.randomBytes(4).toString('hex')}@sem-email.local`;
    let [u] = ok(await dbGlobal.from('usuarios').select('id, dono').or(`email.eq.${email}${telefone ? `,telefone.eq.${telefone}` : ''}`).limit(1));
    if (u?.dono) continue;
    if (!u) {
      u = ok(await dbGlobal.from('usuarios').insert({ nome: p.nome, email, perfil: p.perfil, telefone, senha_hash: await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10), condominio_atual: condominioAtual() }).select('id').single());
      criados.push(p.nome);
    }
    ok(await dbGlobal.from('usuario_condominios').upsert({ usuario_id: u.id, condominio_id: condominioAtual() }, { onConflict: 'usuario_id,condominio_id' }));
  }
  return criados;
}

// Lista "Pronto para ativar": olha o estado real do sistema
async function checklist() {
  const cfg = await getConfig();
  const seguro = (p) => p.catch(() => 0);
  const [docs, moradores, manut] = await Promise.all([seguro(contar('documentos', (q) => q.eq('ativo', true))), seguro(contar('moradores', (q) => q.eq('ativo', true))), seguro(contar('manutencao_registros'))]);
  const [sindicos, manutencao, portaria] = await Promise.all([sv.telefonesDaEquipe(['sindico']), sv.telefonesDaEquipe(['zelador']), sv.telefonesDaEquipe(['portaria'])]);
  let whats = null;
  try { whats = (await require('./uazapi').status()).conectado; } catch { whats = null; }
  const equipeFicha = json(cfg.ficha_equipe, []);
  const itens = [
    { ok: Boolean(cfg.unidades_validas), texto: 'Apartamentos do prédio cadastrados', onde: '/configuracoes', obrigatorio: true },
    { ok: docs > 0, texto: 'Convenção e regulamento cadastrados em Documentos', onde: '/documentos', obrigatorio: true, dica: cfg.ficha_doc_link ? `Link enviado na ficha: ${cfg.ficha_doc_link}` : '' },
    { ok: sindicos.length > 0, texto: 'Síndico com WhatsApp na equipe (recebe as urgências)', onde: '/equipe', obrigatorio: true },
    { ok: manutencao.length > 0, texto: 'Manutenção com WhatsApp na equipe (recebe os chamados)', onde: '/equipe', obrigatorio: true },
    { ok: portaria.length > 0, texto: 'Portaria na equipe (registra encomendas)', onde: '/equipe', obrigatorio: false },
    { ok: Boolean(cfg.adm_nome && (cfg.adm_portal || cfg.adm_whatsapp || cfg.adm_telefone || cfg.adm_email)), texto: 'Administradora com contato para boletos e 2ª via', onde: '/configuracoes', obrigatorio: true },
    { ok: Boolean(cfg.regra_lixo || cfg.regra_encomendas || cfg.instrucoes_extras), texto: 'Regras do dia a dia (lixo, encomendas, reservas)', onde: '/configuracoes', obrigatorio: false },
    { ok: manut > 0, texto: 'Últimas manutenções registradas', onde: '/manutencoes', obrigatorio: false },
    { ok: Boolean(cfg.grupo_jid), texto: 'Grupo dos moradores escolhido', onde: '/whatsapp/grupos', obrigatorio: true },
    { ok: Boolean(cfg.grupo_convite), texto: 'Link de convite do grupo (para o cadastro dos moradores)', onde: '/configuracoes', obrigatorio: false },
    { ok: whats === true, texto: 'WhatsApp do assistente conectado', onde: '/whatsapp', obrigatorio: true },
    { ok: moradores > 0, texto: 'Moradores cadastrados (depois do convite no grupo)', onde: '/moradores', obrigatorio: false },
  ];
  return { itens, pronto: itens.filter((i) => i.obrigatorio).every((i) => i.ok), equipeFicha };
}

module.exports = { PARTES, MANUTENCOES_SUGERIDAS, token, condominioDoToken, partesFeitas, salvarParte, criarEquipeDaFicha, checklist, json };
