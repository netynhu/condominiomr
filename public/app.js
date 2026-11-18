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

// Menu lateral no celular
document.addEventListener('click', (e) => {
  if (e.target.closest('#abrir-menu')) document.body.classList.add('menu-aberto');
  else if (e.target.closest('[data-fechar-menu]')) document.body.classList.remove('menu-aberto');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.body.classList.remove('menu-aberto'); });

// Botão ocupado enquanto a IA trabalha
async function ocupado(botao, fn) {
  const t = botao.innerHTML;
  botao.disabled = true;
  botao.textContent = 'Aguarde...';
  try { await fn(); } catch (err) { alert(err.message); } finally { botao.disabled = false; botao.innerHTML = t; }
}
