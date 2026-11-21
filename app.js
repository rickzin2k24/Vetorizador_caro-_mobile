/* CAROÁ VETORIZA · celular — vetorizar linhas de lote sem internet.
 *
 * 1. No computador (aba Lotes → "Área para o celular") sai um QR code. Aqui: "Escanear QR code" baixa o pacote
 *    (pedaço do ortomosaico + linhas de lote) e guarda no celular (IndexedDB). Depois funciona no modo avião.
 * 2. Ferramentas sem IA: selecionar e arrastar pontos (com lupa), linha nova, apagar ponto/linha, cortar, juntar,
 *    desfazer/refazer, snap, GPS e "ver só a foto".
 * 3. Na volta: "Enviar para o computador" (QR code de "Receber do celular") ou exportar um GeoJSON pelo Compartilhar.
 */
(() => {
  'use strict';
  const VERSAO = '1.1.0';
  const $ = (id) => document.getElementById(id);
  const VAZIO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const MAGICO = 'CAROA1\n';
  const geojson = new ol.format.GeoJSON();
  const P3857 = { featureProjection: 'EPSG:3857' };

  // ============================================================ utilidades
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const mb = (b) => (b / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 20);
  const dataCurta = (iso) => { try { return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  const slug = (t) => (t || 'area').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase();

  let avisoTimer = null;
  function aviso(texto, erro = false, ms = 3800) {
    const el = $('aviso');
    el.textContent = texto;
    el.className = 'aviso' + (erro ? ' erro' : '');
    el.hidden = false;
    clearTimeout(avisoTimer);
    avisoTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function mostrarTela(id) {
    for (const t of document.querySelectorAll('.tela')) t.hidden = t.id !== id;
    if (id === 'tela-mapa' && mapa) requestAnimationFrame(() => mapa.updateSize());
  }

  function folha(titulo, texto, botoes) {
    $('folha-titulo').textContent = titulo;
    $('folha-texto').textContent = texto || '';
    $('folha-texto').hidden = !texto;
    const box = $('folha-botoes');
    box.innerHTML = '';
    for (const b of botoes) {
      const el = document.createElement('button');
      el.className = 'botao ' + (b.c || 'secundario');
      el.textContent = b.t;
      el.onclick = b.a;
      box.appendChild(el);
    }
    $('folha').hidden = false;
  }
  const fecharFolha = () => { $('folha').hidden = true; };
  $('folha').addEventListener('click', (e) => { if (e.target.id === 'folha') fecharFolha(); });

  function progresso(titulo, fracao, texto) {
    $('prog-titulo').textContent = titulo;
    $('prog-barra').style.width = `${Math.round(Math.max(0, Math.min(1, fracao)) * 100)}%`;
    $('prog-texto').textContent = texto || '';
  }

  const nomeVetorizador = () => { try { return (localStorage.getItem('caroa.vetorizador') || '').trim(); } catch { return ''; } };

  // ============================================================ banco no celular (IndexedDB)
  let _db = null;
  function banco() {
    if (_db) return Promise.resolve(_db);
    return new Promise((ok, erro) => {
      const r = indexedDB.open('caroa-celular', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('areas')) d.createObjectStore('areas', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('tiles')) d.createObjectStore('tiles');
      };
      r.onsuccess = () => { _db = r.result; ok(_db); };
      r.onerror = () => erro(r.error);
    });
  }
  const pedido = (r) => new Promise((ok, erro) => { r.onsuccess = () => ok(r.result); r.onerror = () => erro(r.error); });
  const fim = (t) => new Promise((ok, erro) => {
    t.oncomplete = () => ok();
    t.onerror = () => erro(t.error || new Error('Não deu para gravar no celular.'));
    t.onabort = () => erro(t.error || new Error('Não deu para gravar no celular (falta espaço?).'));
  });
  async function pegar(loja, chave) { const d = await banco(); return pedido(d.transaction(loja).objectStore(loja).get(chave)); }
  async function todas(loja) { const d = await banco(); return pedido(d.transaction(loja).objectStore(loja).getAll()); }
  async function gravar(loja, valor) { const d = await banco(); const t = d.transaction(loja, 'readwrite'); t.objectStore(loja).put(valor); return fim(t); }
  async function apagarArea(id) {
    const d = await banco();
    const t = d.transaction(['areas', 'tiles'], 'readwrite');
    t.objectStore('areas').delete(id);
    t.objectStore('tiles').delete(IDBKeyRange.bound(id + '/', id + '/￿'));
    return fim(t);
  }

  // ============================================================ pacote (.caroa)
  function lerPacote(u8) {
    if (u8.length < 12 || new TextDecoder().decode(u8.subarray(0, 7)) !== MAGICO) throw new Error('Esse arquivo não é um pacote do CAROÁ.');
    const n = new DataView(u8.buffer, u8.byteOffset + 7, 4).getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(u8.subarray(11, 11 + n)));
    if (meta.formato !== 'caroa-celular') throw new Error('Pacote de formato desconhecido.');
    return { meta, dados: u8.subarray(11 + n) };
  }

  async function guardarPacote(u8, aoAvancar) {
    const { meta, dados } = lerPacote(u8);
    const id = meta.chave;
    const existente = await pegar('areas', id);
    const tiles = meta.tiles || [];
    const LOTE = 250;
    for (let i = 0; i < tiles.length; i += LOTE) {
      const d = await banco();
      const t = d.transaction('tiles', 'readwrite');
      const st = t.objectStore('tiles');
      for (const [z, x, y, off, len] of tiles.slice(i, i + LOTE)) st.put(dados.slice(off, off + len).buffer, `${id}/${z}/${x}/${y}`);
      await fim(t);
      aoAvancar?.(Math.min(1, (i + LOTE) / Math.max(1, tiles.length)));
    }
    const linhas = {
      type: 'FeatureCollection',
      features: (meta.linhas?.features || []).map((f) => ({
        type: 'Feature', geometry: f.geometry,
        properties: { id: f.properties.id, versao: f.properties.versao, equipe: !!f.properties.equipe, status: f.properties.status, op: 'igual' },
      })),
    };
    const area = {
      id, nome: meta.nome, projeto: meta.projeto, criado: meta.criado, baixado: new Date().toISOString(),
      area: meta.area, centro: meta.centro, zmin: meta.zmin, zmax: meta.zmax, bytes: u8.length, ntiles: tiles.length,
      estado: existente?.estado || { features: linhas, apagadas: [] }, vista: existente?.vista || null,
    };
    await gravar('areas', area);
    try { await navigator.storage?.persist?.(); } catch { /* opcional */ }
    return area;
  }

  // ============================================================ baixar pelo QR code
  let cancelar = null;
  // A ponte (túnel) pode levar até ~1,5 min para o celular enxergar: insiste com calma antes de desistir.
  async function tentar(fazer, rotulo) {
    const MAX = 24;
    for (let i = 1; ; i++) {
      try { return await fazer(); } catch (e) {
        if (cancelar?.signal.aborted) throw new Error('Cancelado.');
        if (i >= MAX) throw new Error('Não consegui falar com o computador. Confira a internet do celular e se a janela do QR code ainda está aberta no computador.');
        progresso(rotulo, 0.02, `Procurando o computador pela internet… (${i} de ${MAX}). Pode levar até 1 minuto e meio — deixe esta tela aberta.`);
        await espera(i < 3 ? 2500 : 4500);
      }
    }
  }

  async function baixar(codigo) {
    const resto = codigo.slice('caroa:baixar:'.length);
    const i = resto.indexOf(':');
    const total = Number(resto.slice(0, i)) || 0;
    const url = resto.slice(i + 1);
    cancelar = new AbortController();
    mostrarTela('tela-progresso');
    progresso('Baixando a área…', 0.02, 'Conectando ao computador…');
    try {
      const resp = await tentar(() => fetch(url, { signal: cancelar.signal, cache: 'no-store' }), 'Baixando a área…');
      if (!resp.ok) {
        let msg = '';
        try { msg = (await resp.json()).detail; } catch { /* sem detalhe */ }
        throw new Error(msg || `O computador respondeu ${resp.status}. Gere o QR de novo.`);
      }
      const tam = total || Number(resp.headers.get('X-Tamanho') || resp.headers.get('Content-Length')) || 0;
      const leitor = resp.body.getReader();
      const pedacos = [];
      let pos = 0;
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) break;
        pedacos.push(value);
        pos += value.length;
        progresso('Baixando a área…', tam ? 0.75 * pos / tam : 0.4, `${mb(pos)} de ${tam ? mb(tam) : '?'} MB`);
      }
      const tudo = new Uint8Array(pos);
      let k = 0;
      for (const p of pedacos) { tudo.set(p, k); k += p.length; }
      pedacos.length = 0;
      progresso('Guardando no celular…', 0.76, 'Quase lá…');
      const area = await guardarPacote(tudo, (f) => progresso('Guardando no celular…', 0.76 + 0.24 * f, `${Math.round(f * 100)}%`));
      fetch(url + '/ok', { method: 'POST' }).catch(() => {});
      aviso(`✓ Área “${area.nome}” no celular. Funciona sem internet.`, false, 5000);
      abrirArea(area);
    } catch (e) {
      mostrarTela('tela-inicio');
      listarAreas();
      aviso(e.message || String(e), true, 9000);
    } finally { cancelar = null; }
  }

  async function abrirArquivo(arquivo) {
    mostrarTela('tela-progresso');
    progresso('Abrindo o arquivo…', 0.1, `${mb(arquivo.size)} MB`);
    try {
      const u8 = new Uint8Array(await arquivo.arrayBuffer());
      const area = await guardarPacote(u8, (f) => progresso('Guardando no celular…', 0.1 + 0.9 * f, `${Math.round(f * 100)}%`));
      aviso(`✓ Área “${area.nome}” no celular.`, false, 5000);
      abrirArea(area);
    } catch (e) {
      mostrarTela('tela-inicio');
      listarAreas();
      aviso(e.message || String(e), true, 8000);
    }
  }

  // ============================================================ leitor de QR code
  let stream = null;
  let scanTimer = null;
  let aoLerQR = null;
  const cv = document.createElement('canvas');

  function decodificar(fonte, w, h, lado) {
    const k = Math.min(1, lado / Math.max(w, h));
    cv.width = Math.max(1, Math.round(w * k));
    cv.height = Math.max(1, Math.round(h * k));
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.drawImage(fonte, 0, 0, cv.width, cv.height);
    const img = c.getImageData(0, 0, cv.width, cv.height);
    const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    return r ? r.data : null;
  }

  async function abrirScanner(callback, texto) {
    aoLerQR = callback;
    mostrarTela('tela-scanner');
    $('scanner-texto').textContent = texto || 'Aponte para o QR code da tela do computador';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
      const v = $('video');
      v.srcObject = stream;
      await v.play();
      scanTimer = setInterval(() => {
        if (v.readyState < 2 || !v.videoWidth) return;
        const t = decodificar(v, v.videoWidth, v.videoHeight, 720);
        if (t) achouCodigo(t);
      }, 220);
    } catch {
      $('scanner-texto').textContent = 'A câmera não abriu aqui (permita a câmera para o app). Use “Tirar foto do QR”.';
    }
  }

  function fecharScanner() {
    clearInterval(scanTimer);
    scanTimer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    $('video').srcObject = null;
  }

  function achouCodigo(t) {
    t = (t || '').trim();
    if (!t.startsWith('caroa:')) { $('scanner-texto').textContent = 'Esse QR code não é do CAROÁ. Aponte para o QR da tela do computador.'; return; }
    fecharScanner();
    try { navigator.vibrate?.(60); } catch { /* sem vibração */ }
    const cb = aoLerQR;
    aoLerQR = null;
    cb?.(t);
  }

  $('btn-cancelar-scan').onclick = () => { fecharScanner(); if (areaAtual && voltarProMapa) { voltarProMapa = false; mostrarTela('tela-mapa'); } else { mostrarTela('tela-inicio'); listarAreas(); } };
  $('btn-codigo').onclick = () => { const t = prompt('Cole o código (começa com caroa:)'); if (t) achouCodigo(t); };
  $('btn-foto-qr').onclick = () => $('foto-qr').click();
  async function imagemDe(arq) {   // createImageBitmap não existe em iPhone antigo: cai para <img>
    if (window.createImageBitmap) { try { return await createImageBitmap(arq); } catch { /* tenta com <img> */ } }
    return new Promise((ok, erro) => {
      const url = URL.createObjectURL(arq);
      const img = new Image();
      img.onload = () => { ok(img); URL.revokeObjectURL(url); };
      img.onerror = () => { erro(new Error('foto')); URL.revokeObjectURL(url); };
      img.src = url;
    });
  }
  $('foto-qr').onchange = async (e) => {
    const arq = e.target.files?.[0];
    e.target.value = '';
    if (!arq) return;
    try {
      const bmp = await imagemDe(arq);
      const w = bmp.naturalWidth || bmp.width, h = bmp.naturalHeight || bmp.height;
      const t = decodificar(bmp, w, h, 1400) || decodificar(bmp, w, h, 900);
      if (t) achouCodigo(t); else $('scanner-texto').textContent = 'Não achei o QR na foto. Tente de novo, mais perto e reto.';
    } catch { $('scanner-texto').textContent = 'Não consegui ler a foto.'; }
  };

  // ============================================================ início
  async function listarAreas() {
    let areas = [];
    try { areas = await todas('areas'); } catch (e) { aviso('O celular não deixou guardar dados aqui: ' + e.message, true, 9000); }
    areas.sort((a, b) => (b.baixado || '').localeCompare(a.baixado || ''));
    const lista = $('lista-areas');
    lista.innerHTML = '';
    $('sem-areas').hidden = areas.length > 0;
    for (const a of areas) {
      const n = pendentesDe(a);
      const el = document.createElement('div');
      el.className = 'area';
      const b = document.createElement('b'); b.textContent = a.nome;
      const abrir = document.createElement('button'); abrir.className = 'abrir'; abrir.textContent = 'Abrir';
      abrir.onclick = () => abrirArea(a);
      const s1 = document.createElement('small'); s1.textContent = `${a.projeto?.nome || ''} · ${dataCurta(a.baixado)} · ${mb(a.bytes)} MB`;
      const s2 = document.createElement('small');
      s2.className = n ? 'pend' : '';
      s2.textContent = n ? `${n} mudança(s) não enviada(s)` : (a.enviado_em ? `Tudo enviado ✓ (${dataCurta(a.enviado_em)})` : 'Sem mudanças');
      const apagar = document.createElement('button'); apagar.className = 'apagar'; apagar.textContent = 'Apagar do celular';
      apagar.onclick = () => {
        folha(`Apagar “${a.nome}” do celular?`, n ? `Atenção: ${n} mudança(s) ainda não foram para o computador e vão se perder.` : 'A foto e as linhas dessa área saem do celular (no computador fica tudo).', [
          { t: 'Apagar do celular', c: 'perigo', a: async () => { fecharFolha(); await apagarArea(a.id); listarAreas(); aviso('Área apagada do celular.'); } },
          { t: 'Cancelar', a: fecharFolha },
        ]);
      };
      el.append(b, abrir, s1, s2, apagar);
      lista.appendChild(el);
    }
    try {
      const e = await navigator.storage?.estimate?.();
      $('espaco').textContent = e ? `Usando ${mb(e.usage || 0)} MB no celular · app ${VERSAO}` : `app ${VERSAO}`;
    } catch { $('espaco').textContent = `app ${VERSAO}`; }
  }

  function codigoDoInicio(t) {
    if (t.startsWith('caroa:baixar:')) { baixar(t); return; }
    mostrarTela('tela-inicio');
    if (t.startsWith('caroa:enviar:')) aviso('Esse QR code é para ENVIAR. Abra a área e toque em ⇪ (Enviar).', true, 7000);
    else aviso('QR code desconhecido.', true);
  }

  $('btn-escanear').onclick = () => abrirScanner(codigoDoInicio);
  $('btn-arquivo').onclick = () => $('arquivo-pacote').click();
  $('arquivo-pacote').onchange = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) abrirArquivo(f); };
  $('btn-prog-cancelar').onclick = () => { cancelar?.abort(); };
  try { $('vetorizador').value = nomeVetorizador(); } catch { /* sem armazenamento */ }
  $('vetorizador').onchange = (e) => { try { localStorage.setItem('caroa.vetorizador', e.target.value.trim()); } catch { /* sem armazenamento */ } };

  // ============================================================ mapa
  let mapa = null;
  let fonteLinhas, camadaLinhas, fonteArea, camadaArea, fonteGps, camadaFoto = null;
  let areaAtual = null;
  let modo = 'mover';
  let selecionada = null;
  let acao = null;            // 'vertice' | 'cortar' | 'juntar'
  let modify = null, snap = null, draw = null, geo = null;
  let historico = [], refazerPilha = [];
  let voltarProMapa = false;
  let primeiraPosicao = false;
  let lupaAtiva = false, ultimoPixel = null;
  let salvarTimer = null;

  // ---------- aparência das linhas (grossura, borda, opacidade, bolinhas, cores) — fica guardada neste celular
  const S = ol.style;
  const APARENCIA_PADRAO = { largura: 2.6, borda: 'fina', opacidade: 1, ponto: 8, tracejada: false,
    cores: { equipe: '#ffd23f', app: '#5ef0b4', mexida: '#ff4fd8' } };
  const LIMITES = { largura: [0.3, 14], opacidade: [0.15, 1], ponto: [3, 16] };
  const copiaPadrao = () => JSON.parse(JSON.stringify(APARENCIA_PADRAO));
  function lerAparencia() {
    try {
      const j = JSON.parse(localStorage.getItem('caroa.aparencia') || 'null');
      if (j && typeof j === 'object') return { ...copiaPadrao(), ...j, cores: { ...APARENCIA_PADRAO.cores, ...(j.cores || {}) } };
    } catch { /* sem armazenamento */ }
    return copiaPadrao();
  }
  let ap = lerAparencia();
  const rgba = (hex, a) => {
    const n = parseInt(String(hex).replace('#', ''), 16) || 0;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const larguraBorda = () => (ap.borda === 'sem' ? 0 : ap.largura + (ap.borda === 'grossa' ? 5 : 2.4));

  let ESTILOS, estiloSel, estiloDesenho, estiloArrastando;
  function vertices(g) {
    const t = g.getType();
    return t === 'LineString' ? g.getCoordinates() : t === 'MultiLineString' ? g.getCoordinates().flat() : [];
  }
  function montarEstilos() {
    const w = ap.largura, op = ap.opacidade, bw = larguraBorda();
    const borda = (largura) => new S.Style({ stroke: new S.Stroke({ color: `rgba(0,0,0,${(0.6 * op).toFixed(2)})`, width: largura }) });
    const linha = (cor, tracejada) => [...(bw ? [borda(bw)] : []), new S.Style({ stroke: new S.Stroke({
      color: rgba(cor, op), width: w, lineDash: tracejada ? [Math.max(5, w * 3.5), Math.max(4, w * 2.5)] : undefined }) })];
    ESTILOS = { equipe: linha(ap.cores.equipe, ap.tracejada), app: linha(ap.cores.app, false), mexida: linha(ap.cores.mexida, false) };
    const r = ap.ponto;
    const ws = Math.max(w + 1.5, 2.5);   // a selecionada fica um pouco mais grossa que as outras
    const vertice = new S.Circle({ radius: r, fill: new S.Fill({ color: '#ffffff' }), stroke: new S.Stroke({ color: '#00a3b8', width: Math.max(1.5, r / 3) }) });
    estiloSel = [...(bw ? [borda(ws + (bw - w))] : []), new S.Style({ stroke: new S.Stroke({ color: '#00e5ff', width: ws }) }),
      new S.Style({ image: vertice, geometry: (ft) => new ol.geom.MultiPoint(vertices(ft.getGeometry())) })];
    estiloDesenho = [...(bw ? [borda(ws + (bw - w))] : []), new S.Style({
      stroke: new S.Stroke({ color: rgba(ap.cores.mexida, 1), width: ws }),
      image: new S.Circle({ radius: r + 1, fill: new S.Fill({ color: rgba(ap.cores.mexida, 0.35) }), stroke: new S.Stroke({ color: '#fff', width: Math.max(1.5, r / 3.5) }) }),
    })];
    estiloArrastando = new S.Style({ image: new S.Circle({ radius: r + 5, fill: new S.Fill({ color: 'rgba(0,229,255,.35)' }), stroke: new S.Stroke({ color: '#fff', width: 3 }) }) });
  }
  montarEstilos();
  function estiloLinha(f) {
    if (f === selecionada) return estiloSel;
    return f.get('op') !== 'igual' ? ESTILOS.mexida : f.get('equipe') ? ESTILOS.equipe : ESTILOS.app;
  }
  const estiloArea = [new S.Style({ stroke: new S.Stroke({ color: 'rgba(0,0,0,.5)', width: 4 }) }),
    new S.Style({ stroke: new S.Stroke({ color: '#ffffff', width: 2, lineDash: [10, 8] }) })];
  const estiloGps = (f) => f.getGeometry().getType() === 'Point'
    ? new S.Style({ image: new S.Circle({ radius: 8, fill: new S.Fill({ color: '#2f80ff' }), stroke: new S.Stroke({ color: '#fff', width: 3 }) }) })
    : new S.Style({ fill: new S.Fill({ color: 'rgba(47,128,255,.15)' }), stroke: new S.Stroke({ color: 'rgba(47,128,255,.6)', width: 1 }) });

  function criarMapa() {
    if (mapa) return;
    fonteLinhas = new ol.source.Vector();
    fonteArea = new ol.source.Vector();
    fonteGps = new ol.source.Vector();
    camadaLinhas = new ol.layer.Vector({ source: fonteLinhas, style: estiloLinha, updateWhileInteracting: true, updateWhileAnimating: true });
    camadaArea = new ol.layer.Vector({ source: fonteArea, style: estiloArea });
    mapa = new ol.Map({
      target: 'mapa',
      layers: [camadaArea, camadaLinhas, new ol.layer.Vector({ source: fonteGps, style: estiloGps })],
      controls: [new ol.control.ScaleLine({ minWidth: 70 })],
      interactions: ol.interaction.defaults.defaults({ pinchRotate: false, altShiftDragRotate: false }),
      view: new ol.View({ center: [0, 0], zoom: 3, maxZoom: 23.5, minZoom: 12, constrainResolution: false }),
    });
    mapa.on('singleclick', aoTocar);
    mapa.on('pointerdrag', (e) => { if (lupaAtiva) { ultimoPixel = e.pixel; desenharLupa(); } });
    mapa.on('postrender', () => { if (lupaAtiva && ultimoPixel) desenharLupa(); });
    mapa.getView().on('change', () => salvarDepois());
  }

  function carregarTile(id) {
    return (tile, chave) => {
      const img = tile.getImage();
      pegar('tiles', `${id}/${chave}`).then((buf) => {
        if (!buf) { img.src = VAZIO; return; }
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/webp' }));
        img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        img.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
        img.src = url;
      }).catch(() => { img.src = VAZIO; });
    };
  }

  /** Linhas do pacote/estado → feições do mapa; multilinha de uma parte só vira linha simples (dá para cortar e juntar). */
  function lerLinhas(col) {
    const feats = geojson.readFeatures(col, P3857);
    for (const f of feats) {
      const g = f.getGeometry();
      if (g && g.getType() === 'MultiLineString' && g.getLineStrings().length === 1) f.setGeometry(g.getLineString(0));
    }
    return feats;
  }

  function extensaoDaArea(a) {
    return geojson.readGeometry(a.area, P3857).getExtent();
  }

  function abrirArea(a) {
    areaAtual = a;
    mostrarTela('tela-mapa');
    criarMapa();
    if (camadaFoto) mapa.removeLayer(camadaFoto);
    const ext = extensaoDaArea(a);
    camadaFoto = new ol.layer.Tile({
      source: new ol.source.XYZ({
        minZoom: a.zmin, maxZoom: a.zmax, transition: 0,
        tileUrlFunction: (tc) => `${tc[0]}/${tc[1]}/${tc[2]}`,
        tileLoadFunction: carregarTile(a.id),
      }),
      extent: ol.extent.buffer(ext, 60), preload: 1,
    });
    mapa.getLayers().insertAt(0, camadaFoto);
    fonteArea.clear();
    fonteArea.addFeature(new ol.Feature(geojson.readGeometry(a.area, P3857)));
    fonteLinhas.clear();
    fonteLinhas.addFeatures(lerLinhas(a.estado.features));
    historico = [];
    refazerPilha = [];
    camadaLinhas.setVisible(true);
    camadaArea.setVisible(true);
    $('btn-olho').classList.remove('ativo');
    $('nome-area').textContent = a.nome;
    mapa.updateSize();
    selecionar(null);
    definirModo('mover');
    if (a.vista?.centro) {
      mapa.getView().setCenter(a.vista.centro);
      mapa.getView().setZoom(a.vista.zoom);
    } else {
      mapa.getView().fit(ext, { padding: [90, 20, 110, 20] });
    }
    atualizarContador();
    try { localStorage.setItem('caroa.ultima', a.id); } catch { /* sem armazenamento */ }
  }

  // ---------- estado e gravação
  function pendentesDe(a) {
    const feats = a?.estado?.features?.features || [];
    return feats.filter((f) => f.properties?.op && f.properties.op !== 'igual').length + (a?.estado?.apagadas?.length || 0);
  }
  function pendentes() {
    if (!areaAtual) return 0;
    return fonteLinhas.getFeatures().filter((f) => f.get('op') !== 'igual').length + areaAtual.estado.apagadas.length;
  }
  function atualizarContador() {
    const n = pendentes();
    const el = $('contador');
    el.textContent = n ? `${n} mudança(s) não enviada(s)` : (areaAtual?.enviado_em ? 'tudo enviado ✓' : 'sem mudanças');
    el.className = n ? 'pend' : '';
    $('btn-desfazer').disabled = !historico.length;
    $('btn-refazer').disabled = !refazerPilha.length;
  }
  function retrato() {
    return JSON.stringify({ features: geojson.writeFeaturesObject(fonteLinhas.getFeatures(), { ...P3857, decimals: 8 }), apagadas: areaAtual.estado.apagadas });
  }
  function salvarAgora() {
    if (!areaAtual || !mapa) return Promise.resolve();
    clearTimeout(salvarTimer);
    areaAtual.estado = { features: geojson.writeFeaturesObject(fonteLinhas.getFeatures(), { ...P3857, decimals: 8 }), apagadas: areaAtual.estado.apagadas };
    const v = mapa.getView();
    areaAtual.vista = { centro: v.getCenter(), zoom: v.getZoom() };
    return gravar('areas', areaAtual).catch((e) => aviso('Não gravou no celular: ' + e.message, true, 8000));
  }
  function salvarDepois() { clearTimeout(salvarTimer); salvarTimer = setTimeout(salvarAgora, 600); }
  function mudou() { atualizarContador(); salvarAgora(); }

  function guardarHistorico() {
    historico.push(retrato());
    if (historico.length > 60) historico.shift();
    refazerPilha = [];
  }
  function restaurar(json) {
    const r = JSON.parse(json);
    fonteLinhas.clear();
    fonteLinhas.addFeatures(lerLinhas(r.features));
    areaAtual.estado.apagadas = r.apagadas;
    selecionar(null);
    mudou();
  }
  $('btn-desfazer').onclick = () => {
    if (!historico.length) return;
    if (draw) { draw.abortDrawing(); }
    refazerPilha.push(retrato());
    restaurar(historico.pop());
    aviso('Desfeito.', false, 1200);
  };
  $('btn-refazer').onclick = () => {
    if (!refazerPilha.length) return;
    historico.push(retrato());
    restaurar(refazerPilha.pop());
    aviso('Refeito.', false, 1200);
  };

  function marcarMexida(f) { if (f.get('op') === 'igual') f.set('op', 'editado'); }
  function novaFeicao(geom) {
    const f = new ol.Feature({ geometry: geom });
    f.setProperties({ id: 'cel_' + uid(), op: 'novo', equipe: false, versao: 0 });
    return f;
  }
  function tirarFeicao(f) {
    if (f.get('op') !== 'novo') areaAtual.estado.apagadas.push({ id: f.get('id'), versao: f.get('versao') });
    fonteLinhas.removeFeature(f);
  }

  // ---------- modos e seleção
  function dica(texto) { const el = $('dica-mapa'); el.textContent = texto || ''; el.hidden = !texto; }
  function barra(botoes) {
    const el = $('barra-contexto');
    el.innerHTML = '';
    el.hidden = !botoes;
    for (const b of botoes || []) {
      const x = document.createElement('button');
      x.textContent = b.t;
      x.className = (b.c || '') + (b.ligado ? ' ligado' : '');
      x.onclick = b.a;
      el.appendChild(x);
    }
  }

  function refazerSnap() {
    if (snap) mapa.removeInteraction(snap);
    snap = new ol.interaction.Snap({ source: fonteLinhas, pixelTolerance: 16 });
    mapa.addInteraction(snap);
  }

  function definirModo(m) {
    modo = m;
    document.querySelectorAll('.ferramentas [data-f]').forEach((b) => b.classList.toggle('ativo', b.dataset.f === m));
    if (draw) { mapa.removeInteraction(draw); draw = null; }
    mapa.getInteractions().forEach((i) => { if (i instanceof ol.interaction.DoubleClickZoom) i.setActive(m !== 'linha'); });
    acao = null;
    if (m === 'linha') { selecionar(null); iniciarDesenho(); } else { barra(null); dica(null); }
    refazerSnap();
  }
  document.querySelectorAll('.ferramentas [data-f]').forEach((b) => { b.onclick = () => definirModo(b.dataset.f); });

  function selecionar(f) {
    selecionada = f || null;
    acao = null;
    if (modify) { mapa.removeInteraction(modify); modify = null; }
    if (selecionada) {
      modify = new ol.interaction.Modify({ features: new ol.Collection([selecionada]), pixelTolerance: 24, style: () => estiloArrastando });
      let antes = null;
      modify.on('modifystart', () => { antes = selecionada.getGeometry().clone(); guardarHistorico(); lupaAtiva = true; });
      modify.on('modifyend', () => {
        lupaAtiva = false;
        esconderLupa();
        if (antes && semMudanca(antes, selecionada.getGeometry())) {   // só um toque na linha: não cria ponto
          selecionada.setGeometry(antes);
          historico.pop();
          atualizarContador();
          return;
        }
        marcarMexida(selecionada);
        mudou();
      });
      mapa.addInteraction(modify);
      refazerSnap();
    }
    camadaLinhas.changed();
    barraSelecao();
  }

  function semMudanca(a, b) {
    const tol = 0.05;   // unidades do mapa (~4 cm)
    const perto = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;
    const va = vertices(a), vb = vertices(b);
    return vb.every((p) => perto(a.getClosestPoint(p), p)) && va.every((p) => vb.some((q) => perto(p, q)));
  }

  function barraSelecao() {
    if (modo !== 'mover') return;
    if (!selecionada) { barra(null); dica(null); return; }
    const simples = selecionada.getGeometry().getType() === 'LineString';
    barra([
      { t: '🗑 Apagar linha', c: 'perigo', a: apagarSelecionada },
      { t: '• Apagar ponto', a: () => alternarAcao('vertice'), ligado: acao === 'vertice' },
      ...(simples ? [{ t: '✂ Cortar', a: () => alternarAcao('cortar'), ligado: acao === 'cortar' },
        { t: '⧉ Juntar', a: () => alternarAcao('juntar'), ligado: acao === 'juntar' }] : []),
      { t: '✓ Pronto', c: 'ok', a: () => selecionar(null) },
    ]);
    dica(acao === 'vertice' ? 'Toque na bolinha que quer apagar'
      : acao === 'cortar' ? 'Toque na linha, no ponto onde quer cortar'
        : acao === 'juntar' ? 'Toque na outra linha (as pontas precisam estar perto)'
          : 'Arraste as bolinhas · arraste o meio de um trecho para criar ponto');
  }
  function alternarAcao(q) { acao = acao === q ? null : q; barraSelecao(); }

  /** A linha mais perto do dedo (onde várias se cruzam, pega a mais próxima, não a de cima). */
  function linhaNoPixel(pixel, exceto) {
    mapa.renderSync();   // o que acabou de mudar já conta no toque
    const achadas = mapa.getFeaturesAtPixel(pixel, { hitTolerance: 16, layerFilter: (l) => l === camadaLinhas }).filter((f) => f !== exceto);
    if (!achadas.length) return null;
    const c = mapa.getCoordinateFromPixel(pixel);
    let melhor = null, dm = Infinity;
    for (const f of achadas) {
      const p = f.getGeometry().getClosestPoint(c);
      const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
      if (d < dm) { dm = d; melhor = f; }
    }
    return melhor;
  }

  function aoTocar(e) {
    if (modo !== 'mover') return;
    if (selecionada && acao === 'vertice') { apagarPonto(e.pixel); return; }
    if (selecionada && acao === 'cortar') { cortar(e.coordinate); return; }
    if (selecionada && acao === 'juntar') { juntar(e.pixel); return; }
    const f = linhaNoPixel(e.pixel);
    if (f !== selecionada) selecionar(f);
  }

  function apagarSelecionada() {
    if (!selecionada) return;
    guardarHistorico();
    tirarFeicao(selecionada);
    selecionar(null);
    mudou();
    aviso('Linha apagada.', false, 1500);
  }

  function apagarPonto(pixel) {
    const g = selecionada.getGeometry();
    const t = g.getType();
    const partes = t === 'LineString' ? [g.getCoordinates()] : g.getCoordinates();
    let melhor = null;
    partes.forEach((l, il) => l.forEach((c, ic) => {
      const p = mapa.getPixelFromCoordinate(c);
      const d = Math.hypot(p[0] - pixel[0], p[1] - pixel[1]);
      if (d < 28 && (!melhor || d < melhor.d)) melhor = { d, il, ic };
    }));
    if (!melhor) { aviso('Toque bem em cima de uma bolinha.'); return; }
    if (partes[melhor.il].length <= 2) { aviso('A linha precisa de 2 pontos. Para tirar a linha, use “Apagar linha”.', true); return; }
    guardarHistorico();
    partes[melhor.il].splice(melhor.ic, 1);
    selecionada.setGeometry(t === 'LineString' ? new ol.geom.LineString(partes[0]) : new ol.geom.MultiLineString(partes));
    marcarMexida(selecionada);
    const manter = acao;
    selecionar(selecionada);
    acao = manter;
    barraSelecao();
    mudou();
  }

  function pontoNoSegmento(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return [a[0] + t * dx, a[1] + t * dy];
  }
  const metros = (coords) => ol.sphere.getLength(new ol.geom.LineString(coords));
  const distM = (a, b) => ol.sphere.getDistance(ol.proj.toLonLat(a), ol.proj.toLonLat(b));

  function cortar(coord) {
    const cs = selecionada.getGeometry().getCoordinates();
    let melhor = null;
    for (let i = 0; i < cs.length - 1; i++) {
      const p = pontoNoSegmento(coord, cs[i], cs[i + 1]);
      const d = Math.hypot(p[0] - coord[0], p[1] - coord[1]);
      if (!melhor || d < melhor.d) melhor = { d, i, p };
    }
    const px = mapa.getPixelFromCoordinate(melhor.p), pt = mapa.getPixelFromCoordinate(coord);
    if (Math.hypot(px[0] - pt[0], px[1] - pt[1]) > 30) { aviso('Toque em cima da linha selecionada.'); return; }
    const a = [...cs.slice(0, melhor.i + 1), melhor.p];
    const b = [melhor.p, ...cs.slice(melhor.i + 1)];
    const limpar = (l) => l.filter((c, i) => i === 0 || Math.hypot(c[0] - l[i - 1][0], c[1] - l[i - 1][1]) > 1e-6);
    const la = limpar(a), lb = limpar(b);
    if (la.length < 2 || lb.length < 2 || metros(la) < 0.2 || metros(lb) < 0.2) { aviso('Corte muito perto da ponta.', true); return; }
    guardarHistorico();
    selecionada.setGeometry(new ol.geom.LineString(la));
    marcarMexida(selecionada);
    fonteLinhas.addFeature(novaFeicao(new ol.geom.LineString(lb)));
    selecionar(selecionada);
    mudou();
    aviso('Linha cortada em duas.', false, 1800);
  }

  function juntar(pixel) {
    const outra = linhaNoPixel(pixel, selecionada);
    if (!outra) { aviso('Toque na outra linha.'); return; }
    if (outra.getGeometry().getType() !== 'LineString') { aviso('Essa linha tem várias partes: junte no computador.', true); return; }
    const a = selecionada.getGeometry().getCoordinates();
    const b = outra.getGeometry().getCoordinates();
    const casos = [
      { d: distM(a[a.length - 1], b[0]), l: () => [...a, ...b.slice(1)] },
      { d: distM(a[a.length - 1], b[b.length - 1]), l: () => [...a, ...b.slice(0, -1).reverse()] },
      { d: distM(a[0], b[b.length - 1]), l: () => [...b, ...a.slice(1)] },
      { d: distM(a[0], b[0]), l: () => [...b.slice().reverse(), ...a.slice(1)] },
    ].sort((x, y) => x.d - y.d);
    if (casos[0].d > 2) { aviso(`As pontas estão a ${casos[0].d.toFixed(1).replace('.', ',')} m. Aproxime (até 2 m) e tente de novo.`, true, 5000); return; }
    guardarHistorico();
    selecionada.setGeometry(new ol.geom.LineString(casos[0].l()));
    marcarMexida(selecionada);
    tirarFeicao(outra);
    selecionar(selecionada);
    mudou();
    aviso('Linhas juntadas.', false, 1800);
  }

  // ---------- linha nova
  let pontosDesenho = 0;
  function iniciarDesenho() {
    draw = new ol.interaction.Draw({
      type: 'LineString', style: () => estiloDesenho, stopClick: true, snapTolerance: 18,
      condition: (e) => ol.events.condition.noModifierKeys(e) && ol.events.condition.primaryAction(e),
    });
    draw.on('drawstart', (e) => {
      const g = e.feature.getGeometry();
      g.on('change', () => { pontosDesenho = Math.max(0, g.getCoordinates().length - 1); barraDesenho(); });
    });
    draw.on('drawend', (e) => {
      pontosDesenho = 0;
      const g = e.feature.getGeometry();
      if (g.getCoordinates().length < 2 || ol.sphere.getLength(g) < 0.3) { aviso('Linha muito curta.', true); barraDesenho(); return; }
      guardarHistorico();
      fonteLinhas.addFeature(novaFeicao(g));
      mudou();
      aviso('Linha criada. Pode fazer a próxima.', false, 1800);
      barraDesenho();
    });
    draw.on('drawabort', () => { pontosDesenho = 0; barraDesenho(); });
    mapa.addInteraction(draw);
    pontosDesenho = 0;
    barraDesenho();
  }
  function barraDesenho() {
    if (modo !== 'linha') return;
    dica(pontosDesenho ? 'Toque o próximo ponto no eixo do muro · ✓ termina a linha' : 'Toque os pontos no eixo do muro (gruda nas linhas e cantos)');
    barra(pontosDesenho ? [
      { t: '↩ Ponto', a: () => draw?.removeLastPoint() },
      { t: '✕ Cancelar', c: 'perigo', a: () => draw?.abortDrawing() },
      { t: '✓ Terminar', c: 'ok', a: () => { if (pontosDesenho >= 2) draw?.finishDrawing(); else aviso('Toque pelo menos 2 pontos.'); } },
    ] : [{ t: '✋ Voltar a selecionar', a: () => definirModo('mover') }]);
  }

  // ---------- lupa (ao arrastar um ponto com o dedo)
  const lupa = $('lupa');
  function desenharLupa() {
    if (!ultimoPixel) return;
    const r = window.devicePixelRatio || 1;
    const tam = 150;
    const zoom = 2.2;
    if (lupa.width !== tam * r) { lupa.width = tam * r; lupa.height = tam * r; }
    const ctx = lupa.getContext('2d');
    ctx.clearRect(0, 0, lupa.width, lupa.height);
    ctx.fillStyle = '#2a3432';
    ctx.fillRect(0, 0, lupa.width, lupa.height);
    const lado = (tam / zoom) * r;
    for (const c of mapa.getViewport().querySelectorAll('canvas')) {
      if (!c.width || c === lupa) continue;
      const k = c.width / mapa.getSize()[0];
      try { ctx.drawImage(c, ultimoPixel[0] * k - (lado * k) / (2 * r), ultimoPixel[1] * k - (lado * k) / (2 * r), (lado * k) / r, (lado * k) / r, 0, 0, lupa.width, lupa.height); } catch { /* canvas ainda vazio */ }
    }
    ctx.strokeStyle = '#ff4fd8';
    ctx.lineWidth = 2 * r;
    const m = lupa.width / 2;
    ctx.beginPath(); ctx.moveTo(m - 14 * r, m); ctx.lineTo(m + 14 * r, m); ctx.moveTo(m, m - 14 * r); ctx.lineTo(m, m + 14 * r); ctx.stroke();
    const y = ultimoPixel[1] - 75 - 120;
    lupa.style.left = `${Math.max(6, Math.min(window.innerWidth - 156, ultimoPixel[0] - 75))}px`;
    lupa.style.top = `${y < 60 ? ultimoPixel[1] + 70 : y}px`;
    lupa.hidden = false;
  }
  function esconderLupa() { lupa.hidden = true; ultimoPixel = null; }

  // ---------- botões do mapa
  $('btn-voltar').onclick = async () => {
    if (draw) draw.abortDrawing();
    painelAparencia(false);
    await salvarAgora();
    if (geo?.getTracking()) alternarGps();
    mostrarTela('tela-inicio');
    listarAreas();
  };
  $('btn-centro').onclick = () => mapa.getView().fit(extensaoDaArea(areaAtual), { padding: [90, 20, 110, 20], duration: 300 });
  $('btn-olho').onclick = () => {
    const so = camadaLinhas.getVisible();
    camadaLinhas.setVisible(!so);
    camadaArea.setVisible(!so);
    $('btn-olho').classList.toggle('ativo', so);
    aviso(so ? 'Só a foto (toque no 👁 de novo para ver as linhas)' : 'Linhas de volta', false, 1600);
  };
  // ---------- painel de aparência (🎨): grossura, borda, opacidade, bolinhas, cores — muda o mapa na hora
  const fmtNum = (v) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  function amostra() {
    const bw = larguraBorda(), w = ap.largura, op = ap.opacidade;
    const linha = (y, cor, nome, tracejada) =>
      `<text x="8" y="${y + 4}" fill="#fff" font-size="12" font-family="sans-serif">${nome}</text>` +
      (bw ? `<line x1="74" y1="${y}" x2="94%" y2="${y}" stroke="rgba(0,0,0,${(0.6 * op).toFixed(2)})" stroke-width="${bw}"/>` : '') +
      `<line x1="74" y1="${y}" x2="94%" y2="${y}" stroke="${rgba(cor, op)}" stroke-width="${w}"` +
      (tracejada ? ` stroke-dasharray="${Math.max(5, w * 3.5)} ${Math.max(4, w * 2.5)}"` : '') + '/>';
    return `<svg width="100%" height="96" role="img" aria-label="Exemplo"><rect width="100%" height="96" rx="10" fill="#3d4b40"/>` +
      linha(20, ap.cores.equipe, 'Equipe', ap.tracejada) + linha(48, ap.cores.app, 'App', false) + linha(76, ap.cores.mexida, 'Mexidas', false) +
      `<circle cx="74" cy="76" r="${ap.ponto}" fill="#fff" stroke="#00a3b8" stroke-width="${Math.max(1.5, ap.ponto / 3).toFixed(1)}"/></svg>`;
  }
  function preencherAparencia() {
    $('pa-largura').value = ap.largura;
    $('pa-largura-v').textContent = `${fmtNum(ap.largura)} px`;
    $('pa-opacidade').value = ap.opacidade;
    $('pa-opacidade-v').textContent = `${Math.round(ap.opacidade * 100)}%`;
    $('pa-ponto').value = ap.ponto;
    $('pa-ponto-v').textContent = `${ap.ponto} px`;
    document.querySelectorAll('#pa-borda button').forEach((b) => b.classList.toggle('ativo', b.dataset.borda === ap.borda));
    document.querySelectorAll('[data-largura]').forEach((b) => b.classList.toggle('ativo', Math.abs(Number(b.dataset.largura) - ap.largura) < 0.05));
    $('pa-cor-equipe').value = ap.cores.equipe;
    $('pa-cor-app').value = ap.cores.app;
    $('pa-cor-mexida').value = ap.cores.mexida;
    $('pa-tracejada').checked = !!ap.tracejada;
    $('pa-amostra').innerHTML = amostra();
  }
  function aplicarAparencia() {
    for (const [k, [a, b]] of Object.entries(LIMITES)) ap[k] = Math.min(b, Math.max(a, Math.round(Number(ap[k]) * 100) / 100 || a));
    montarEstilos();
    if (camadaLinhas) camadaLinhas.changed();
    if (mapa) mapa.render();
    try { localStorage.setItem('caroa.aparencia', JSON.stringify(ap)); } catch { /* sem armazenamento */ }
    preencherAparencia();
  }
  function painelAparencia(abrir) {
    $('painel-aparencia').hidden = !abrir;
    document.body.classList.toggle('com-aparencia', abrir);
    $('btn-aparencia').classList.toggle('ativo', abrir);
    if (abrir) preencherAparencia();
  }
  $('btn-aparencia').onclick = () => painelAparencia($('painel-aparencia').hidden);
  $('pa-fechar').onclick = () => painelAparencia(false);
  for (const k of ['largura', 'opacidade', 'ponto']) $(`pa-${k}`).addEventListener('input', (e) => { ap[k] = Number(e.target.value); aplicarAparencia(); });
  document.querySelectorAll('[data-mais]').forEach((b) => { b.onclick = () => { ap[b.dataset.mais] = Number(ap[b.dataset.mais]) + Number(b.dataset.passo); aplicarAparencia(); }; });
  document.querySelectorAll('[data-largura]').forEach((b) => { b.onclick = () => { ap.largura = Number(b.dataset.largura); aplicarAparencia(); }; });
  document.querySelectorAll('#pa-borda button').forEach((b) => { b.onclick = () => { ap.borda = b.dataset.borda; aplicarAparencia(); }; });
  for (const k of ['equipe', 'app', 'mexida']) $(`pa-cor-${k}`).addEventListener('input', (e) => { ap.cores[k] = e.target.value; aplicarAparencia(); });
  $('pa-tracejada').onchange = (e) => { ap.tracejada = e.target.checked; aplicarAparencia(); };
  $('pa-padrao').onclick = () => { ap = copiaPadrao(); aplicarAparencia(); aviso('Aparência de volta ao padrão.', false, 1500); };

  function alternarGps() {
    if (!geo) {
      geo = new ol.Geolocation({ projection: mapa.getView().getProjection(), trackingOptions: { enableHighAccuracy: true, maximumAge: 5000 } });
      geo.on('change:position', () => {
        const p = geo.getPosition();
        if (!p) return;
        fonteGps.clear();
        const acc = geo.getAccuracyGeometry();
        if (acc) fonteGps.addFeature(new ol.Feature(acc));
        fonteGps.addFeature(new ol.Feature(new ol.geom.Point(p)));
        if (primeiraPosicao) { primeiraPosicao = false; mapa.getView().animate({ center: p, zoom: Math.max(mapa.getView().getZoom(), 19), duration: 400 }); }
      });
      geo.on('error', () => { aviso('GPS indisponível: permita a localização para o app CAROÁ.', true, 6000); });
    }
    const ligar = !geo.getTracking();
    primeiraPosicao = ligar;
    geo.setTracking(ligar);
    $('btn-gps').classList.toggle('ativo', ligar);
    if (!ligar) fonteGps.clear(); else aviso('Procurando o GPS…', false, 2000);
  }
  $('btn-gps').onclick = alternarGps;

  // ============================================================ enviar
  function envio() {
    const col = geojson.writeFeaturesObject(fonteLinhas.getFeatures(), { ...P3857, decimals: 8 });
    const vet = nomeVetorizador();
    for (const f of col.features) {
      const p = f.properties || {};
      f.properties = { caroa_id: p.id, caroa_op: p.op, caroa_versao: p.versao, equipe: !!p.equipe, ...(vet ? { vetorizador: vet } : {}) };
    }
    col.caroa = {
      formato: 'caroa-celular-envio', versao: 1, app: VERSAO, projeto: areaAtual.projeto?.id, area: areaAtual.id,
      nome: areaAtual.nome, envio: uid(), apagadas: areaAtual.estado.apagadas, vetorizador: vet || 'celular', criado: new Date().toISOString(),
    };
    return col;
  }

  function resumo(r) {
    if (r.repetido) return 'esse envio já tinha chegado (nada duplicado).';
    const partes = [`${r.novas} nova(s)`, `${r.editadas} mexida(s)`, `${r.apagadas} apagada(s)`];
    return partes.join(' · ') + (r.conferir ? ` · ${r.conferir} para conferir no computador` : '');
  }

  function rebase(res) {
    const ids = res.ids || {};
    for (const f of fonteLinhas.getFeatures()) {
      if (f.get('op') === 'igual') continue;
      const m = ids[f.get('id')];
      if (m) { f.set('id', m.id); f.set('versao', m.versao); }
      f.set('op', 'igual');
    }
    areaAtual.estado.apagadas = [];
    areaAtual.enviado_em = new Date().toISOString();
    historico = [];
    refazerPilha = [];
    camadaLinhas.changed();
    mudou();
  }

  async function enviarPeloQR(codigo) {
    if (!codigo.startsWith('caroa:enviar:')) {
      mostrarTela('tela-mapa');
      aviso('Esse QR code é de BAIXAR área. No computador, abra “📥 Receber do celular”.', true, 7000);
      return;
    }
    const url = codigo.slice('caroa:enviar:'.length);
    const corpo = JSON.stringify(envio());
    cancelar = new AbortController();
    mostrarTela('tela-progresso');
    progresso('Enviando para o computador…', 0.3, 'Conectando…');
    try {
      const r = await tentar(() => fetch(url, { method: 'POST', body: corpo, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, signal: cancelar.signal }), 'Enviando para o computador…');
      let j = {};
      try { j = await r.json(); } catch { /* sem corpo */ }
      if (!r.ok) throw new Error(j.detail || `O computador respondeu ${r.status}.`);
      rebase(j);
      progresso('Enviado ✓', 1, resumo(j));
      await espera(1400);
      mostrarTela('tela-mapa');
      aviso(`✓ Enviado: ${resumo(j)}`, false, 6000);
    } catch (e) {
      mostrarTela('tela-mapa');
      aviso(e.message || String(e), true, 9000);
    } finally { cancelar = null; }
  }

  function baixarArquivo(arq) {
    const url = URL.createObjectURL(arq);
    const a = document.createElement('a');
    a.href = url;
    a.download = arq.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function exportarArquivo() {
    fecharFolha();
    const col = envio();
    const nome = `caroa-celular-${slug(areaAtual.nome)}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.geojson`;
    const arq = new File([JSON.stringify(col)], nome, { type: 'application/json' });
    const pronto = () => aviso('No computador: aba Lotes → “📥 Receber do celular” → Escolher arquivo. As mudanças continuam marcadas até você enviar pelo QR.', false, 9000);
    if (navigator.canShare && navigator.canShare({ files: [arq] })) {
      navigator.share({ files: [arq], title: nome }).then(pronto).catch((e) => { if (e?.name !== 'AbortError') { baixarArquivo(arq); pronto(); } });
    } else {
      baixarArquivo(arq);
      pronto();
    }
  }

  $('btn-enviar').onclick = () => {
    if (draw) draw.abortDrawing();
    const n = pendentes();
    folha('Enviar para o computador', n ? `${n} mudança(s) para mandar.` : 'Nada novo para mandar (tudo já foi).', [
      { t: '🖥 Enviar pelo QR code', c: 'primario', a: () => { fecharFolha(); voltarProMapa = true; salvarAgora(); abrirScanner(enviarPeloQR, 'No computador: aba Lotes → “📥 Receber do celular”. Aponte para o QR.'); } },
      { t: '📎 Exportar arquivo (WhatsApp, e-mail…)', a: exportarArquivo },
      { t: 'Cancelar', a: fecharFolha },
    ]);
  };

  // ============================================================ começo
  document.addEventListener('visibilitychange', () => { if (document.hidden) salvarAgora(); });
  window.addEventListener('pagehide', () => { salvarAgora(); });
  const instalado = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('dica-instalar').hidden = instalado || !ios;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('resize', () => mapa?.updateSize());
  window.__caroa = { get mapa() { return mapa; }, get linhas() { return fonteLinhas; }, get sel() { return selecionada; }, get area() { return areaAtual; } };
  mostrarTela('tela-inicio');
  listarAreas();
})();
