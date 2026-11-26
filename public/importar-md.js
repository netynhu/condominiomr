// Importa a convenção / regulamento em arquivo Markdown (.md). O navegador lê o arquivo e manda em partes
// (cortando nos títulos), o servidor junta, cria o documento do assistente e a IA sugere horários, regras e contradições.
// Uso: importarMd({ arquivo, base: '/ficha/TOKEN' ou '/documentos', aoProgresso: (texto, pct) => {} })
(function () {
  const TAMANHO_PARTE = 20000; // caracteres por envio
  const LIMITE_ARQUIVO = 5 * 1024 * 1024;

  async function postar(url, corpo) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
    return j;
  }

  // Corta o texto em partes, preferindo cortar antes de um título (#) ou de uma linha em branco
  function dividir(texto) {
    const partes = [];
    let resto = texto;
    while (resto.length > TAMANHO_PARTE) {
      const janela = resto.slice(0, TAMANHO_PARTE);
      let corte = janela.lastIndexOf('\n#');
      if (corte < TAMANHO_PARTE / 2) corte = janela.lastIndexOf('\n\n');
      if (corte < TAMANHO_PARTE / 2) corte = TAMANHO_PARTE;
      partes.push(resto.slice(0, corte).trim());
      resto = resto.slice(corte);
    }
    if (resto.trim()) partes.push(resto.trim());
    return partes.filter(Boolean);
  }

  async function importarMd({ arquivo, base, aoProgresso = () => {} }) {
    if (!arquivo || !/\.(md|markdown|txt)$/i.test(arquivo.name)) throw new Error('Escolha um arquivo .md (Markdown).');
    if (arquivo.size > LIMITE_ARQUIVO) throw new Error('Arquivo grande demais (máximo 5 MB).');
    aoProgresso('Lendo o arquivo...', 0);
    const texto = (await arquivo.text()).replace(/\r\n/g, '\n').trim();
    if (texto.replace(/\s/g, '').length < 200) throw new Error('O arquivo está vazio ou muito curto.');
    const partes = dividir(texto);
    const { id } = await postar(`${base}/importacao`, { nome: arquivo.name, paginas: partes.length });

    for (let i = 0; i < partes.length; i++) {
      for (let tentativa = 1; ; tentativa++) {
        try { await postar(`${base}/importacao/${id}/pagina`, { pagina: i + 1, texto: partes[i] }); break; } catch (e) {
          if (tentativa >= 3) throw new Error(`Falha ao enviar o arquivo: ${e.message}`);
          await new Promise((r) => setTimeout(r, 2000 * tentativa));
        }
      }
      aoProgresso(`Enviando ${i + 1} de ${partes.length}...`, Math.round(((i + 1) / partes.length) * 40));
    }

    aoProgresso('Analisando o documento (horários, regras e contradições)... leva 1 a 2 minutos', 50);
    await postar(`${base}/importacao/${id}/concluir`, {});
    for (let i = 0; i < 120; i++) { // até 6 minutos
      await new Promise((r) => setTimeout(r, 3000));
      const s = await fetch(`${base}/importacao/${id}`).then((r) => r.json());
      if (s.status === 'pronto') { aoProgresso('Pronto!', 100); return s; }
      if (s.status === 'erro') throw new Error(s.erro || 'Não consegui ler o documento.');
      aoProgresso('Analisando o documento (horários, regras e contradições)... leva 1 a 2 minutos', Math.min(95, 50 + i));
    }
    throw new Error('A análise está demorando. Recarregue a página em alguns minutos.');
  }

  window.importarMd = importarMd;
})();
