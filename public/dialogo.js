// Janelas do próprio sistema (no lugar dos popups do navegador): confirmar, aviso e toast
(function () {
  const css = `
  .dlg-fundo{position:fixed;inset:0;z-index:100;background:rgba(12,27,31,.5);display:grid;place-items:center;padding:20px;animation:dlgIn .15s ease}
  .dlg{background:#fff;color:#101828;border-radius:16px;box-shadow:0 24px 48px -12px rgba(16,24,40,.35);width:100%;max-width:400px;padding:22px;display:flex;flex-direction:column;gap:16px;font:inherit}
  .dlg-ic{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-size:1.3rem;font-weight:800;background:#E6F4F0;color:#0E8A70}
  .dlg.perigo .dlg-ic{background:#FEF0EE;color:#B42318}
  .dlg h3{margin:0;font-size:1.1rem;line-height:1.3}
  .dlg p{margin:0;color:#475467;line-height:1.5;white-space:pre-wrap}
  .dlg-acoes{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}
  .dlg-acoes button{font:inherit;font-weight:700;border-radius:10px;padding:11px 18px;min-height:44px;cursor:pointer;border:1px solid #D0D5DD;background:#fff;color:#344054}
  .dlg-acoes .dlg-ok{background:#0E8A70;border-color:#0E8A70;color:#fff}
  .dlg.perigo .dlg-ok{background:#B42318;border-color:#B42318}
  .dlg-toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:101;background:#101828;color:#fff;padding:12px 18px;border-radius:12px;font-weight:600;box-shadow:0 12px 28px -8px rgba(16,24,40,.5);max-width:calc(100% - 32px);animation:dlgIn .2s ease}
  @media (max-width:520px){.dlg-fundo{place-items:end center;padding:0}.dlg{max-width:none;border-radius:20px 20px 0 0;padding-bottom:calc(22px + env(safe-area-inset-bottom,0px))}.dlg-acoes button{flex:1}}
  .campo-erro{border-color:#D92D20!important;box-shadow:0 0 0 4px rgba(217,45,32,.12)!important}
  .msg-erro{display:block;color:#B42318;font-size:.8rem;font-weight:600;margin-top:4px}
  @keyframes dlgIn{from{opacity:0}to{opacity:1}}
  @media (prefers-reduced-motion:reduce){.dlg-fundo,.dlg-toast{animation:none}}`;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  function abrir({ titulo, texto, ok = 'OK', cancelar, perigo = false, icone = perigo ? '!' : '✓' }) {
    return new Promise((resolve) => {
      const fundo = document.createElement('div');
      fundo.className = 'dlg-fundo';
      fundo.innerHTML = `<div class="dlg ${perigo ? 'perigo' : ''}" role="dialog" aria-modal="true"><span class="dlg-ic"></span><div><h3></h3><p></p></div><div class="dlg-acoes"></div></div>`;
      fundo.querySelector('.dlg-ic').textContent = icone;
      fundo.querySelector('h3').textContent = titulo || '';
      const p = fundo.querySelector('p');
      if (texto) p.textContent = texto; else p.remove();
      const acoes = fundo.querySelector('.dlg-acoes');
      const fechar = (v) => { fundo.remove(); document.removeEventListener('keydown', tecla); resolve(v); };
      const tecla = (e) => { if (e.key === 'Escape') fechar(false); };
      if (cancelar) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = cancelar; b.onclick = () => fechar(false); acoes.appendChild(b);
      }
      const b = document.createElement('button'); b.type = 'button'; b.className = 'dlg-ok'; b.textContent = ok; b.onclick = () => fechar(true); acoes.appendChild(b);
      fundo.addEventListener('click', (e) => { if (e.target === fundo) fechar(false); });
      document.addEventListener('keydown', tecla);
      document.body.appendChild(fundo);
      b.focus();
    });
  }

  // Validação dos formulários com mensagens do sistema (desliga os balões do navegador)
  function mensagemDoCampo(c) {
    const v = c.validity;
    if (v.valueMissing) return c.type === 'radio' ? 'Escolha uma opção.' : 'Preencha este campo.';
    if (v.typeMismatch && c.type === 'email') return 'Digite um e-mail válido.';
    if (v.tooShort) return `Use pelo menos ${c.minLength} caracteres.`;
    if (v.rangeUnderflow || v.rangeOverflow) return 'Valor fora do permitido.';
    return 'Confira este campo.';
  }
  function limpar(c) {
    c.classList.remove('campo-erro');
    const m = c.parentElement && c.parentElement.querySelector(':scope > .msg-erro');
    if (m) m.remove();
  }
  function preparar(form) { form.noValidate = true; }
  document.addEventListener('DOMContentLoaded', () => document.querySelectorAll('form').forEach(preparar));
  new MutationObserver(() => document.querySelectorAll('form:not([novalidate])').forEach(preparar)).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('input', (e) => { if (e.target.classList?.contains('campo-erro')) limpar(e.target); }, true);
  document.addEventListener('change', (e) => { if (e.target.classList?.contains('campo-erro')) limpar(e.target); }, true);
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.checkValidity()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    let primeiro = null;
    form.querySelectorAll('input, select, textarea').forEach((c) => {
      limpar(c);
      if (c.willValidate && !c.checkValidity()) {
        c.classList.add('campo-erro');
        const m = document.createElement('span'); m.className = 'msg-erro'; m.textContent = mensagemDoCampo(c);
        (c.type === 'radio' || c.type === 'checkbox' ? c.closest('label') || c : c).insertAdjacentElement('afterend', m);
        if (!primeiro) primeiro = c;
      }
    });
    if (primeiro) { primeiro.focus({ preventScroll: true }); primeiro.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    window.dialogo.toast('Confira os campos destacados em vermelho.');
  }, true);

  window.dialogo = {
    confirmar: (titulo, opts = {}) => abrir({ titulo, cancelar: 'Cancelar', ok: 'Confirmar', icone: opts.perigo ? '!' : '?', ...opts }),
    aviso: (titulo, opts = {}) => abrir({ titulo, ok: 'Entendi', icone: '!', ...opts }),
    toast(texto, ms = 3200) {
      const t = document.createElement('div'); t.className = 'dlg-toast'; t.setAttribute('role', 'status'); t.textContent = texto;
      document.body.appendChild(t); setTimeout(() => t.remove(), ms);
    },
  };
})();
