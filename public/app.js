// Pequenos ajudantes do painel
async function postJSON(url, dados) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(dados || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Falha na requisição');
  return j;
}

// Botões que pedem confirmação antes de enviar o formulário
document.addEventListener('submit', (e) => {
  const msg = e.target.getAttribute('data-confirmar');
  if (msg && !window.confirm(msg)) e.preventDefault();
});

// Botão ocupado enquanto a IA trabalha
async function ocupado(botao, fn) {
  const t = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Aguarde...';
  try { await fn(); } catch (err) { alert(err.message); } finally { botao.disabled = false; botao.textContent = t; }
}
