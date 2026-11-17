/* İzim — yürüdüğün yerleri kaydeden harita.
 * Veriler sadece bu cihazda (localStorage) tutulur.
 */
(() => {
  'use strict';

  const KEY_WALKS = 'izim.walks.v1';
  const KEY_CURRENT = 'izim.current.v1';
  const MAX_ACCURACY = 35;   // m — daha kötü GPS okumalarını at
  const MIN_STEP = 4;        // m — bundan kısa hareketleri kaydetme (titreme)
  const MAX_SPEED = 12;      // m/s — bundan hızlı sıçramalar GPS hatasıdır
  const COLORS = ['#0f766e', '#2563eb', '#c2410c', '#7c3aed', '#be123c', '#4d7c0f', '#0369a1', '#a16207'];

  const $ = (id) => document.getElementById(id);

  // ---------- Depolama ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); return true; }
      catch (e) { note('Kaydedilemedi: depolama dolu olabilir.'); return false; }
    },
    del(key) { try { localStorage.removeItem(key); } catch {} },
  };

  let walks = store.get(KEY_WALKS, []);

  // ---------- Yardımcılar ----------
  function haversine(a, b) {
    const R = 6371000, toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  const fmtKm = (m) => (m / 1000).toFixed(2);
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
  }
  function fmtPace(ms, m) {
    if (m < 50) return '–';
    const minPerKm = ms / 60000 / (m / 1000);
    if (!isFinite(minPerKm) || minPerKm > 99) return '–';
    const mm = Math.floor(minPerKm), ss = Math.round((minPerKm - mm) * 60);
    return `${mm}:${String(ss === 60 ? 59 : ss).padStart(2, '0')}`;
  }
  const fmtDate = (t) => new Date(t).toLocaleString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const colorOf = (i) => COLORS[i % COLORS.length];
  let noteTimer;
  function note(msg, keep) {
    $('note').textContent = msg || '';
    clearTimeout(noteTimer);
    if (msg && !keep) noteTimer = setTimeout(() => ($('note').textContent = ''), 5000);
  }

  // ---------- Harita ----------
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([39.0, 35.0], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  const liveLayer = L.layerGroup().addTo(map);
  const historyLayer = L.layerGroup();
  const liveLine = L.polyline([], { color: '#0f766e', weight: 6, opacity: 0.9 }).addTo(liveLayer);
  const meMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18] }) });
  const accCircle = L.circle([0, 0], { radius: 0, color: '#2563eb', weight: 1, fillOpacity: 0.08 });

  // ---------- Kayıt durumu ----------
  // cur: { start, segs: [[[lat,lng,t],...], ...], dist, activeMs, resumedAt|null }
  let cur = store.get(KEY_CURRENT, null);
  let watchId = null;
  let tick = null;
  let wakeLock = null;
  let follow = true;
  let lastFix = null;
  let geoErr = false;

  function elapsed() {
    if (!cur) return 0;
    return cur.activeMs + (cur.resumedAt ? Date.now() - cur.resumedAt : 0);
  }
  const recording = () => !!(cur && cur.resumedAt);

  function saveCurrent() { if (cur) { cur.savedAt = Date.now(); store.set(KEY_CURRENT, cur); } }

  function renderStats() {
    const d = cur ? cur.dist : 0, t = elapsed();
    $('sDist').textContent = fmtKm(d);
    $('sTime').textContent = fmtTime(t);
    $('sPace').textContent = fmtPace(t, d);
  }

  function renderButtons() {
    const active = !!cur;
    $('bStart').hidden = active;
    $('bPause').hidden = !active;
    $('bStop').hidden = !active;
    $('bPause').textContent = recording() ? 'Duraklat' : 'Devam et';
  }

  function drawLive() {
    liveLine.setLatLngs(cur ? cur.segs.map((s) => s.map((p) => [p[0], p[1]])) : []);
  }

  function onPosition(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const t = pos.timestamp || Date.now();
    lastFix = [lat, lng];
    if (geoErr) { geoErr = false; note(''); }

    meMarker.setLatLng(lastFix);
    accCircle.setLatLng(lastFix).setRadius(accuracy);
    if (!map.hasLayer(meMarker)) { meMarker.addTo(liveLayer); accCircle.addTo(liveLayer); map.setView(lastFix, 17); }
    else if (follow && currentTab === 'walk') map.panTo(lastFix, { animate: true });

    if (!recording()) return;
    if (accuracy > MAX_ACCURACY) { note(`GPS sinyali zayıf (±${Math.round(accuracy)} m), bekleniyor…`); return; }

    const seg = cur.segs[cur.segs.length - 1];
    const prev = seg[seg.length - 1];
    if (prev) {
      const d = haversine(prev, [lat, lng]);
      const dt = Math.max(1, (t - prev[2]) / 1000);
      if (d < MIN_STEP) return;
      if (d / dt > MAX_SPEED) return; // sıçrama
      cur.dist += d;
    }
    seg.push([+lat.toFixed(6), +lng.toFixed(6), t]);
    drawLive();
    renderStats();
    saveCurrent();
  }

  function onGeoError(err) {
    const msgs = {
      1: 'Konum izni verilmedi. Tarayıcı ayarlarından konuma izin ver.',
      2: 'Konum bulunamadı. Açık alana çıkmayı dene.',
      3: 'Konum zaman aşımı, tekrar deneniyor…',
    };
    geoErr = true;
    note(msgs[err.code] || 'Konum hatası.', err.code === 1);
  }

  function startWatch() {
    if (!('geolocation' in navigator)) { note('Bu cihaz konum desteklemiyor.', true); return; }
    if (watchId !== null) return;
    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
    });
  }
  function stopWatch() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  async function lockScreen() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch {}
  }
  function releaseScreen() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }

  function startTick() { clearInterval(tick); tick = setInterval(renderStats, 1000); }
  function stopTick() { clearInterval(tick); tick = null; }

  function start() {
    cur = { start: Date.now(), segs: [[]], dist: 0, activeMs: 0, resumedAt: Date.now() };
    saveCurrent();
    follow = true;
    startWatch(); lockScreen(); startTick();
    drawLive(); renderButtons(); renderStats();
    note('Kayıt başladı. Ekranı açık tut, uygulamayı arka plana atma.');
  }

  function togglePause() {
    if (!cur) return;
    if (recording()) {
      cur.activeMs += Date.now() - cur.resumedAt;
      cur.resumedAt = null;
      stopTick(); releaseScreen();
      note('Duraklatıldı.');
    } else {
      cur.resumedAt = Date.now();
      if (cur.segs[cur.segs.length - 1].length) cur.segs.push([]); // aradaki boşluğu çizme
      startWatch(); lockScreen(); startTick();
      note('Devam ediliyor.');
    }
    saveCurrent(); renderButtons(); renderStats();
  }

  function stop() {
    if (!cur) return;
    if (cur.resumedAt) { cur.activeMs += Date.now() - cur.resumedAt; cur.resumedAt = null; }
    const segs = cur.segs.filter((s) => s.length >= 2);
    const pointCount = segs.reduce((n, s) => n + s.length, 0);
    if (!pointCount) {
      if (!confirm('Henüz yol kaydedilmedi. Yine de bitirilsin mi? (Kaydedilmeyecek)')) { renderButtons(); return; }
    } else {
      walks.unshift({
        id: cur.start.toString(36),
        start: cur.start,
        end: Date.now(),
        dist: Math.round(cur.dist),
        dur: cur.activeMs,
        segs: segs.map((s) => s.map((p) => [p[0], p[1]])),
      });
      store.set(KEY_WALKS, walks);
      note(`Kaydedildi: ${fmtKm(cur.dist)} km, ${fmtTime(cur.activeMs)}`);
    }
    cur = null;
    store.del(KEY_CURRENT);
    stopTick(); releaseScreen();
    drawLive(); renderButtons(); renderStats();
    renderList();
  }

  // ---------- Haritam ----------
  let selectedId = null;

  function drawHistory() {
    historyLayer.clearLayers();
    walks.forEach((w, i) => {
      const sel = selectedId === w.id;
      const dim = selectedId && !sel;
      L.polyline(w.segs, {
        color: colorOf(i), weight: sel ? 7 : 5, opacity: dim ? 0.25 : 0.75, lineCap: 'round', lineJoin: 'round',
      }).on('click', () => select(w.id)).addTo(historyLayer);
    });
  }

  function fitAll() {
    selectedId = null;
    drawHistory(); highlightList();
    const all = walks.flatMap((w) => w.segs.flat());
    if (all.length) map.fitBounds(L.latLngBounds(all), { paddingTopLeft: [30, 80], paddingBottomRight: [30, 280] });
  }

  function select(id) {
    selectedId = selectedId === id ? null : id;
    drawHistory(); highlightList();
    const w = walks.find((x) => x.id === id);
    if (selectedId && w) map.fitBounds(L.latLngBounds(w.segs.flat()), { paddingTopLeft: [30, 80], paddingBottomRight: [30, 280] });
  }

  function highlightList() {
    document.querySelectorAll('.item').forEach((el) => {
      el.style.background = el.dataset.id === selectedId ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : '';
    });
  }

  function renderList() {
    $('tCount').textContent = walks.length;
    $('tDist').textContent = (walks.reduce((s, w) => s + w.dist, 0) / 1000).toFixed(1);
    const list = $('list');
    list.innerHTML = '';
    if (!walks.length) {
      list.innerHTML = '<div class="empty">Henüz yürüyüş yok. İlk yürüyüşünü kaydet, burada birikecek.</div>';
      return;
    }
    walks.forEach((w, i) => {
      const el = document.createElement('div');
      el.className = 'item';
      el.dataset.id = w.id;
      el.innerHTML = `<span class="dot" style="background:${colorOf(i)}"></span>
        <div class="meta"><div><b>${fmtKm(w.dist)} km</b> · ${fmtTime(w.dur)}</div><small>${fmtDate(w.start)}</small></div>
        <button title="Sil" aria-label="Sil">✕</button>`;
      el.addEventListener('click', () => select(w.id));
      el.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('Bu yürüyüş silinsin mi?')) return;
        walks = walks.filter((x) => x.id !== w.id);
        store.set(KEY_WALKS, walks);
        if (selectedId === w.id) selectedId = null;
        renderList(); drawHistory();
      });
      list.appendChild(el);
    });
    highlightList();
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ app: 'izim', version: 1, walks }, null, 0)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `izim-yedek-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importData(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        const incoming = Array.isArray(data) ? data : data.walks;
        if (!Array.isArray(incoming)) throw new Error();
        const ids = new Set(walks.map((w) => w.id));
        const fresh = incoming.filter((w) => w && w.id && Array.isArray(w.segs) && !ids.has(w.id));
        walks = walks.concat(fresh).sort((a, b) => b.start - a.start);
        store.set(KEY_WALKS, walks);
        renderList(); fitAll();
        alert(`${fresh.length} yürüyüş eklendi.`);
      } catch { alert('Dosya okunamadı.'); }
    };
    r.readAsText(file);
  }

  // ---------- Sekmeler ----------
  let currentTab = 'walk';
  function setTab(tab) {
    currentTab = tab;
    $('tabWalk').classList.toggle('on', tab === 'walk');
    $('tabMap').classList.toggle('on', tab === 'map');
    $('walkPanel').hidden = tab !== 'walk';
    $('mapPanel').hidden = tab !== 'map';
    if (tab === 'map') {
      map.addLayer(historyLayer);
      renderList(); fitAll();
    } else {
      map.removeLayer(historyLayer);
      follow = true;
      if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 16));
    }
  }

  // ---------- Olaylar ----------
  $('bStart').onclick = start;
  $('bPause').onclick = togglePause;
  $('bStop').onclick = stop;
  $('tabWalk').onclick = () => setTab('walk');
  $('tabMap').onclick = () => setTab('map');
  $('bAll').onclick = fitAll;
  $('bExport').onclick = exportData;
  $('bImport').onclick = () => $('fileIn').click();
  $('fileIn').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };
  map.on('dragstart', () => { follow = false; });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && recording()) lockScreen();
  });

  // ---------- Açılış ----------
  if (cur) {
    // Sayfa kapanmış/yenilenmiş: yarım kalan yürüyüşe devam et.
    if (cur.resumedAt) {
      // Kapalı kalan süreyi sayma; yeni bir parça başlat.
      cur.activeMs += Math.max(0, (cur.savedAt || cur.resumedAt) - cur.resumedAt);
      cur.resumedAt = Date.now();
      if (cur.segs[cur.segs.length - 1].length) cur.segs.push([]);
      saveCurrent();
      lockScreen(); startTick();
      note('Yarım kalan yürüyüşe devam ediliyor.');
    }
    drawLive();
  }
  startWatch();
  renderButtons(); renderStats();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
