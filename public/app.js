// Pequenos ajudantes do painel
async function postJSON(url, dados) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(dados || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Falha na requisição');
  return j;
}

// Formulários com data-confirmar pedem confirmação na janela do próprio sistema.
// Palavras como excluir/desconectar/apagar deixam o botão vermelho.
document.addEventListener('submit', async (e) => {
  const form = e.target;
  const msg = form.getAttribute('data-confirmar');
  if (!msg || form.dataset.confirmado === '1') return;
  e.preventDefault();
  const perigo = /exclu|apag|descon|cancel|parar|bloque/i.test(msg);
  const ok = await dialogo.confirmar(msg, { perigo, ok: perigo ? 'Sim, continuar' : 'Confirmar' });
  if (!ok) return;
  form.dataset.confirmado = '1';
  form.requestSubmit(e.submitter || undefined);
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
  try { await fn(); } catch (err) { dialogo.aviso('Não deu certo', { texto: err.message }); } finally { botao.disabled = false; botao.innerHTML = t; }
}
