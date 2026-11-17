/* İzim — yürüdüğün yerleri kaydeden ve keşif haritası çıkaran uygulama.
 * Veriler sadece bu cihazda (localStorage) tutulur.
 */
(() => {
  'use strict';

  // ---------- Ayarlar ----------
  const KEY_WALKS = 'izim.walks.v1';
  const KEY_CURRENT = 'izim.current.v1';
  const KEY_GEO = 'izim.geo.v1';
  const MAX_ACCURACY = 35;  // m — daha kötü GPS okumalarını at
  const MIN_STEP = 4;       // m — titremeyi kaydetme
  const MAX_SPEED = 12;     // m/s — bundan hızlı sıçramalar GPS hatası
  const CELL_Z = 19;        // keşif karesi: ~57 m (İstanbul enleminde)
  const STEP_M = 15;        // yol üzerinde örnekleme aralığı
  const PASS_GAP = 150;     // aynı kareye bu kadar yol sonra dönersen yeni geçiş sayılır
  const LAP_MIN = 200;      // tur sayılması için en kısa döngü (m)
  // Sıralı tek renk (açık → koyu): kaç kez geçildi
  const HEAT = [
    { min: 8, c: '#0d366b', label: '8+ kez' },
    { min: 4, c: '#1c5cab', label: '4–7' },
    { min: 2, c: '#3987e5', label: '2–3' },
    { min: 1, c: '#86b6ef', label: '1 kez' },
  ];
  const ROUTE = '#0f766e';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Depolama ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); return true; }
      catch { note('Kaydedilemedi: depolama dolu olabilir.'); return false; }
    },
    del(key) { try { localStorage.removeItem(key); } catch {} },
  };

  let walks = store.get(KEY_WALKS, []);
  const saveWalks = () => store.set(KEY_WALKS, walks);

  // ---------- Yardımcılar ----------
  function haversine(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  const fmtKm = (m, d = 2) => (m / 1000).toFixed(d).replace('.', ',');
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
  }
  function fmtDur(ms) {
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m} dk` : `${Math.floor(m / 60)} sa ${m % 60} dk`;
  }
  function fmtPace(ms, m) {
    if (m < 50) return '–';
    const v = ms / 60000 / (m / 1000);
    if (!isFinite(v) || v > 99) return '–';
    const mm = Math.floor(v), ss = Math.min(59, Math.round((v - mm) * 60));
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }
  const fmtClock = (t) => new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (t) => new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
  function dayKey(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function dayLabel(key) {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const today = dayKey(Date.now()), yest = dayKey(Date.now() - 864e5);
    if (key === today) return 'Bugün';
    if (key === yest) return 'Dün';
    return date.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  let noteTimer;
  function note(msg, keep) {
    $('note').textContent = msg || '';
    clearTimeout(noteTimer);
    if (msg && !keep) noteTimer = setTimeout(() => ($('note').textContent = ''), 5000);
  }

  // ---------- Keşif kareleri ----------
  function cellXY(lat, lng) {
    const p = L.CRS.EPSG3857.latLngToPoint(L.latLng(lat, lng), CELL_Z);
    return [Math.floor(p.x / 256), Math.floor(p.y / 256)];
  }
  const cellKey = (lat, lng) => cellXY(lat, lng).join(',');
  function cellSizeM(y) {
    const n = Math.PI - 2 * Math.PI * (y + 0.5) / 2 ** CELL_Z;
    const lat = Math.atan(Math.sinh(n));
    return 40075016.686 * Math.cos(lat) / 2 ** CELL_Z;
  }
  function cellCenter(x, y) {
    return L.CRS.EPSG3857.pointToLatLng(L.point((x + 0.5) * 256, (y + 0.5) * 256), CELL_Z);
  }
  const heatOf = (p) => HEAT.find((h) => p >= h.min) || HEAT[HEAT.length - 1];

  // Yol boyunca ~15 m aralıkla örnekle
  function walkPath(segs, cb) {
    let along = 0;
    for (const s of segs) {
      if (s.length) cb(s[0][0], s[0][1], along);
      for (let i = 1; i < s.length; i++) {
        const a = s[i - 1], b = s[i], d = haversine(a, b), n = Math.max(1, Math.ceil(d / STEP_M));
        for (let k = 1; k <= n; k++) cb(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, along + d * k / n);
        along += d;
      }
    }
  }

  // Bir yürüyüşte her kareden kaç kez geçildi + kaç tur atıldı
  function analyzeWalk(segs) {
    const samples = [], last = new Map(), passes = new Map(), passIdx = new Map();
    walkPath(segs, (la, ln, al) => {
      const k = cellKey(la, ln);
      const prev = last.get(k);
      if (prev === undefined || al - prev > PASS_GAP) {
        passes.set(k, (passes.get(k) || 0) + 1);
        if (!passIdx.has(k)) passIdx.set(k, []);
        passIdx.get(k).push({ i: samples.length, al });
      }
      last.set(k, al);
      samples.push(k);
    });
    // Tur: aynı noktaya FARKLI bir yoldan dönmek (aynı yoldan geri dönmek tur değil)
    let laps = 0;
    for (const list of passIdx.values()) {
      if (list.length < 2) continue;
      let n = 0;
      for (let j = 1; j < list.length; j++) {
        const a = list[j - 1], b = list[j];
        if (b.al - a.al < LAP_MIN) continue;
        const mid = (a.i + b.i) >> 1;
        const A = new Set(samples.slice(a.i, mid)), B = new Set(samples.slice(mid, b.i + 1));
        let common = 0;
        for (const k of A) if (B.has(k)) common++;
        if (common / Math.min(A.size, B.size) < 0.5) n++;
      }
      if (n > laps) laps = n;
    }
    return { passes, laps };
  }

  // Tüm yürüyüşlerden keşif haritası
  let cells = new Map();   // "x,y" -> {x,y,p,w,days:Set,first,last}
  let walkMeta = new Map(); // id -> {fresh, laps}
  function buildIndex() {
    cells = new Map(); walkMeta = new Map();
    const sorted = [...walks].sort((a, b) => a.start - b.start);
    for (const w of sorted) {
      const { passes, laps } = analyzeWalk(w.segs);
      const day = dayKey(w.start);
      let fresh = 0;
      for (const [k, n] of passes) {
        let c = cells.get(k);
        if (!c) {
          const [x, y] = k.split(',').map(Number);
          c = { x, y, p: 0, w: 0, days: new Set(), first: w.start, last: w.start };
          cells.set(k, c); fresh++;
        }
        c.p += n; c.w++; c.days.add(day); c.last = w.start;
      }
      walkMeta.set(w.id, { fresh, laps });
    }
  }

  // ---------- Yer adı (OpenStreetMap Nominatim, önbellekli, saniyede 1 istek) ----------
  const geoCache = store.get(KEY_GEO, {});
  let geoQueue = Promise.resolve();
  function placeName(lat, lng) {
    const k = lat.toFixed(3) + ',' + lng.toFixed(3);
    if (geoCache[k]) return Promise.resolve(geoCache[k]);
    const job = geoQueue.then(async () => {
      if (geoCache[k]) return geoCache[k];
      await new Promise((r) => setTimeout(r, 1100));
      try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=tr&lat=${lat}&lon=${lng}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const a = (await res.json()).address || {};
        const parts = [a.neighbourhood || a.suburb || a.quarter || a.village || a.hamlet || a.road,
          a.town || a.city_district || a.county || a.city || a.province].filter(Boolean);
        const name = [...new Set(parts)].join(', ') || null;
        if (name) { geoCache[k] = name; store.set(KEY_GEO, geoCache); }
        return name;
      } catch { return null; }
    });
    geoQueue = job.catch(() => {});
    return job;
  }
  function fillPlaces() {
    walks.filter((w) => !w.place && w.segs[0] && w.segs[0][0]).slice(0, 20).forEach((w) => {
      placeName(w.segs[0][0][0], w.segs[0][0][1]).then((name) => {
        if (!name) return;
        w.place = name; w._s = false; saveWalks(); syncSoon();
        if (tab === 'daily') renderDaily();
      });
    });
  }

  // ---------- Harita ----------
  const map = L.map('map', { zoomControl: false }).setView([39.0, 35.0], 6);
  // Modern harita: OpenFreeMap (ücretsiz, anahtar istemez). Cihaz desteklemezse klasik OSM'e döner.
  (function addBaseMap() {
    const osm = () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    const webgl = (() => {
      try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
    })();
    if (!webgl || !L.maplibreGL || !window.maplibregl) return osm();
    // Stili indirip Google Haritalar tarzı sade renklere çevir (mapstyle.js)
    fetch('https://tiles.openfreemap.org/styles/liberty')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((style) => {
        if (window.izimRestyle) style = window.izimRestyle(style);
        const gl = L.maplibreGL({
          style,
          attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; OpenStreetMap',
        }).addTo(map);
        // Harita çizilemezse klasik haritaya geç
        let fell = false;
        const fallback = () => { if (fell) return; fell = true; map.removeLayer(gl); osm(); };
        const m = gl.getMaplibreMap();
        m.on('error', () => { if (!m.isStyleLoaded()) fallback(); });
        setTimeout(() => { if (!m.isStyleLoaded()) fallback(); }, 12000);
      })
      .catch(() => osm());
  })();
  map.createPane('fog').style.zIndex = 350;
  map.getPane('fog').classList.add('fog-pane');

  // Sis katmanı: gezilmemiş yerler karanlık, gezilenler açık ve kaç kez geçildiğine göre renkli
  const FogLayer = L.Layer.extend({
    onAdd(m) {
      this._c = L.DomUtil.create('canvas', '', m.getPane('fog'));
      this._c.style.position = 'absolute';
      m.on('move zoomend resize viewreset', this.redraw, this);
      m.on('zoomstart', this._hide, this);
      this.redraw();
    },
    onRemove(m) {
      m.off('move zoomend resize viewreset', this.redraw, this);
      m.off('zoomstart', this._hide, this);
      this._c.remove();
    },
    _hide() { this._c.style.visibility = 'hidden'; },
    redraw() {
      const m = this._map; if (!m) return;
      const c = this._c, size = m.getSize(), dpr = window.devicePixelRatio || 1;
      c.style.visibility = '';
      c.width = size.x * dpr; c.height = size.y * dpr;
      c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
      L.DomUtil.setPosition(c, m.containerPointToLayerPoint([0, 0]));
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = 'rgba(20, 28, 36, 0.5)';
      ctx.fillRect(0, 0, size.x, size.y);

      const z = m.getZoom(), scale = 2 ** (z - CELL_Z), s = 256 * scale;
      const o = m.project(m.containerPointToLatLng([0, 0]), z);
      const list = [];
      const add = (x, y, p) => {
        const px = x * s - o.x, py = y * s - o.y;
        if (px > size.x || py > size.y || px + s < 0 || py + s < 0) return;
        list.push([px, py, p]);
      };
      for (const cell of cells.values()) add(cell.x, cell.y, cell.p);
      for (const [k, v] of liveCells) if (!cells.has(k)) add(v.x, v.y, 1);

      const pad = s < 3 ? 1 : 0.5; // küçük ölçekte kareler görünür kalsın
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      for (const [px, py] of list) ctx.fillRect(px - pad, py - pad, s + pad * 2, s + pad * 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.45;
      for (const [px, py, p] of list) { ctx.fillStyle = heatOf(p).c; ctx.fillRect(px - pad, py - pad, s + pad * 2, s + pad * 2); }
      ctx.globalAlpha = 1;
      if (tab === 'explore') renderViewPct();
    },
  });
  const fog = new FogLayer();

  const liveLayer = L.layerGroup().addTo(map);
  const dayLayer = L.layerGroup();
  const liveLine = L.polyline([], { color: ROUTE, weight: 6, opacity: 0.9 }).addTo(liveLayer);
  const meMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18] }), interactive: false });
  const accCircle = L.circle([0, 0], { radius: 0, color: '#2563eb', weight: 1, fillOpacity: 0.08, interactive: false });

  function panelPad() {
    const p = document.querySelector('.panel:not([hidden])');
    const nav = document.querySelector('.nav');
    return { paddingTopLeft: [30, 80], paddingBottomRight: [30, (p ? p.offsetHeight : 200) + (nav ? nav.offsetHeight : 0) + 30] };
  }

  // ---------- Kayıt ----------
  // cur: { start, segs: [[[lat,lng,t],...]], dist, activeMs, resumedAt|null, savedAt }
  let cur = store.get(KEY_CURRENT, null);
  let watchId = null, tick = null, wakeLock = null, follow = true, lastFix = null, geoErr = false;
  let liveCells = new Map(), liveFresh = 0, liveLaps = 0, livePts = 0;
  let lastAcc = null, bestAcc = Infinity; // GPS doğruluğu (m)

  const elapsed = () => (cur ? cur.activeMs + (cur.resumedAt ? Date.now() - cur.resumedAt : 0) : 0);
  const recording = () => !!(cur && cur.resumedAt);
  function saveCurrent() { if (cur) { cur.savedAt = Date.now(); store.set(KEY_CURRENT, cur); } }

  function liveAdd(a, b) {
    const seg = a ? [[a, b]] : [[b]];
    walkPath(seg, (la, ln) => {
      const [x, y] = cellXY(la, ln), k = x + ',' + y;
      if (liveCells.has(k)) return;
      liveCells.set(k, { x, y });
      if (!cells.has(k)) liveFresh++;
    });
  }
  function liveRebuild() {
    liveCells = new Map(); liveFresh = 0; livePts = 0;
    if (!cur) { liveLaps = 0; return; }
    for (const s of cur.segs) s.forEach((p, i) => liveAdd(i ? s[i - 1] : null, p));
    liveLaps = analyzeWalk(cur.segs).laps;
  }

  function renderStats() {
    const d = cur ? cur.dist : 0, t = elapsed();
    $('sDist').textContent = fmtKm(d);
    $('sTime').textContent = fmtTime(t);
    $('sPace').textContent = fmtPace(t, d);
    const parts = [];
    if (!cur || recording()) {
      if (lastAcc === null) parts.push('📡 Konum bekleniyor…');
      else if (lastAcc > MAX_ACCURACY) parts.push(`📡 <b>GPS zayıf</b> (±${Math.round(lastAcc)} m) · açık alana çık`);
      else parts.push(`📡 GPS ${cur ? 'iyi' : 'hazır'} (±${Math.round(lastAcc)} m)`);
    }
    if (cur) parts.push(`<b>${liveFresh}</b> yeni nokta`);
    if (cur && liveLaps) parts.push(`<b>${liveLaps}</b> tur`);
    $('liveExtra').innerHTML = parts.join(' · ');
    renderHr();
  }
  // ---------- Nabız (Bluetooth, standart nabız servisi) ----------
  let hrDev = null, hrNow = null, hrLast = 0;
  function renderHr() {
    const b = $('bHr');
    if (!hrDev) { b.innerHTML = '♥ Nabız bağla'; b.classList.remove('on'); return; }
    b.classList.add('on');
    const fresh = hrNow && Date.now() - hrLast < 10000;
    b.innerHTML = fresh ? `♥ <b>${hrNow}</b> bpm` : '♥ nabız bekleniyor…';
  }
  function onHr(e) {
    const v = e.target.value, flags = v.getUint8(0);
    const bpm = flags & 1 ? v.getUint16(1, true) : v.getUint8(1);
    if (!bpm) return;
    hrNow = bpm; hrLast = Date.now();
    if (recording()) {
      const h = cur.hr || (cur.hr = { sum: 0, n: 0, max: 0, s: [] });
      h.sum += bpm; h.n++; h.max = Math.max(h.max, bpm);
      const t = Math.round(elapsed() / 1000);
      if (!h.s.length || t - h.s[h.s.length - 1][0] >= 10) h.s.push([t, bpm]);
    }
    renderHr();
  }
  async function hrAttach(dev) {
    const server = await dev.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    const ch = await service.getCharacteristic('heart_rate_measurement');
    ch.addEventListener('characteristicvaluechanged', onHr);
    await ch.startNotifications();
  }
  async function hrConnect() {
    if (hrDev) {
      if (!confirm('Nabız cihazının bağlantısı kesilsin mi?')) return;
      const d = hrDev; hrDev = null; hrNow = null;
      try { d.gatt.disconnect(); } catch {}
      renderHr(); return;
    }
    if (!navigator.bluetooth) {
      alert('Bu tarayıcı Bluetooth ile nabız bağlantısını desteklemiyor.\n\nAndroid telefonda Chrome ile açman gerekiyor (iPhone desteklemiyor).');
      return;
    }
    try {
      const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
      hrDev = dev; renderHr();
      dev.addEventListener('gattserverdisconnected', () => {
        if (hrDev !== dev) return;
        hrNow = null; renderHr();
        setTimeout(() => { if (hrDev === dev) hrAttach(dev).catch(() => {}); }, 2000); // bağlantı koparsa tekrar dene
      });
      await hrAttach(dev);
      note(`${dev.name || 'Nabız cihazı'} bağlandı.`);
    } catch (e) {
      hrDev = null; renderHr();
      if (!e || e.name !== 'NotFoundError') note('Nabız cihazına bağlanılamadı. Cihazda nabız yayınının açık olduğundan emin ol.', true);
    }
  }

  function renderButtons() {
    $('bStart').hidden = !!cur;
    $('bPause').hidden = !cur;
    $('bStop').hidden = !cur;
    $('bPause').textContent = recording() ? 'Duraklat' : 'Devam et';
  }
  const drawLive = () => liveLine.setLatLngs(cur ? cur.segs.map((s) => s.map((p) => [p[0], p[1]])) : []);

  function onPosition(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const t = pos.timestamp || Date.now();
    lastFix = [lat, lng];
    if (geoErr) { geoErr = false; note(''); }

    meMarker.setLatLng(lastFix);
    accCircle.setLatLng(lastFix).setRadius(accuracy);
    if (!map.hasLayer(meMarker)) {
      meMarker.addTo(liveLayer); accCircle.addTo(liveLayer);
      if (tab === 'walk') map.setView(lastFix, 17);
    } else if (follow && tab === 'walk') map.panTo(lastFix, { animate: true });

    lastAcc = accuracy;
    if (!recording()) { renderStats(); return; }
    bestAcc = Math.min(bestAcc, accuracy);
    if (accuracy > MAX_ACCURACY) { renderStats(); return; }

    const seg = cur.segs[cur.segs.length - 1];
    const prev = seg[seg.length - 1];
    if (prev) {
      const d = haversine(prev, [lat, lng]);
      if (d < MIN_STEP) return;
      if (d / Math.max(1, (t - prev[2]) / 1000) > MAX_SPEED) return;
      cur.dist += d;
    }
    const p = [+lat.toFixed(6), +lng.toFixed(6), t];
    seg.push(p);
    liveAdd(prev || null, p);
    if (++livePts % 8 === 0) liveLaps = analyzeWalk(cur.segs).laps;
    drawLive(); renderStats(); saveCurrent();
    if (map.hasLayer(fog)) fog.redraw();
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
    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }
  async function lockScreen() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
  function releaseScreen() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
  function startTick() { clearInterval(tick); tick = setInterval(renderStats, 1000); }
  function stopTick() { clearInterval(tick); tick = null; }

  function start() {
    cur = { start: Date.now(), segs: [[]], dist: 0, activeMs: 0, resumedAt: Date.now() };
    bestAcc = Infinity;
    liveRebuild(); saveCurrent();
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
      if (cur.segs[cur.segs.length - 1].length) cur.segs.push([]);
      startWatch(); lockScreen(); startTick();
      note('Devam ediliyor.');
    }
    saveCurrent(); renderButtons(); renderStats();
  }

  function stop() {
    if (!cur) return;
    const segs = cur.segs.filter((s) => s.length >= 2);
    if (!segs.length) {
      const why = lastAcc === null
        ? 'Konum hiç alınamadı. Konum izninin açık olduğundan emin ol.'
        : bestAcc > MAX_ACCURACY
          ? `GPS sinyali zayıf olduğu için yol çizilemedi (en iyi ±${Math.round(bestAcc)} m). Ev içinde GPS düzgün çalışmaz; dışarıda, açık havada dene.`
          : 'Yol çizilecek kadar yürünmedi. Birkaç on metre yürüdükten sonra bitir.';
      if (!confirm(why + '\n\nBu yürüyüş kaydedilmeden bitirilsin mi?')) { renderButtons(); return; }
    } else {
      if (cur.resumedAt) { cur.activeMs += Date.now() - cur.resumedAt; cur.resumedAt = null; }
      const w = {
        id: cur.start.toString(36), start: cur.start, end: Date.now(),
        dist: Math.round(cur.dist), dur: cur.activeMs,
        segs: segs.map((s) => s.map((p) => [p[0], p[1]])),
      };
      if (cur.hr && cur.hr.n) w.hr = { avg: Math.round(cur.hr.sum / cur.hr.n), max: cur.hr.max, s: cur.hr.s };
      walks.unshift(w);
      saveWalks(); syncSoon();
      buildIndex();
      const m = walkMeta.get(w.id);
      note(`Kaydedildi: ${fmtKm(w.dist)} km · ${fmtTime(w.dur)} · ${m.fresh} yeni nokta${m.laps ? ` · ${m.laps} tur` : ''}`);
      fillPlaces();
    }
    cur = null;
    store.del(KEY_CURRENT);
    liveRebuild(); stopTick(); releaseScreen();
    drawLive(); renderButtons(); renderStats();
    if (map.hasLayer(fog)) fog.redraw();
  }

  // ---------- Keşif ----------
  function renderLegend() {
    $('legend').innerHTML = [...HEAT].reverse()
      .map((h) => `<span><i style="background:${h.c}"></i>${h.label}</span>`).join('') +
      '<span><i style="background:rgba(20,28,36,.5)"></i>gidilmedi</span>';
  }

  function renderViewPct() {
    const z = map.getZoom();
    if (z < 14) { $('eView').textContent = '–'; $('eView').title = 'Yakınlaştır'; return; }
    const b = map.getBounds();
    const [x0, y0] = cellXY(b.getNorth(), b.getWest()), [x1, y1] = cellXY(b.getSouth(), b.getEast());
    const total = (x1 - x0 + 1) * (y1 - y0 + 1);
    let seen = 0;
    for (const c of cells.values()) if (c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1) seen++;
    const pct = (seen / total) * 100;
    $('eView').textContent = (pct > 0 && pct < 1 ? '<1' : Math.round(pct)) + '%';
  }

  function hotspots() {
    // ~450 m'lik bölgelerde toplam geçiş
    const groups = new Map();
    for (const c of cells.values()) {
      const k = (c.x >> 3) + ',' + (c.y >> 3);
      const g = groups.get(k) || { score: 0, best: c, days: new Set() };
      g.score += c.p;
      if (c.p > g.best.p) g.best = c;
      c.days.forEach((d) => g.days.add(d));
      groups.set(k, g);
    }
    return [...groups.values()].sort((a, b) => b.best.p - a.best.p || b.score - a.score).slice(0, 3);
  }

  function renderExplore() {
    let area = 0;
    for (const c of cells.values()) area += cellSizeM(c.y) ** 2;
    $('eArea').textContent = (area / 1e6).toFixed(2).replace('.', ',');
    $('eCells').textContent = cells.size.toLocaleString('tr-TR');
    renderViewPct();

    const box = $('hots');
    const hs = hotspots();
    if (!hs.length) { box.innerHTML = '<div class="empty">Yürüdükçe en sık gittiğin yerler burada çıkacak.</div>'; return; }
    box.innerHTML = '';
    hs.forEach((g, i) => {
      const ll = cellCenter(g.best.x, g.best.y);
      const el = document.createElement('div');
      el.className = 'hot';
      el.innerHTML = `<span class="n">${i + 1}</span><div class="meta"><div class="name">Yer adı alınıyor…</div>
        <small class="muted">${g.best.p} kez geçtin · ${g.days.size} farklı gün</small></div>`;
      el.onclick = () => { map.setView(ll, 17); showCellPopup(ll); };
      box.appendChild(el);
      placeName(ll.lat, ll.lng).then((n) => { el.querySelector('.name').textContent = n || `${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}`; });
    });
  }

  function showCellPopup(ll) {
    const k = cellKey(ll.lat, ll.lng), c = cells.get(k);
    const html = c
      ? `<b>Buradan ${c.p} kez geçtin</b><br>${c.w} farklı yürüyüş · ${c.days.size} farklı gün<br>
         <span style="color:#5d6b66">İlk: ${fmtDay(c.first)}<br>Son: ${fmtDay(c.last)}</span>`
      : (liveCells.has(k) ? '<b>Burayı şu an keşfediyorsun</b>' : 'Burada henüz yürümedin.');
    L.popup({ closeButton: false, autoPanPaddingBottomRight: [20, 220] }).setLatLng(ll).setContent(html).openOn(map);
  }
  map.on('click', (e) => { if (tab === 'explore' || tab === 'walk') showCellPopup(e.latlng); });

  // ---------- Günlük ----------
  let openDay = null;

  function groupDays() {
    const days = new Map();
    for (const w of walks) {
      const k = dayKey(w.start);
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(w);
    }
    for (const list of days.values()) list.sort((a, b) => a.start - b.start);
    return [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }

  function streak(dayset) {
    let n = 0, t = Date.now();
    if (!dayset.has(dayKey(t))) t -= 864e5; // bugün henüz yürümediysen dünden say
    while (dayset.has(dayKey(t))) { n++; t -= 864e5; }
    return n;
  }

  function renderTiles(days) {
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime();
    const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let wk = 0, mo = 0, tot = 0;
    for (const w of walks) { tot += w.dist; if (w.start >= monday) wk += w.dist; if (w.start >= month) mo += w.dist; }
    $('dWeek').textContent = fmtKm(wk, 1);
    $('dMonth').textContent = fmtKm(mo, 1);
    $('dTotal').textContent = fmtKm(tot, 1);
    $('dStreak').textContent = streak(new Set(days.map((d) => d[0])));
  }

  function renderChart() {
    const box = $('chart'), tip = $('tip');
    box.querySelector('svg')?.remove();
    const perDay = new Map();
    for (const w of walks) { const k = dayKey(w.start); perDay.set(k, (perDay.get(k) || 0) + w.dist); }
    const data = [];
    for (let i = 13; i >= 0; i--) {
      const t = Date.now() - i * 864e5;
      data.push({ k: dayKey(t), t, m: perDay.get(dayKey(t)) || 0 });
    }
    const W = Math.max(260, box.clientWidth || 300), H = 110, top = 16, base = 88, gap = 4;
    const bw = (W - gap * 13) / 14;
    const max = Math.max(1000, ...data.map((d) => d.m));
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim(), muted = css.getPropertyValue('--muted').trim(), line = css.getPropertyValue('--line').trim();
    const letters = ['P', 'P', 'S', 'Ç', 'P', 'C', 'C']; // Pazar..Cumartesi
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Son 14 günde yürünen kilometre">`;
    svg += `<text x="0" y="10" font-size="11" fill="${muted}">${fmtKm(max, 1)} km</text>`;
    svg += `<line x1="0" x2="${W}" y1="${top}" y2="${top}" stroke="${line}" stroke-dasharray="3 3"/>`;
    data.forEach((d, i) => {
      const x = i * (bw + gap), h = d.m ? Math.max(3, (d.m / max) * (base - top)) : 0, y = base - h, r = Math.min(4, bw / 2, h);
      if (h) svg += `<path d="M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${base} Z" fill="${accent}"/>`;
      const today = i === 13;
      svg += `<text x="${x + bw / 2}" y="${base + 16}" font-size="11" text-anchor="middle" fill="${today ? accent : muted}" font-weight="${today ? 700 : 400}">${letters[new Date(d.t).getDay()]}</text>`;
      svg += `<rect data-i="${i}" x="${x - gap / 2}" y="0" width="${bw + gap}" height="${H}" fill="transparent"/>`;
    });
    svg += `<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="${muted}" stroke-opacity=".5"/></svg>`;
    box.insertAdjacentHTML('beforeend', svg);
    const el = box.querySelector('svg');
    const show = (e) => {
      const i = e.target.dataset && e.target.dataset.i;
      if (i === undefined) { tip.hidden = true; return; }
      const d = data[+i], x = (+i * (bw + gap) + bw / 2) / W * el.clientWidth;
      tip.textContent = `${new Date(d.t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', weekday: 'short' })}: ${d.m ? fmtKm(d.m) + ' km' : 'yürüyüş yok'}`;
      tip.style.left = Math.min(Math.max(x, 60), el.clientWidth - 60) + 'px';
      tip.hidden = false;
    };
    el.addEventListener('pointermove', show);
    el.addEventListener('pointerdown', show);
    el.addEventListener('pointerleave', () => (tip.hidden = true));
  }

  function renderDaily() {
    const days = groupDays();
    renderTiles(days);
    renderChart();
    const box = $('days');
    box.innerHTML = '';
    if (!days.length) {
      box.innerHTML = '<div class="empty">Henüz yürüyüş yok. İlk yürüyüşünü kaydet, günlüğün burada birikecek.</div>';
      return;
    }
    for (const [k, list] of days) {
      const dist = list.reduce((s, w) => s + w.dist, 0), dur = list.reduce((s, w) => s + w.dur, 0);
      const fresh = list.reduce((s, w) => s + (walkMeta.get(w.id)?.fresh || 0), 0);
      const laps = list.reduce((s, w) => s + (walkMeta.get(w.id)?.laps || 0), 0);
      const places = [...new Set(list.map((w) => w.place).filter(Boolean))];
      const el = document.createElement('div');
      el.className = 'day' + (openDay === k ? ' on' : '');
      el.innerHTML = `<div class="day-head">
          <div class="l1"><span>${esc(dayLabel(k))}</span><span>${fmtKm(dist)} km</span></div>
          <div class="l2">${list.length} yürüyüş · ${fmtDur(dur)} · ${fmtClock(list[0].start)}–${fmtClock(list[list.length - 1].end)}${laps ? ` · ${laps} tur` : ''}</div>
          <div class="l3">${places.length ? '📍 ' + esc(places.join(' → ')) : '<span class="muted">Konum adı alınıyor…</span>'}${fresh ? ` <span class="badge">+${fresh} yeni nokta</span>` : ''}</div>
        </div>`;
      el.querySelector('.day-head').onclick = () => selectDay(openDay === k ? null : k);
      if (openDay === k) {
        const wl = document.createElement('div');
        wl.className = 'day-walks';
        for (const w of list) {
          const m = walkMeta.get(w.id) || {};
          const row = document.createElement('div');
          row.className = 'walk';
          row.innerHTML = `<div class="meta"><div><b>${fmtClock(w.start)}</b> · ${fmtKm(w.dist)} km · ${fmtDur(w.dur)} · ${fmtPace(w.dur, w.dist)} dk/km
              ${m.laps ? `<span class="badge">${m.laps} tur</span>` : ''}${w.source === 'polar' ? `<span class="badge">Polar · ${esc(w.sport || 'antrenman')}</span>` : ''}</div>
              ${w.hr ? `<small style="color:#be123c">♥ ort ${w.hr.avg} · en yüksek ${w.hr.max} bpm</small><br>` : ''}
              <small>${esc(w.place || '')}${m.fresh ? `${w.place ? ' · ' : ''}${m.fresh} yeni nokta` : ''}</small></div>
            <button title="Sil" aria-label="Sil">✕</button>`;
          row.querySelector('button').onclick = () => {
            if (!confirm('Bu yürüyüş silinsin mi?')) return;
            walks = walks.filter((x) => x.id !== w.id);
            markDeleted(w.id);
            saveWalks(); buildIndex(); syncSoon();
            if (!walks.some((x) => dayKey(x.start) === k)) openDay = null;
            renderDaily(); drawDay();
          };
          wl.appendChild(row);
        }
        el.appendChild(wl);
      }
      box.appendChild(el);
    }
  }

  function drawDay() {
    dayLayer.clearLayers();
    const list = openDay ? walks.filter((w) => dayKey(w.start) === openDay) : walks;
    for (const w of list) {
      L.polyline(w.segs, { color: ROUTE, weight: openDay ? 6 : 4, opacity: openDay ? 0.9 : 0.55, lineCap: 'round', lineJoin: 'round' })
        .on('click', () => selectDay(dayKey(w.start)))
        .addTo(dayLayer);
    }
    const pts = list.flatMap((w) => w.segs.flat());
    if (pts.length) map.fitBounds(L.latLngBounds(pts), panelPad());
  }

  function selectDay(k) {
    openDay = k;
    renderDaily(); drawDay();
  }

  // ---------- Yedek ----------
  function exportData() {
    const blob = new Blob([JSON.stringify({ app: 'izim', version: 1, walks: walks.map(clean) })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `izim-yedek-${dayKey(Date.now())}.json`;
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
        const fresh = incoming.filter((w) => w && w.id && Array.isArray(w.segs) && !ids.has(w.id)).map((w) => ({ ...w, _s: false }));
        walks = walks.concat(fresh).sort((a, b) => b.start - a.start);
        saveWalks(); buildIndex(); renderDaily(); drawDay(); syncSoon();
        alert(`${fresh.length} yürüyüş eklendi.`);
      } catch { alert('Dosya okunamadı.'); }
    };
    r.readAsText(file);
  }

  // ---------- Bulut eşitleme (Supabase) ----------
  // Telefon her zaman ana kayıttır: internet yokken de çalışır, bağlantı gelince eşitler.
  const SB_URL = 'https://ihvzwkpnhihmbzdvljvf.supabase.co';
  const SB_KEY = 'sb_publishable_PipYjTO8bk6678h49Aw5Sg_DGJaEoS1'; // herkese açık anahtar (gizli değil)
  const KEY_TOMB = 'izim.deleted.v1';
  const KEY_PULL = 'izim.pulled.v1.';
  const KEY_PENDING = 'izim.pendingMail.v1';
  let sb = null, user = null, syncing = false, syncAgain = false, syncMsg = '', syncTimer = null, authNotice = '';
  let pending = store.get(KEY_PENDING, null); // { email, t } — bağlantı gönderildi, henüz tıklanmadı
  if (pending && Date.now() - pending.t > 3600e3) { pending = null; store.del(KEY_PENDING); }
  // E-postadaki bağlantıdan mı gelindi?
  const urlInfo = (() => {
    const h = new URLSearchParams(location.hash.slice(1)), q = new URLSearchParams(location.search);
    return {
      error: h.get('error_description') || q.get('error_description'),
      login: h.has('access_token') || q.has('code'),
    };
  })();
  if (urlInfo.error) {
    authNotice = 'Bu giriş bağlantısı geçersiz ya da süresi dolmuş. Aşağıdan yeni bağlantı iste.';
    try { history.replaceState(null, '', location.pathname); } catch {}
  }
  try {
    if (window.supabase) sb = window.supabase.createClient(SB_URL, SB_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  } catch { sb = null; }
  let tombs = store.get(KEY_TOMB, []);

  function clean(w) { const { _s, ...rest } = w; return rest; }
  function markDeleted(id) { if (!tombs.includes(id)) { tombs.push(id); store.set(KEY_TOMB, tombs); } }
  function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 800); }
  function setSync(msg) { syncMsg = msg; renderAccount(); }

  function refreshViews() {
    if (tab === 'daily') { renderDaily(); drawDay(); }
    if (tab === 'explore') renderExplore();
    if (map.hasLayer(fog)) fog.redraw();
  }

  async function sync() {
    if (!sb || !user) return;
    if (!navigator.onLine) { setSync('Çevrimdışı · bağlantı gelince eşitlenecek'); return; }
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    setSync('Eşitleniyor…');
    try {
      // 1) Bu cihazda silinenler
      if (tombs.length) {
        const sent = [...tombs];
        const rows = sent.map((id) => ({
          user_id: user.id, id, deleted: true, data: {},
          start_at: new Date(parseInt(id, 36) || Date.now()).toISOString(),
        }));
        const { error } = await sb.from('walks').upsert(rows, { onConflict: 'user_id,id' });
        if (error) throw error;
        tombs = tombs.filter((id) => !sent.includes(id));
        store.set(KEY_TOMB, tombs);
      }
      // 2) Henüz yüklenmemiş yürüyüşler
      const pending = walks.filter((w) => !w._s);
      for (let i = 0; i < pending.length; i += 50) {
        const chunk = pending.slice(i, i + 50);
        const { error } = await sb.from('walks').upsert(chunk.map((w) => ({
          user_id: user.id, id: w.id, deleted: false, data: clean(w), start_at: new Date(w.start).toISOString(),
        })), { onConflict: 'user_id,id' });
        if (error) throw error;
        chunk.forEach((w) => (w._s = true));
        saveWalks();
      }
      // 3) Diğer cihazlardan gelen değişiklikler
      const since = store.get(KEY_PULL + user.id, '1970-01-01T00:00:00+00:00');
      let latest = since, changed = false;
      for (let from = 0; ; from += 500) {
        const { data, error } = await sb.from('walks').select('id,data,deleted,updated_at')
          .gt('updated_at', since).order('updated_at', { ascending: true }).range(from, from + 499);
        if (error) throw error;
        for (const r of data) {
          const i = walks.findIndex((w) => w.id === r.id);
          if (r.deleted) {
            if (i >= 0) { walks.splice(i, 1); changed = true; }
          } else if (r.data && Array.isArray(r.data.segs)) {
            const incoming = { ...r.data, id: r.id, _s: true };
            if (i < 0) { walks.push(incoming); changed = true; }
            else if (walks[i]._s) { walks[i] = incoming; changed = true; }
          }
          if (new Date(r.updated_at) > new Date(latest)) latest = r.updated_at;
        }
        if (data.length < 500) break;
      }
      store.set(KEY_PULL + user.id, latest);
      if (changed) {
        walks.sort((a, b) => b.start - a.start);
        saveWalks(); buildIndex(); refreshViews();
      }
      setSync('Eşitlendi ✓');
    } catch (e) {
      console.warn('Eşitleme hatası', e);
      setSync('Eşitlenemedi · sonra tekrar denenecek');
    }
    syncing = false;
    if (syncAgain) { syncAgain = false; sync(); }
  }

  async function sendLink(email, btn) {
    if (btn) { btn.disabled = true; btn.dataset.t = btn.textContent; btn.textContent = 'Gönderiliyor…'; }
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.t; }
    if (error) {
      alert(/rate|limit|seconds/i.test(error.message) ? 'Çok sık denendi. Birkaç dakika bekleyip tekrar dene.' : 'Gönderilemedi: ' + error.message);
      return;
    }
    authNotice = '';
    pending = { email, t: Date.now() };
    store.set(KEY_PENDING, pending);
    renderAccount();
  }

  function renderAccount() {
    const box = $('account');
    if (!box) return;
    if (!sb) { box.innerHTML = '<div class="muted">Bulut bağlantısı yüklenemedi. İnternet bağlantını kontrol et.</div>'; return; }
    const notice = authNotice ? `<p class="muted" style="margin:0 0 10px;color:var(--danger)">${esc(authNotice)}</p>` : '';
    if (user) {
      const warn = /Eşitlenemedi|Çevrimdışı/.test(syncMsg);
      box.innerHTML = `${notice}<div class="acc-head">
          <div class="avatar">${esc((user.email || '?')[0].toUpperCase())}</div>
          <div class="meta"><b>${esc(user.email || 'Hesap')}</b>
            <span class="muted"><span class="status-dot${warn ? ' warn' : ''}"></span>${esc(syncMsg || 'Bulutta yedekleniyor')}</span></div>
        </div>
        <div class="acc-actions"><button class="link" id="accSync">Şimdi eşitle</button>
          <button class="link" id="accOut" style="color:var(--muted)">Çıkış yap</button></div>`;
      $('accSync').onclick = () => sync();
      $('accOut').onclick = async () => {
        if (!confirm('Çıkış yapılsın mı? Yürüyüşlerin bu telefonda kalır.')) return;
        await sb.auth.signOut();
      };
      return;
    }
    if (pending) {
      box.innerHTML = `${notice}<div class="acc-head">
          <div class="avatar" style="background:#d97706">✉</div>
          <div class="meta"><b>E-postanı kontrol et</b><span class="muted">${esc(pending.email)}</span></div>
        </div>
        <p class="muted" style="margin:10px 0 0">Giriş <b>henüz tamamlanmadı</b>. E-postadaki giriş bağlantısına bu telefonda dokun.
          Bir kez giriş yapınca uygulama seni hep girişli tutar.</p>
        <div class="acc-actions"><button class="link" id="accResend">Tekrar gönder</button>
          <button class="link" id="accBack" style="color:var(--muted)">Farklı e-posta</button></div>`;
      $('accResend').onclick = (e) => sendLink(pending.email, e.target);
      $('accBack').onclick = () => { pending = null; store.del(KEY_PENDING); renderAccount(); };
      return;
    }
    box.innerHTML = `${notice}<div class="acc-head">
        <div class="avatar" style="background:var(--muted)">☁</div>
        <div class="meta"><b>Giriş yapılmadı</b><span class="muted">Yürüyüşlerin şu an sadece bu telefonda</span></div>
      </div>
      <form id="accForm">
        <input type="email" id="accEmail" required placeholder="E-posta adresin" autocomplete="email">
        <button class="btn small">Giriş bağlantısı gönder</button>
      </form>`;
    $('accForm').onsubmit = (e) => { e.preventDefault(); sendLink($('accEmail').value.trim(), e.target.querySelector('button')); };
  }

  // ---------- Polar (saatle kaydedilen rotaları al) ----------
  const POLAR_CLIENT_ID = 'f8fad51a-0852-4b12-b466-cea873bd086d';
  const POLAR_REDIRECT = SB_URL + '/functions/v1/polar-callback';
  const KEY_POLAR_STATE = 'izim.polarState.v1';
  const KEY_POLAR_AUTO = 'izim.polarAuto.v1';
  const polar = { linked: null, last: null, busy: false, msg: '' };
  const polarUrl = (() => {
    const q = new URLSearchParams(location.search);
    return { code: q.get('polar_code'), state: q.get('polar_state'), error: q.get('polar_error'), used: false };
  })();
  if (polarUrl.code || polarUrl.error) { try { history.replaceState(null, '', location.pathname); } catch {} }

  async function polarCall(action, extra) {
    const { data, error } = await sb.functions.invoke('polar', { body: { action, ...(extra || {}) } });
    if (error) {
      let detail = '';
      try { detail = (await error.context.json()).error; } catch {}
      throw new Error(detail || error.message || 'bilinmeyen');
    }
    return data;
  }
  function polarErr(m) {
    return {
      missing_secret: 'Supabase\'de Polar gizli anahtarı bulunamadı. Adı POLAR_CLIENT_SECRET olmalı.',
      token_failed: 'Polar izni doğrulanamadı. Tekrar bağlamayı dene.',
      register_failed: 'Polar kaydı yapılamadı. Biraz sonra tekrar dene.',
      polar_unauthorized: 'Polar bağlantısının yetkisi kalkmış. Bağlantıyı kaldırıp yeniden bağla.',
      not_signed_in: 'Önce giriş yapmalısın.',
    }[m] || (/Failed to send|fetch/i.test(m) ? 'Polar sunucu fonksiyonuna ulaşılamadı. Fonksiyon yayınlanmış mı?' : 'Polar hatası: ' + m);
  }
  async function polarStatus() {
    if (!sb || !user) return;
    let data = null, error = null;
    try { ({ data, error } = await sb.from('polar_links').select('polar_user_id,last_sync').maybeSingle()); }
    catch (e) { error = e; }
    if (error) {
      polar.linked = false;
      polar.msg = /polar_links|schema cache|does not exist/i.test(String(error.message)) ? 'Polar tablosu henüz kurulmamış (supabase/polar.sql).' : '';
    } else {
      polar.linked = !!data; polar.last = data ? data.last_sync : null;
    }
    renderPolar();
  }
  async function polarSync(manual) {
    if (!user || polar.busy) return;
    polar.busy = true; polar.msg = 'Polar\'dan antrenmanlar çekiliyor…'; renderPolar();
    try {
      const r = await polarCall('sync');
      if (r.linked === false) { polar.linked = false; polar.msg = ''; }
      else {
        polar.last = new Date().toISOString();
        polar.msg = r.imported ? `${r.imported} yeni rota eklendi.` : (manual ? 'Yeni rotalı antrenman yok.' : '');
        store.set(KEY_POLAR_AUTO, Date.now());
        if (r.imported) await sync();
      }
    } catch (e) { polar.msg = polarErr(e.message); }
    polar.busy = false; renderPolar();
  }
  function polarConnect() {
    const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    store.set(KEY_POLAR_STATE, st);
    const u = new URL('https://flow.polar.com/oauth2/authorization');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', POLAR_CLIENT_ID);
    u.searchParams.set('redirect_uri', POLAR_REDIRECT);
    u.searchParams.set('state', st);
    location.href = u.toString();
  }
  async function polarFinish() {
    if (polarUrl.used) return;
    polarUrl.used = true;
    const expected = store.get(KEY_POLAR_STATE, null);
    store.del(KEY_POLAR_STATE);
    if (polarUrl.error) { polar.msg = 'Polar izni verilmedi.'; renderPolar(); return; }
    if (!expected || expected !== polarUrl.state) { polar.msg = 'Polar bağlantısı doğrulanamadı, tekrar dene.'; renderPolar(); return; }
    polar.busy = true; polar.msg = 'Polar bağlanıyor…'; renderPolar();
    try {
      const r = await polarCall('connect', { code: polarUrl.code });
      polar.linked = true; polar.last = new Date().toISOString();
      polar.msg = 'Polar bağlandı ✓ ' + (r.imported ? `${r.imported} rota eklendi.` : 'Yeni antrenmanların geldikçe eklenecek.');
      store.set(KEY_POLAR_AUTO, Date.now());
      if (r.imported) await sync();
    } catch (e) { polar.msg = polarErr(e.message); }
    polar.busy = false; renderPolar();
  }
  async function polarUnlink() {
    if (!confirm('Polar bağlantısı kaldırılsın mı? Daha önce gelen rotalar kalır.')) return;
    polar.busy = true; renderPolar();
    try { await polarCall('unlink'); polar.linked = false; polar.msg = 'Polar bağlantısı kaldırıldı.'; }
    catch (e) { polar.msg = polarErr(e.message); }
    polar.busy = false; renderPolar();
  }
  function renderPolar() {
    const box = $('polarBox');
    if (!box) return;
    const msg = polar.msg ? `<p class="muted" style="margin:8px 0 0">${esc(polar.msg)}</p>` : '';
    const head = (t, s, ok) => `<div class="acc-head"><div class="avatar" style="background:${ok ? '#d6001c' : 'var(--muted)'}">P</div>
      <div class="meta"><b>${t}</b><span class="muted">${s}</span></div></div>`;
    if (!sb || !user) { box.innerHTML = head('Polar bağlı değil', 'Bağlamak için önce yukarıdan giriş yap', false) + msg; return; }
    if (polar.linked === null) { box.innerHTML = head('Polar', 'Durum kontrol ediliyor…', false) + msg; return; }
    const dis = polar.busy ? ' disabled' : '';
    if (!polar.linked) {
      box.innerHTML = head('Polar bağlı değil', 'Saatinle kaydettiğin rotalar otomatik gelsin', false) + msg +
        `<button class="btn small" id="polConnect" style="width:100%;margin-top:10px"${dis}>Polar hesabını bağla</button>`;
      $('polConnect').onclick = polarConnect;
      return;
    }
    const last = polar.last ? new Date(polar.last).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'henüz yok';
    box.innerHTML = head('Polar bağlı ✓', `Son çekme: ${last}`, true) + msg +
      `<div class="acc-actions"><button class="link" id="polSync"${dis}>Antrenmanları çek</button>
       <button class="link" id="polUnlink" style="color:var(--muted)"${dis}>Bağlantıyı kaldır</button></div>`;
    $('polSync').onclick = () => polarSync(true);
    $('polUnlink').onclick = polarUnlink;
  }

  if (sb) {
    sb.auth.onAuthStateChange((event, session) => {
      const was = user && user.id;
      user = session ? session.user : null;
      if (!user) syncMsg = '';
      if (user && pending) { pending = null; store.del(KEY_PENDING); }
      if (user && !was && urlInfo.login) { authNotice = ''; syncMsg = 'Giriş yapıldı ✓'; setTab('settings'); }
      renderAccount();
      if (!user) { polar.linked = null; renderPolar(); }
      if (user && user.id !== was) setTimeout(async () => {
        await sync();
        await polarStatus();
        if (polarUrl.code || polarUrl.error) { setTab('settings'); polarFinish(); }
        else if (polar.linked && Date.now() - store.get(KEY_POLAR_AUTO, 0) > 3600e3) polarSync(false);
      }, 0);
      if (!user && event === 'INITIAL_SESSION' && (polarUrl.code || polarUrl.error)) {
        polar.msg = 'Polar\'ı bağlamak için önce giriş yap.'; setTab('settings');
      }
    });
    window.addEventListener('online', syncSoon);
  }

  // ---------- Sekmeler ----------
  let tab = 'walk';
  function setTab(t) {
    tab = t;
    document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    ['walk', 'explore', 'daily', 'settings'].forEach((n) => ($('p-' + n).hidden = n !== t));
    if (t === 'settings') { renderAccount(); renderPolar(); }
    map.closePopup();

    if (t === 'daily') { map.removeLayer(fog); map.addLayer(dayLayer); fillPlaces(); renderDaily(); drawDay(); }
    else { map.removeLayer(dayLayer); map.addLayer(fog); }

    if (t === 'explore') {
      renderExplore();
      const all = [...cells.values()].map((c) => cellCenter(c.x, c.y));
      if (all.length) map.fitBounds(L.latLngBounds(all), { ...panelPad(), maxZoom: 16 });
    }
    if (t === 'walk') {
      follow = true;
      if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 16));
    }
  }

  // ---------- Olaylar ----------
  $('bStart').onclick = start;
  $('bPause').onclick = togglePause;
  $('bStop').onclick = stop;
  $('bHr').onclick = hrConnect;
  document.querySelectorAll('.nav button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $('bExport').onclick = exportData;
  $('bImport').onclick = () => $('fileIn').click();
  $('fileIn').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };
  map.on('dragstart', () => { follow = false; $('bLocate').classList.remove('on'); });
  $('bLocate').onclick = () => {
    follow = true; $('bLocate').classList.add('on');
    if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 17));
    else note('Konum henüz alınamadı.');
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && recording()) lockScreen();
    if (document.visibilityState === 'visible') syncSoon();
  });

  // ---------- Açılış ----------
  buildIndex();
  renderLegend();
  renderAccount();
  if (cur) {
    if (cur.resumedAt) {
      // Sayfa kapanmıştı: kapalı kalan süreyi sayma, yeni parça başlat
      cur.activeMs += Math.max(0, (cur.savedAt || cur.resumedAt) - cur.resumedAt);
      cur.resumedAt = Date.now();
      if (cur.segs[cur.segs.length - 1].length) cur.segs.push([]);
      saveCurrent(); lockScreen(); startTick();
      note('Yarım kalan yürüyüşe devam ediliyor.');
    }
    liveRebuild(); drawLive();
  }
  map.addLayer(fog);
  startWatch();
  renderButtons(); renderStats();
  fillPlaces();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
