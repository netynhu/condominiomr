// Vários condomínios: trocar o condomínio da vez no painel e (para o dono da plataforma) criar e editar condomínios
const router = require('express').Router();
const { dbGlobal, ok, setConfig, getConfig, contar } = require('../db');
const { noCondominio } = require('../contexto');
const { a, exigir, exigirDono, avisar } = require('./comum');

// Troca o condomínio da vez (seletor do topo). Só entre os condomínios que a pessoa atende.
router.post('/condominio/trocar', exigir(), a(async (req, res) => {
  const lista = req.session.condominios || [];
  const alvo = lista.find((c) => c.id === req.body.id);
  if (alvo) {
    req.session.condominioId = alvo.id;
    await dbGlobal.from('usuarios').update({ condominio_atual: alvo.id }).eq('id', req.session.usuario.id);
    avisar(req, `Agora você está no ${alvo.nome}.`);
  }
  const volta = String(req.body.voltar || '/');
  // Páginas com id de outro condomínio (ex.: /chamados/123) não fazem sentido no novo: volta para a lista
  res.redirect(/^\/[a-z-]+$/.test(volta) || volta === '/' ? volta : '/' + (volta.split('/')[1] || ''));
}));

// Visão geral: todos os condomínios que a pessoa atende numa tela, com o que pede atenção em cada um
router.get('/visao-geral', exigir('admin'), a(async (req, res) => {
  const lista = req.session.condominios || [];
  const agora = new Date();
  const { agoraBR, localParaISO } = require('../util');
  const hoje = agoraBR().dataISO; // dia de hoje em Brasília
  const inicioDia = new Date(localParaISO(`${hoje}T00:00`));
  const fimDia = new Date(inicioDia.getTime() + 86400000);
  const seguro = (p) => p.catch(() => 0);
  const cards = [];
  for (const c of lista) {
    cards.push(await noCondominio(c.id, async () => {
      const cfg = await getConfig();
      const prazo = Math.max(1, Number(cfg.encomenda_prazo_dias) || 7);
      const [abertos, urgentes, reclamacoes, duvidas, encomendas, paradas, reservasHoje, manutVencidas, moradores] = await Promise.all([
        seguro(contar('chamados', (q) => q.in('status', ['aberto', 'em_andamento']))),
        seguro(contar('chamados', (q) => q.in('status', ['aberto', 'em_andamento']).in('prioridade', ['alta', 'urgente']))),
        seguro(contar('reclamacoes', (q) => q.eq('status', 'nova'))),
        seguro(contar('duvidas', (q) => q.eq('status', 'aberta'))),
        seguro(contar('encomendas', (q) => q.eq('status', 'aguardando'))),
        seguro(contar('encomendas', (q) => q.eq('status', 'aguardando').lte('recebida_em', new Date(agora.getTime() - prazo * 86400000).toISOString()))),
        seguro(contar('reservas', (q) => q.in('status', ['agendada', 'em_uso']).gte('inicio', inicioDia.toISOString()).lt('inicio', fimDia.toISOString()))),
        seguro(contar('manutencoes', (q) => q.lt('proxima_data', hoje))),
        seguro(contar('moradores', (q) => q.eq('ativo', true))),
      ]);
      const atencao = urgentes * 3 + reclamacoes * 2 + duvidas * 2 + paradas * 2 + manutVencidas * 2 + abertos;
      return { ...c, abertos, urgentes, reclamacoes, duvidas, encomendas, paradas, reservasHoje, manutVencidas, moradores, atencao };
    }));
  }
  cards.sort((x, y) => y.atencao - x.atencao); // o que mais precisa de atenção primeiro
  res.render('visao_geral', { titulo: 'Visão geral', cards });
}));

router.get('/condominios', exigirDono, a(async (req, res) => {
  const lista = ok(await dbGlobal.from('condominios').select('id, nome, ativo, criado_em').order('nome'));
  const [moradores, equipe] = await Promise.all([
    dbGlobal.from('moradores').select('condominio_id').eq('ativo', true).then(ok),
    dbGlobal.from('usuario_condominios').select('condominio_id').then(ok),
  ]);
  const conta = (linhas, id) => linhas.filter((l) => l.condominio_id === id).length;
  res.render('condominios', {
    titulo: 'Condomínios',
    lista: lista.map((c) => ({ ...c, moradores: conta(moradores, c.id), equipe: conta(equipe, c.id) })),
  });
}));

router.post('/condominios', exigirDono, a(async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  if (nome.length < 3) { avisar(req, 'Informe o nome do condomínio.', 'erro'); return res.redirect('/condominios'); }
  const c = ok(await dbGlobal.from('condominios').insert({ nome }).select('id, nome').single());
  // O super admin (dono) vê todos os condomínios sem fazer parte de nenhuma equipe: só passa a trabalhar no novo
  await noCondominio(c.id, () => setConfig({ nome_predio: nome, nome_assistente: 'Assistente do condomínio' }));
  req.session.condominioId = c.id;
  req.session.condominios = null;
  await dbGlobal.from('usuarios').update({ condominio_atual: c.id }).eq('id', req.session.usuario.id);
  avisar(req, `${nome} criado. Agora configure: documentos, ajustes do prédio, equipe e o grupo dos moradores.`);
  res.redirect('/configuracoes');
}));

router.post('/condominios/:id', exigirDono, a(async (req, res) => {
  const dados = {};
  if (req.body.nome) dados.nome = String(req.body.nome).trim();
  dados.ativo = req.body.ativo === 'on';
  ok(await dbGlobal.from('condominios').update(dados).eq('id', req.params.id));
  if (dados.nome) await noCondominio(req.params.id, () => setConfig({ nome_predio: dados.nome }));
  req.session.condominios = null;
  avisar(req, dados.ativo ? 'Condomínio atualizado.' : 'Condomínio desativado: o assistente deixa de atender os moradores dele.');
  res.redirect('/condominios');
}));

module.exports = router;
