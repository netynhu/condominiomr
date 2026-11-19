// Lê a foto da câmera, reduz para no máximo 1280px e devolve como JPEG (data URL)
function ligarFoto(inputId, previaId, textoId, aoTerminar) {
  const input = document.getElementById(inputId);
  const previa = document.getElementById(previaId);
  const texto = document.getElementById(textoId);
  input.addEventListener('change', () => {
    const arq = input.files && input.files[0];
    if (!arq) return;
    texto.textContent = 'Preparando a foto...';
    const img = new Image();
    const url = URL.createObjectURL(arq);
    img.onload = () => {
      const max = 1280;
      const escala = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * escala);
      c.height = Math.round(img.height * escala);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const dados = c.toDataURL('image/jpeg', 0.78);
      URL.revokeObjectURL(url);
      previa.src = dados;
      previa.hidden = false;
      texto.textContent = 'Trocar foto';
      aoTerminar(dados);
    };
    img.onerror = () => { texto.textContent = 'Não consegui ler a foto. Tente de novo.'; };
    img.src = url;
  });
}
