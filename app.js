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
  // Harita modu: 'normal' (her yer açık, yollar çizgi) | 'kesif' (kara kapalı, gezdikçe açılır, deniz açık)
  const KEY_MODE = 'izim.mode.v1';
  let mode = store.get(KEY_MODE, 'normal');
  const FOG_COLOR = '#b8c2c9', FOG_EDGE = '#94a1ab';
  // Araç yolları: istatistiklere karışmaz; haritada kesikli mor çizgi; ayarlardan gizlenebilir
  const KEY_SHOWCAR = 'izim.showCar.v1';
  let showCar = store.get(KEY_SHOWCAR, true);
  const CAR = '#7c3aed';
  const isCar = (w) => w.type === 'arac';
  const footWalks = () => walks.filter((w) => !isCar(w));
  const visibleWalks = () => (showCar ? walks : footWalks());

  // Antrenman tercihleri
  const KEY_PREFS = 'izim.prefs.v1';
  const prefs = Object.assign({ voice: true, autoPause: true, goal: 10, age: null }, store.get(KEY_PREFS, {}));
  const savePrefs = () => store.set(KEY_PREFS, prefs);

  // Sesli bildirim (telefonun Türkçe sesiyle)
  function say(text) {
    if (!prefs.voice || !('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'tr-TR'; u.rate = 1;
      window.speechSynthesis.speak(u);
    } catch {}
  }
  function spokenDur(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return [h && `${h} saat`, m && `${m} dakika`, !h && s && `${s} saniye`].filter(Boolean).join(' ') || '0 saniye';
  }

  // Nabız bölgeleri (en yüksek nabız: 208 − 0,7 × yaş)
  const ZONES = [
    { n: 1, lo: 0, name: 'Çok hafif', c: '#fecdd3' },
    { n: 2, lo: 0.6, name: 'Hafif · yağ yakma', c: '#fda4af' },
    { n: 3, lo: 0.7, name: 'Orta · dayanıklılık', c: '#fb7185' },
    { n: 4, lo: 0.8, name: 'Zorlu', c: '#e11d48' },
    { n: 5, lo: 0.9, name: 'En yüksek', c: '#9f1239' },
  ];
  const hrMax = () => (prefs.age ? Math.round(208 - 0.7 * prefs.age) : null);
  function zoneOf(bpm) {
    const mx = hrMax();
    if (!mx) return null;
    const pct = bpm / mx;
    let z = ZONES[0];
    for (const zz of ZONES) if (pct >= zz.lo) z = zz;
    return z;
  }
  // Örneklerden her bölgede geçen süre (saniye)
  function zoneTimes(s) {
    const out = ZONES.map(() => 0);
    for (let i = 0; i < s.length; i++) {
      const dt = i + 1 < s.length ? Math.min(30, s[i + 1][0] - s[i][0]) : 10;
      const z = zoneOf(s[i][1]);
      if (z && dt > 0) out[z.n - 1] += dt;
    }
    return out;
  }
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
  let carCells = new Set();
  function buildIndex() {
    cells = new Map(); walkMeta = new Map(); carCells = new Set();
    for (const w of walks) if (isCar(w)) walkPath(w.segs, (la, ln) => carCells.add(cellKey(la, ln)));
    const sorted = footWalks().sort((a, b) => a.start - b.start);
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
    if (typeof routesLayer !== 'undefined') onIndexChanged();
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
        if (tab === 'daily' && !detailId) { if (dailyView === 'list') renderList(); else renderDaily(); }
      });
    });
  }

  // ---------- Harita ----------
  const map = L.map('map', { zoomControl: false }).setView([39.0, 35.0], 6);
  let glMap = null, glFogReady = false; // MapLibre haritası ve sis katmanı hazır mı
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
        const fallback = () => { if (fell) return; fell = true; glMap = null; glFogReady = false; map.removeLayer(gl); osm(); applyMode(); };
        const m = gl.getMaplibreMap();
        glMap = m;
        if (m.isStyleLoaded()) setupGlFog(); else m.once('load', setupGlFog);
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
      const darkFog = mode === 'kesif' && !glFogReady; // MapLibre yoksa eski usul sis
      const tint = tab === 'explore' || darkFog;        // kaç kez geçildiği renkleri
      if (darkFog) { ctx.fillStyle = 'rgba(20, 28, 36, 0.5)'; ctx.fillRect(0, 0, size.x, size.y); }
      if (!tint) { if (tab === 'explore') renderViewPct(); return; }

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
      if (darkFog) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = '#000';
        for (const [px, py] of list) ctx.fillRect(px - pad, py - pad, s + pad * 2, s + pad * 2);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = 0.45;
      for (const [px, py, p] of list) { ctx.fillStyle = heatOf(p).c; ctx.fillRect(px - pad, py - pad, s + pad * 2, s + pad * 2); }
      ctx.globalAlpha = 1;
      if (tab === 'explore') renderViewPct();
    },
  });
  const fog = new FogLayer();

  // ---------- Keşif sisi (MapLibre içinde: kara ve göller kapalı, deniz açık) ----------
  function fogKeys() {
    const keys = new Set(cells.keys());
    for (const k of liveCells.keys()) keys.add(k);
    if (showCar) for (const k of carCells) keys.add(k);
    return keys;
  }
  function setupGlFog() {
    const m = glMap;
    if (!m || !window.izimFog) return;
    try {
      if (!m.getSource('izim-fog')) m.addSource('izim-fog', { type: 'geojson', data: window.izimFog.build(fogKeys()) });
      if (!m.getLayer('izim-fog')) {
        m.addLayer({ id: 'izim-fog', type: 'fill', source: 'izim-fog', paint: { 'fill-color': FOG_COLOR, 'fill-opacity': 1 } });
        m.addLayer({ id: 'izim-fog-edge', type: 'line', source: 'izim-fog', paint: { 'line-color': FOG_EDGE, 'line-width': 1.2 } });
        // Deniz sisin üstünde kalsın (göller kalmasın)
        const water = (m.getStyle().layers || []).find((l) => l.id === 'water');
        if (water) {
          const ocean = {
            id: 'izim-ocean', type: 'fill', source: water.source,
            filter: ['==', ['get', 'class'], 'ocean'],
            paint: { 'fill-color': (water.paint && water.paint['fill-color']) || '#aad3f5' },
          };
          if (water['source-layer']) ocean['source-layer'] = water['source-layer'];
          m.addLayer(ocean);
        }
      }
      glFogReady = true;
    } catch (e) { console.warn('Sis katmanı kurulamadı', e); glFogReady = false; }
    applyMode();
  }
  let glFogTimer = null;
  function updateGlFog(now) {
    if (!glMap || !glFogReady) return;
    clearTimeout(glFogTimer);
    const run = () => { try { glMap.getSource('izim-fog').setData(window.izimFog.build(fogKeys())); } catch {} };
    if (now) run(); else glFogTimer = setTimeout(run, 1200);
  }

  function routeStyle(w, strong) {
    return isCar(w)
      ? { color: CAR, weight: strong ? 5 : 3, opacity: strong ? 0.85 : 0.6, dashArray: '8 8', lineCap: 'round', interactive: false }
      : { color: ROUTE, weight: strong ? 6 : 4, opacity: strong ? 0.9 : 0.55, lineCap: 'round', lineJoin: 'round', interactive: false };
  }
  // Normal modda tüm yürüyüşler ince çizgi olarak
  const routesLayer = L.layerGroup();
  function drawRoutes() {
    routesLayer.clearLayers();
    for (const w of visibleWalks()) L.polyline(w.segs, routeStyle(w, false)).addTo(routesLayer);
  }
  function onIndexChanged() { drawRoutes(); updateGlFog(true); if (map.hasLayer(fog)) fog.redraw(); }

  function applyMode() {
    const kesif = mode === 'kesif';
    if (glMap && glFogReady) {
      for (const id of ['izim-fog', 'izim-fog-edge', 'izim-ocean']) {
        try { if (glMap.getLayer(id)) glMap.setLayoutProperty(id, 'visibility', kesif ? 'visible' : 'none'); } catch {}
      }
    }
    const showRoutes = !kesif && (tab === 'walk' || tab === 'explore');
    if (showRoutes) map.addLayer(routesLayer); else map.removeLayer(routesLayer);
    if (map.hasLayer(fog)) fog.redraw();
    renderLegend();
    document.querySelectorAll('.seg [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  }
  function setMode(m) {
    mode = m; store.set(KEY_MODE, m);
    applyMode();
    note(m === 'kesif' ? 'Keşif modu: gezdiğin yerler açılır.' : 'Normal mod: harita tamamen açık.');
  }

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
  let startType = 'yuruyus', carHits = 0, carHint = false;
  const limits = () => (cur && cur.type === 'arac'
    ? { acc: 50, step: 20, speed: 70 }
    : { acc: MAX_ACCURACY, step: MIN_STEP, speed: MAX_SPEED });

  const elapsed = () => (cur ? cur.activeMs + (cur.resumedAt ? Date.now() - cur.resumedAt : 0) : 0);
  const recording = () => !!(cur && cur.resumedAt);
  function saveCurrent() { if (cur) { cur.savedAt = Date.now(); store.set(KEY_CURRENT, cur); } }

  function liveAdd(a, b) {
    const seg = a ? [[a, b]] : [[b]];
    walkPath(seg, (la, ln) => {
      const [x, y] = cellXY(la, ln), k = x + ',' + y;
      if (liveCells.has(k)) return;
      liveCells.set(k, { x, y });
      if (!cells.has(k)) { liveFresh++; updateGlFog(false); }
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
    const car = cur && cur.type === 'arac';
    $('sPace').textContent = car ? (d > 50 && t > 0 ? (d / 1000 / (t / 3600000)).toFixed(0) : '–') : fmtPace(t, d);
    $('sPaceLbl').textContent = car ? 'km/sa' : 'dk/km';
    const parts = [];
    if (!cur || recording()) {
      if (lastAcc === null) parts.push('📡 Konum bekleniyor…');
      else if (lastAcc > MAX_ACCURACY) parts.push(`📡 <b>GPS zayıf</b> (±${Math.round(lastAcc)} m) · açık alana çık`);
      else parts.push(`📡 GPS ${cur ? 'iyi' : 'hazır'} (±${Math.round(lastAcc)} m)`);
    }
    if (cur && cur.autoPaused) parts.push('⏸ <b>Otomatik duraklatıldı</b> · yürüyünce devam eder');
    if (cur && cur.type === 'arac') parts.push('🚗 Araç kaydı');
    else if (cur) parts.push(`<b>${liveFresh}</b> yeni nokta`);
    if (carHint && cur && cur.type !== 'arac') parts.push('<br>🚗 <b>Araçta gibisin.</b> Bitir, sonra Araç seçip yeniden başlat.');
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
    const z = fresh ? zoneOf(hrNow) : null;
    b.innerHTML = fresh ? `♥ <b>${hrNow}</b> bpm${z ? ` · Bölge ${z.n}` : ''}` : '♥ nabız bekleniyor…';
    b.title = z ? z.name : '';
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
    $('typeSeg').hidden = !!cur;
    renderGoal();
    document.querySelectorAll('#typeSeg [data-type]').forEach((b) => b.classList.toggle('on', b.dataset.type === startType));
    liveLine.setStyle(cur && cur.type === 'arac' ? { color: CAR, dashArray: '10 8' } : { color: ROUTE, dashArray: null });
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
    if (cur && cur.autoPaused) {
      // Otomatik duraklatmadan çık: son noktadan 12 m uzaklaşınca
      const s = cur.segs[cur.segs.length - 1], ref = s[s.length - 1];
      if (accuracy <= limits().acc && (!ref || haversine(ref, [lat, lng]) >= 12)) {
        cur.autoPaused = false; cur.resumedAt = Date.now(); lastMoveT = Date.now();
        renderButtons(); say('Devam ediliyor');
      } else { renderStats(); return; }
    }
    if (!recording()) { renderStats(); return; }
    bestAcc = Math.min(bestAcc, accuracy);
    const lim = limits();
    if (accuracy > lim.acc) { renderStats(); return; }

    const seg = cur.segs[cur.segs.length - 1];
    const prev = seg[seg.length - 1];
    if (prev) {
      const d = haversine(prev, [lat, lng]);
      if (d < lim.step) return;
      const v = d / Math.max(1, (t - prev[2]) / 1000);
      if (v > lim.speed) {
        // Yürürken sürekli araç hızı: büyük ihtimalle araçtasın
        if (cur.type !== 'arac' && v < 70 && ++carHits >= 5 && !carHint) { carHint = true; renderStats(); }
        return;
      }
      carHits = 0;
      cur.dist += d;
      lastMoveT = Date.now();
      // Her kilometrede sesli bildirim
      const km = Math.floor(cur.dist / 1000);
      if (cur.type !== 'arac' && km > (cur.lastKm || 0)) {
        const nowS = elapsed() / 1000, lap = nowS - (cur.lastKmS || 0);
        cur.lastKm = km; cur.lastKmS = nowS;
        const hrFresh = hrNow && Date.now() - hrLast < 10000;
        say(`${km} kilometre. Süre ${spokenDur(nowS)}. Son kilometre ${spokenDur(lap)}.${hrFresh ? ` Nabız ${hrNow}.` : ''}`);
      }
    }
    const p = [+lat.toFixed(6), +lng.toFixed(6), t];
    seg.push(p);
    if (cur.type !== 'arac') {
      liveAdd(prev || null, p);
      if (++livePts % 8 === 0) liveLaps = analyzeWalk(cur.segs).laps;
    }
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
  let lastMoveT = 0;
  function autoPauseCheck() {
    if (!prefs.autoPause || !cur || !cur.resumedAt || cur.autoPaused) return;
    if (Date.now() - lastMoveT < 20000) return;
    // 20 sn hareket yok: son hareket anında durdur
    cur.activeMs += Math.max(0, lastMoveT - cur.resumedAt);
    cur.resumedAt = null; cur.autoPaused = true;
    saveCurrent(); renderButtons();
    say('Otomatik duraklatıldı');
  }
  function startTick() { clearInterval(tick); tick = setInterval(() => { autoPauseCheck(); renderStats(); }, 1000); }
  function stopTick() { clearInterval(tick); tick = null; }

  function start() {
    cur = { start: Date.now(), segs: [[]], dist: 0, activeMs: 0, resumedAt: Date.now(), type: startType };
    bestAcc = Infinity; carHits = 0; carHint = false;
    liveRebuild(); saveCurrent();
    follow = true;
    startWatch(); lockScreen(); startTick();
    drawLive(); renderButtons(); renderStats();
    lastMoveT = Date.now();
    say(startType === 'arac' ? 'Araç kaydı başladı' : 'Yürüyüş başladı');
    note('Kayıt başladı. Ekranı açık tut, uygulamayı arka plana atma.');
  }

  function togglePause() {
    if (!cur) return;
    if (recording()) {
      cur.activeMs += Date.now() - cur.resumedAt;
      cur.resumedAt = null; cur.autoPaused = false;
      stopTick(); releaseScreen();
      note('Duraklatıldı.');
    } else {
      cur.autoPaused = false; lastMoveT = Date.now();
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
        tt: segs.map((s) => s.map((p) => Math.round((p[2] - cur.start) / 1000))), // başlangıçtan saniye
      };
      if (cur.type === 'arac') w.type = 'arac';
      if (cur.hr && cur.hr.n) w.hr = { avg: Math.round(cur.hr.sum / cur.hr.n), max: cur.hr.max, s: cur.hr.s };
      walks.unshift(w);
      saveWalks(); syncSoon();
      buildIndex();
      const m = walkMeta.get(w.id);
      say(`${isCar(w) ? 'Araç kaydı' : 'Yürüyüş'} bitti. ${fmtKm(w.dist)} kilometre, ${spokenDur(w.dur / 1000)}.`);
      if (isCar(w)) note(`🚗 Araç yolu kaydedildi: ${fmtKm(w.dist)} km · ${fmtTime(w.dur)}`);
      else note(`Kaydedildi: ${fmtKm(w.dist)} km · ${fmtTime(w.dur)} · ${m.fresh} yeni nokta${m.laps ? ` · ${m.laps} tur` : ''}`);
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
      (mode === 'kesif' ? `<span><i style="background:${glFogReady ? FOG_COLOR : 'rgba(20,28,36,.5)'}"></i>gidilmedi</span>` : '');
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
    for (const w of visibleWalks()) {
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

  function weekKm() {
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime();
    return footWalks().filter((w) => w.start >= monday).reduce((s, w) => s + w.dist, 0) / 1000;
  }
  function goalRing(size) {
    const km = weekKm(), goal = prefs.goal || 10, pct = Math.min(1, km / goal);
    const r = size / 2 - 6, C = 2 * Math.PI * r;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Haftalık hedef">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" style="stroke:var(--text);stroke-opacity:.12" stroke-width="9"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" style="stroke:var(--accent)" stroke-width="9" stroke-linecap="round"
        stroke-dasharray="${(C * pct).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-size="${size / 4.6}" font-weight="750" style="fill:var(--text)">%${Math.round(pct * 100)}</text></svg>`;
  }
  function renderGoal() {
    const km = weekKm(), goal = prefs.goal || 10, left = Math.max(0, goal - km);
    if ($('goalCard')) $('goalCard').innerHTML = `${goalRing(78)}<div class="meta"><b>Haftalık hedef</b>
      <span>${fmtKm(km * 1000, 1)} / ${String(goal).replace('.', ',')} km</span>
      <small class="muted">${left > 0 ? `Hedefe ${fmtKm(left * 1000, 1)} km kaldı` : '🎉 Bu haftanın hedefi tamam!'}</small></div>`;
    if ($('goalLine')) $('goalLine').innerHTML = cur ? '' : `<span class="bar"><i style="width:${Math.min(100, km / goal * 100).toFixed(0)}%"></i></span>
      <small>Bu hafta ${fmtKm(km * 1000, 1)} / ${String(goal).replace('.', ',')} km</small>`;
  }
  function renderTiles(days) {
    renderGoal();
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime();
    const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let wk = 0, mo = 0, tot = 0;
    for (const w of footWalks()) { tot += w.dist; if (w.start >= monday) wk += w.dist; if (w.start >= month) mo += w.dist; }
    $('dWeek').textContent = fmtKm(wk, 1);
    $('dMonth').textContent = fmtKm(mo, 1);
    $('dTotal').textContent = fmtKm(tot, 1);
    $('dStreak').textContent = streak(new Set(footWalks().map((w) => dayKey(w.start))));
  }

  // Basit çubuk grafik (tek seri, dokununca değer balonu)
  function drawBars(box, data, opts) {
    const tip = box.querySelector('.tip');
    box.querySelector('svg')?.remove();
    const n = data.length;
    const W = Math.max(260, box.clientWidth || 300), H = 110, top = 16, base = 88, gap = n > 10 ? 4 : 8;
    const bw = (W - gap * (n - 1)) / n;
    const vals = data.map((d) => d.v || 0);
    const max = Math.max(opts.minMax || 0, ...vals) || 1;
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim(), muted = css.getPropertyValue('--muted').trim(), line = css.getPropertyValue('--line').trim();
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria)}">`;
    svg += `<text x="0" y="10" font-size="11" fill="${muted}">${esc(opts.fmtMax(max))}</text>`;
    svg += `<line x1="0" x2="${W}" y1="${top}" y2="${top}" stroke="${line}" stroke-dasharray="3 3"/>`;
    data.forEach((d, i) => {
      const v = d.v || 0;
      const x = i * (bw + gap), h = v ? Math.max(3, (v / max) * (base - top)) : 0, y = base - h, r = Math.min(4, bw / 2, h);
      if (h) svg += `<path d="M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${base} Z" fill="${accent}"/>`;
      svg += `<text x="${x + bw / 2}" y="${base + 16}" font-size="11" text-anchor="middle" fill="${d.hl ? accent : muted}" font-weight="${d.hl ? 700 : 400}">${esc(d.label)}</text>`;
      svg += `<rect data-i="${i}" x="${x - gap / 2}" y="0" width="${bw + gap}" height="${H}" fill="transparent"/>`;
    });
    svg += `<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="${muted}" stroke-opacity=".5"/></svg>`;
    box.insertAdjacentHTML('beforeend', svg);
    const el = box.querySelector('svg');
    const show = (e) => {
      const i = e.target.dataset && e.target.dataset.i;
      if (i === undefined) { tip.hidden = true; return; }
      const x = (+i * (bw + gap) + bw / 2) / W * el.clientWidth;
      tip.textContent = data[+i].tip;
      tip.style.left = Math.min(Math.max(x, 70), el.clientWidth - 70) + 'px';
      tip.hidden = false;
    };
    el.addEventListener('pointermove', show);
    el.addEventListener('pointerdown', show);
    el.addEventListener('pointerleave', () => (tip.hidden = true));
  }

  function renderChart() {
    const perDay = new Map();
    for (const w of footWalks()) { const k = dayKey(w.start); perDay.set(k, (perDay.get(k) || 0) + w.dist); }
    const letters = ['P', 'P', 'S', 'Ç', 'P', 'C', 'C']; // Pazar..Cumartesi
    const data = [];
    for (let i = 13; i >= 0; i--) {
      const t = Date.now() - i * 864e5, m = perDay.get(dayKey(t)) || 0;
      data.push({
        v: m, label: letters[new Date(t).getDay()], hl: i === 0,
        tip: `${new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', weekday: 'short' })}: ${m ? fmtKm(m) + ' km' : 'yürüyüş yok'}`,
      });
    }
    drawBars($('chart'), data, { minMax: 1000, fmtMax: (v) => fmtKm(v, 1) + ' km', aria: 'Son 14 günde yürünen kilometre' });
  }

  // ---------- Nabız ve form ----------
  // Kalp verimliliği = bir kalp atışında kaç metre ilerlendiği. Aynı hızda nabız düşerse artar: form gelişiyor demektir.
  const RUN_SPORTS = new Set(['Koşu', 'Arazi koşusu']);
  let formKind = 'yuruyus';
  const kindOf = (w) => (RUN_SPORTS.has(w.sport) ? 'kosu' : /Bisiklet/.test(w.sport || '') ? 'diger' : 'yuruyus');
  const hrWalks = (kind) => footWalks().filter((w) => w.hr && w.hr.avg > 40 && w.dur >= 5 * 60000 && w.dist >= 300 && kindOf(w) === kind);
  function hrAgg(ws) {
    if (!ws.length) return null;
    const dur = ws.reduce((s, w) => s + w.dur, 0), dist = ws.reduce((s, w) => s + w.dist, 0);
    const hr = ws.reduce((s, w) => s + w.hr.avg * w.dur, 0) / dur; // süreye göre ağırlıklı
    return { n: ws.length, hr, kmh: dist / 1000 / (dur / 3600000), eff: (dist / (dur / 1000)) / (hr / 60) };
  }
  function renderForm() {
    const box = $('form');
    const has = { yuruyus: hrWalks('yuruyus').length > 0, kosu: hrWalks('kosu').length > 0 };
    if (!has.yuruyus && !has.kosu) {
      box.innerHTML = '<div class="empty">Nabız bandıyla ya da Polar saatinle yürüdükçe burada formunun nasıl değiştiğini göreceksin.</div>';
      return;
    }
    if (!has[formKind]) formKind = has.yuruyus ? 'yuruyus' : 'kosu';
    const list = hrWalks(formKind), D = 864e5, now = Date.now();
    const a = hrAgg(list.filter((w) => w.start >= now - 30 * D));
    const b = hrAgg(list.filter((w) => w.start < now - 30 * D && w.start >= now - 60 * D));

    const delta = (cur, prev, fmt) => (cur && prev ? `<small class="delta">${fmt(cur, prev)}</small>` : '<small class="delta">geçen ay: –</small>');
    const hrD = (c, p) => { const d = Math.round(c.hr - p.hr); return d === 0 ? 'geçen ayla aynı' : `${d < 0 ? '↓' : '↑'} ${Math.abs(d)} bpm`; };
    const effD = (c, p) => { const d = Math.round((c.eff / p.eff - 1) * 100); return d === 0 ? 'geçen ayla aynı' : `${d > 0 ? '↑' : '↓'} %${Math.abs(d)}`; };
    const spdD = (c, p) => { const d = c.kmh - p.kmh; return Math.abs(d) < 0.05 ? 'geçen ayla aynı' : `${d > 0 ? '↑' : '↓'} ${Math.abs(d).toFixed(1).replace('.', ',')}`; };

    let verdict;
    if (!a) verdict = 'Son 30 günde nabızlı ' + (formKind === 'kosu' ? 'koşu' : 'yürüyüş') + ' yok.';
    else if (!b || a.n < 2 || b.n < 2) verdict = 'Karşılaştırma için bu ay ve geçen ay en az 2’şer nabızlı kayıt gerekiyor. Şimdilik veri toplanıyor.';
    else {
      const d = a.eff / b.eff - 1;
      verdict = d > 0.03 ? '👍 Geçen aya göre daha rahatsın: aynı yolu daha düşük nabızla gidiyorsun. Formun gelişiyor.'
        : d < -0.03 ? 'Son 30 günde kalbin biraz daha çok çalışıyor. Yorgunluk, sıcak hava, uyku ya da daha hızlı tempo etkili olabilir.'
          : 'Formun geçen ayla aynı seviyede.';
    }

    // Son 8 hafta (pazartesi başlangıçlı)
    const today = new Date(); const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7)).getTime();
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const s = monday - i * 7 * D, e = s + 7 * D;
      const g = hrAgg(list.filter((w) => w.start >= s && w.start < e));
      const label = new Date(s).toLocaleDateString('tr-TR', { day: 'numeric', month: 'numeric' });
      weeks.push({
        v: g ? g.eff : 0, label: i === 0 ? 'bu' : label, hl: i === 0,
        tip: g ? `${new Date(s).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} haftası: ${g.eff.toFixed(2).replace('.', ',')} m/atım · ort. ${Math.round(g.hr)} bpm · ${g.n} kayıt`
          : `${new Date(s).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} haftası: nabızlı kayıt yok`,
      });
    }

    box.innerHTML = `
      ${has.yuruyus && has.kosu ? `<div class="seg" style="margin-bottom:10px">
        <button data-kind="yuruyus" class="${formKind === 'yuruyus' ? 'on' : ''}">Yürüyüş</button>
        <button data-kind="kosu" class="${formKind === 'kosu' ? 'on' : ''}">Koşu</button></div>` : ''}
      <div class="tiles">
        <div class="tile"><b>${a ? Math.round(a.hr) : '–'}</b><span>ort. nabız</span>${delta(a, b, hrD)}</div>
        <div class="tile"><b>${a ? a.eff.toFixed(2).replace('.', ',') : '–'}</b><span>m / atım</span>${delta(a, b, effD)}</div>
        <div class="tile"><b>${a ? a.kmh.toFixed(1).replace('.', ',') : '–'}</b><span>ort. km/sa</span>${delta(a, b, spdD)}</div>
      </div>
      <p class="verdict">${verdict}</p>
      <div class="muted" style="margin:10px 0 2px">Haftalık kalp verimliliği · metre / atım (yüksek = daha rahat)</div>
      <div class="chart" id="effChart"><div class="tip" hidden></div></div>
      <div class="muted" style="font-size:11.5px;margin-top:4px">Son 30 gün, önceki 30 günle karşılaştırılır. Tıbbi değerlendirme değildir.</div>`;
    box.querySelectorAll('[data-kind]').forEach((btn) => (btn.onclick = () => { formKind = btn.dataset.kind; renderForm(); }));
    drawBars($('effChart'), weeks, { fmtMax: (v) => v.toFixed(2).replace('.', ',') + ' m/atım', aria: 'Haftalık kalp verimliliği' });
  }

  function renderDaily() {
    const days = groupDays();
    renderTiles(days);
    renderChart();
    renderForm();
    const box = $('days');
    box.innerHTML = '';
    if (!days.length) {
      box.innerHTML = '<div class="empty">Henüz yürüyüş yok. İlk yürüyüşünü kaydet, günlüğün burada birikecek.</div>';
      return;
    }
    for (const [k, list] of days) {
      const feet = list.filter((w) => !isCar(w)), cars = list.filter(isCar);
      const dist = feet.reduce((s, w) => s + w.dist, 0), dur = feet.reduce((s, w) => s + w.dur, 0);
      const carKm = cars.reduce((s, w) => s + w.dist, 0);
      const fresh = list.reduce((s, w) => s + (walkMeta.get(w.id)?.fresh || 0), 0);
      const laps = list.reduce((s, w) => s + (walkMeta.get(w.id)?.laps || 0), 0);
      const places = [...new Set(list.map((w) => w.place).filter(Boolean))];
      const el = document.createElement('div');
      el.className = 'day' + (openDay === k ? ' on' : '');
      el.innerHTML = `<div class="day-head">
          <div class="l1"><span>${esc(dayLabel(k))}</span><span>${fmtKm(dist)} km</span></div>
          <div class="l2">${feet.length ? `${feet.length} yürüyüş · ${fmtDur(dur)} · ` : ''}${fmtClock(list[0].start)}–${fmtClock(list[list.length - 1].end)}${laps ? ` · ${laps} tur` : ''}${cars.length ? ` · <span style="color:${CAR}">🚗 ${fmtKm(carKm, 1)} km araçla</span>` : ''}</div>
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
          row.innerHTML = isCar(w)
            ? `<div class="meta"><div><b>${fmtClock(w.start)}</b> · <span style="color:${CAR}">🚗 Araç</span> · ${fmtKm(w.dist)} km · ${fmtDur(w.dur)}</div>
                <small>${esc(w.place || '')}</small></div><span class="chev">›</span>`
            : `<div class="meta"><div><b>${fmtClock(w.start)}</b> · ${fmtKm(w.dist)} km · ${fmtDur(w.dur)} · ${fmtPace(w.dur, w.dist)} dk/km
                ${m.laps ? `<span class="badge">${m.laps} tur</span>` : ''}${w.source === 'polar' ? `<span class="badge">Polar · ${esc(w.sport || 'antrenman')}</span>` : ''}</div>
                ${w.hr ? `<small style="color:#be123c">♥ ort ${w.hr.avg} · en yüksek ${w.hr.max} bpm</small><br>` : ''}
                <small>${esc(w.place || '')}${m.fresh ? `${w.place ? ' · ' : ''}${m.fresh} yeni nokta` : ''}</small></div><span class="chev">›</span>`;
          row.onclick = () => openDetail(w.id);
          wl.appendChild(row);
        }
        el.appendChild(wl);
      }
      box.appendChild(el);
    }
  }

  function drawDay() {
    dayLayer.clearLayers();
    const list = (openDay ? walks.filter((w) => dayKey(w.start) === openDay) : walks).filter((w) => showCar || !isCar(w));
    for (const w of list) {
      L.polyline(w.segs, { ...routeStyle(w, !!openDay), interactive: true })
        .on('click', () => (openDay ? openDetail(w.id) : selectDay(dayKey(w.start))))
        .addTo(dayLayer);
    }
    const pts = list.flatMap((w) => w.segs.flat());
    if (pts.length) map.fitBounds(L.latLngBounds(pts), panelPad());
  }

  function selectDay(k) {
    openDay = k;
    renderDaily(); drawDay();
  }

  // ---------- Antrenmanlar listesi ----------
  let dailyView = 'days', listFilter = 'all';
  const catOf = (w) => (isCar(w) ? 'arac' : kindOf(w));
  const iconOf = (w) => (isCar(w) ? '🚗' : RUN_SPORTS.has(w.sport) ? '🏃' : /Bisiklet/.test(w.sport || '') ? '🚴' : '🚶');
  const srcOf = (w) => (w.source === 'polar' ? ' · Polar' : w.source === 'dosya' ? ' · dosya' : '');

  function setDailyView(v) {
    dailyView = v;
    document.querySelectorAll('#dailySeg [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    $('viewDays').hidden = v !== 'days';
    $('viewList').hidden = v !== 'list';
    if (v === 'list') { openDay = null; renderList(); drawDay(); } else renderDaily();
  }

  function renderList() {
    const all = visibleWalks();
    const cats = new Set(all.map(catOf));
    const chips = [['all', 'Tümü'], ['yuruyus', '🚶 Yürüyüş'], ['kosu', '🏃 Koşu'], ['diger', '🚴 Diğer'], ['arac', '🚗 Araç']]
      .filter(([k]) => k === 'all' || cats.has(k));
    if (!chips.some(([k]) => k === listFilter)) listFilter = 'all';
    const list = all.filter((w) => listFilter === 'all' || catOf(w) === listFilter).sort((p, q) => q.start - p.start);
    const months = new Map();
    for (const w of list) {
      const d = new Date(w.start), k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!months.has(k)) months.set(k, []);
      months.get(k).push(w);
    }
    let html = `<button class="btn ghost small" id="bGpx" style="width:100%;margin-bottom:10px">＋ GPX / TCX dosyasından ekle</button>
      <div class="chips">${chips.map(([k, l]) => `<button class="fchip${k === listFilter ? ' on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>`;
    if (!list.length) html += '<div class="empty">Henüz kayıt yok.</div>';
    for (const [, ws] of months) {
      const footKm = ws.filter((w) => !isCar(w)).reduce((s, w) => s + w.dist, 0);
      const carKm = ws.filter(isCar).reduce((s, w) => s + w.dist, 0);
      const dur = ws.filter((w) => !isCar(w)).reduce((s, w) => s + w.dur, 0);
      html += `<div class="mhead"><b>${esc(new Date(ws[0].start).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' }))}</b>
        <span>${ws.length} kayıt${footKm ? ` · ${fmtKm(footKm, 1)} km` : ''}${dur ? ` · ${fmtDur(dur)}` : ''}${carKm ? ` · 🚗 ${fmtKm(carKm, 0)} km` : ''}</span></div>`;
      html += ws.map((w) => `<div class="trow" data-id="${esc(w.id)}">
          <span class="tic">${iconOf(w)}</span>
          <div class="meta"><b>${esc(new Date(w.start).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', weekday: 'short' }))} · ${fmtClock(w.start)}</b>
            <small>${esc((isCar(w) ? 'Araç' : w.sport || 'Yürüyüş') + srcOf(w))}${w.place ? ' · ' + esc(w.place.split(',')[0]) : ''}</small></div>
          <div class="tr"><b>${fmtKm(w.dist)} km</b>
            <small>${w.dur ? fmtDur(w.dur) : ''}${!isCar(w) && w.dur ? ' · ' + fmtPace(w.dur, w.dist) + '/km' : ''}${w.hr ? ` · <span style="color:#e11d48">♥${w.hr.avg}</span>` : ''}</small></div>
        </div>`).join('');
    }
    const box = $('viewList');
    box.innerHTML = html;
    box.querySelectorAll('.fchip').forEach((b) => (b.onclick = () => { listFilter = b.dataset.f; renderList(); }));
    box.querySelectorAll('.trow').forEach((r) => (r.onclick = () => openDetail(r.dataset.id)));
    $('bGpx').onclick = () => $('fileGpx').click();
  }

  // GPX / TCX dosyalarını ekle (birden fazla seçilebilir)
  async function importTracks(files) {
    let added = 0, dup = 0, bad = 0;
    for (const f of files) {
      let w = null;
      try { w = window.izimImport.parse(await f.text(), f.name, f.lastModified); } catch { w = null; }
      if (!w) { bad++; continue; }
      if (walks.some((x) => x.id === w.id || Math.abs(x.start - w.start) < 60000)) { dup++; continue; }
      w._s = false;
      walks.push(w); added++;
    }
    if (added) {
      walks.sort((p, q) => q.start - p.start);
      saveWalks(); buildIndex(); syncSoon(); fillPlaces();
    }
    if (tab === 'daily') { if (dailyView === 'list') renderList(); else renderDaily(); drawDay(); }
    const parts = [`${added} antrenman eklendi`];
    if (dup) parts.push(`${dup} tanesi zaten vardı`);
    if (bad) parts.push(`${bad} dosya okunamadı (rota yok ya da GPX/TCX değil)`);
    alert(parts.join(', ') + '.');
  }

  // ---------- Yürüyüş detayı ----------
  let detailId = null;

  // Kilometre başına süre (sadece hareket halindeki süre; duraklamalar sayılmaz)
  function splits(w) {
    if (!w.tt) return null;
    const out = [];
    let dist = 0, time = 0, kmT = 0, next = 1000;
    w.segs.forEach((s, si) => {
      const tt = w.tt[si] || [];
      for (let i = 1; i < s.length; i++) {
        const dd = haversine(s[i - 1], s[i]), dt = (tt[i] ?? 0) - (tt[i - 1] ?? 0);
        if (dt <= 0 || dd <= 0 || (dt > 30 && dd / dt < 0.4)) { dist += dd; continue; } // mola
        let d0 = dist, t0 = time;
        while (d0 + dd >= next && dist + dd >= next) {
          const tCross = t0 + dt * (next - dist) / dd;
          out.push({ km: out.length + 1, sec: tCross - kmT, part: 1000 });
          kmT = tCross; next += 1000;
        }
        dist += dd; time += dt;
      }
    });
    const rest = dist - (next - 1000);
    if (rest >= 100 && time > kmT) out.push({ km: out.length + 1, sec: time - kmT, part: rest });
    return out;
  }

  // Yolu boyunca her kilometrede işaret
  function kmMarks(w) {
    const out = [];
    let dist = 0, next = 1000;
    for (const s of w.segs) for (let i = 1; i < s.length; i++) {
      const dd = haversine(s[i - 1], s[i]);
      while (dd > 0 && dist + dd >= next) {
        const f = (next - dist) / dd;
        out.push({ km: next / 1000, ll: [s[i - 1][0] + (s[i][0] - s[i - 1][0]) * f, s[i - 1][1] + (s[i][1] - s[i - 1][1]) * f] });
        next += 1000;
      }
      dist += dd;
    }
    return out;
  }

  // Nabız çizgi grafiği (tek seri, dokununca değer)
  function drawLine(box, pts) {
    const tip = box.querySelector('.tip');
    box.querySelector('svg')?.remove();
    const W = Math.max(260, box.clientWidth || 300), H = 130, top = 12, base = 104, left = 30;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = xs[0], x1 = xs[xs.length - 1] || 1, y0 = Math.floor(Math.min(...ys) / 10) * 10, y1 = Math.ceil(Math.max(...ys) / 10) * 10 || 1;
    const X = (v) => left + (v - x0) / Math.max(1, x1 - x0) * (W - left - 4);
    const Y = (v) => base - (v - y0) / Math.max(1, y1 - y0) * (base - top);
    const css = getComputedStyle(document.documentElement);
    const muted = css.getPropertyValue('--muted').trim(), line = css.getPropertyValue('--line').trim();
    const red = '#e11d48';
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    const mmss = (s) => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Yürüyüş boyunca nabız">`;
    for (const v of [y0, (y0 + y1) / 2, y1]) {
      svg += `<line x1="${left}" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="${line}"/>`;
      svg += `<text x="0" y="${Y(v) + 4}" font-size="11" fill="${muted}">${Math.round(v)}</text>`;
    }
    svg += `<path d="${d} L${X(x1)},${base} L${X(x0)},${base} Z" fill="${red}" fill-opacity=".08"/>`;
    svg += `<path d="${d}" fill="none" stroke="${red}" stroke-width="2" stroke-linejoin="round"/>`;
    svg += `<text x="${left}" y="${H - 6}" font-size="11" fill="${muted}">0:00</text>`;
    svg += `<text x="${W}" y="${H - 6}" font-size="11" fill="${muted}" text-anchor="end">${mmss(x1)}</text>`;
    svg += `<line class="xh" x1="0" x2="0" y1="${top}" y2="${base}" stroke="${muted}" stroke-dasharray="3 3" visibility="hidden"/>`;
    svg += `<circle class="dot" r="4.5" fill="${red}" stroke="#fff" stroke-width="2" visibility="hidden"/>`;
    svg += `<rect x="${left}" y="0" width="${W - left}" height="${H}" fill="transparent"/></svg>`;
    box.insertAdjacentHTML('beforeend', svg);
    const el = box.querySelector('svg'), xh = el.querySelector('.xh'), dot = el.querySelector('.dot');
    const show = (e) => {
      const r = el.getBoundingClientRect(), vx = (e.clientX - r.left) / r.width * W;
      let best = 0;
      for (let i = 1; i < pts.length; i++) if (Math.abs(X(pts[i][0]) - vx) < Math.abs(X(pts[best][0]) - vx)) best = i;
      const p = pts[best], px = X(p[0]);
      xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', px); dot.setAttribute('cy', Y(p[1])); dot.setAttribute('visibility', 'visible');
      tip.textContent = `${mmss(p[0])} · ${p[1]} bpm`;
      tip.style.left = Math.min(Math.max(px / W * r.width, 60), r.width - 60) + 'px';
      tip.hidden = false;
    };
    el.addEventListener('pointermove', show);
    el.addEventListener('pointerdown', show);
    el.addEventListener('pointerleave', () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
  }

  function openDetail(id) {
    const w = walks.find((x) => x.id === id);
    if (!w) return;
    detailId = id;
    $('p-daily').hidden = true;
    const p = $('p-detail');
    p.hidden = false;
    const m = walkMeta.get(w.id) || {};
    const car = isCar(w);
    const sp = car ? null : splits(w);
    const tiles = car
      ? [[fmtKm(w.dist), 'km'], [fmtDur(w.dur), 'süre'], [(w.dist / 1000 / Math.max(1e-9, w.dur / 3600000)).toFixed(0), 'ort. km/sa']]
      : [[fmtKm(w.dist), 'km'], [fmtDur(w.dur), 'süre'], [fmtPace(w.dur, w.dist), 'dk/km'],
        [w.hr ? w.hr.avg : '–', 'ort. nabız'], [w.hr ? w.hr.max : '–', 'en yüksek'], [m.fresh || 0, 'yeni nokta']];
    let splitHtml = '';
    if (sp && sp.length) {
      const paces = sp.map((s) => s.sec / (s.part / 1000));
      const fastest = Math.min(...paces), slowest = Math.max(...paces);
      splitHtml = '<h3>Kilometre tempoları</h3><div class="splits">' + sp.map((s, i) => {
        const pace = paces[i];
        const wdt = slowest === fastest ? 100 : 40 + 60 * (slowest - pace) / (slowest - fastest);
        const tot = Math.round(pace), mm = Math.floor(tot / 60), ss = String(tot % 60).padStart(2, '0');
        return `<div class="split"><span class="k">${s.part < 1000 ? fmtKm(s.part, 2) : s.km}</span>
          <span class="bar"><i style="width:${wdt.toFixed(0)}%"></i></span><span class="v">${mm}:${ss}${pace === fastest && sp.length > 1 ? ' ⚡' : ''}</span></div>`;
      }).join('') + '</div>';
    } else if (!car) splitHtml = '<h3>Kilometre tempoları</h3><div class="muted">Bu kayıtta zaman bilgisi yok (eski kayıt ya da 1 km’den kısa).</div>';
    const hrHtml = car ? '' : (w.hr && w.hr.s && w.hr.s.length >= 3
      ? '<h3>Nabız</h3><div class="chart" id="hrChart"><div class="tip" hidden></div></div>'
      : `<h3>Nabız</h3><div class="muted">${w.hr ? `Ortalama ${w.hr.avg}, en yüksek ${w.hr.max} bpm. Ayrıntılı nabız grafiği yok.` : 'Bu kayıtta nabız yok. Yürüyüşe başlamadan önce ♥ Nabız bağla.'}</div>`);
    let zoneHtml = '';
    if (!car && w.hr && w.hr.s && w.hr.s.length >= 3) {
      if (!hrMax()) zoneHtml = '<h3>Nabız bölgeleri</h3><div class="muted">Bölgeleri görmek için <b>Ayarlar → Antrenman</b>’dan yaşını gir.</div>';
      else {
        const zt = zoneTimes(w.hr.s), tot = zt.reduce((x, y) => x + y, 0) || 1;
        zoneHtml = `<h3>Nabız bölgeleri <span class="muted" style="text-transform:none;font-weight:500">· en yüksek nabız ${hrMax()}</span></h3>
          <div class="zbar">${ZONES.map((z, i) => zt[i] ? `<i style="flex:${zt[i]};background:${z.c}" title="Bölge ${z.n}"></i>` : '').join('')}</div>
          <div class="zlist">${ZONES.map((z, i) => `<div class="zrow"><span class="zdot" style="background:${z.c}"></span>
            <span class="zn">Bölge ${z.n} · ${z.name}</span><span class="zv">${zt[i] ? spokenDur(zt[i]).replace(/ dakika/, ' dk').replace(/ saniye/, ' sn').replace(/ saat/, ' sa') : '–'}</span>
            <span class="zp">%${Math.round(zt[i] / tot * 100)}</span></div>`).join('')}</div>`;
      }
    }
    p.innerHTML = `<div class="det-head">
        <button class="icon-btn" id="detBack" aria-label="Geri">‹</button>
        <div class="meta"><b>${esc(new Date(w.start).toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' }))}</b>
          <small>${fmtClock(w.start)}–${fmtClock(w.end)}${w.place ? ' · ' + esc(w.place) : ''}</small></div>
        ${car ? `<span class="badge" style="background:rgba(124,58,237,.14);color:${CAR}">🚗 Araç</span>` : w.source === 'polar' || w.sport ? `<span class="badge">${esc((w.source === 'polar' ? 'Polar · ' : '') + (w.sport || ''))}</span>` : m.laps ? `<span class="badge">${m.laps} tur</span>` : ''}
      </div>
      <div class="tiles">${tiles.map(([v, l]) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`).join('')}</div>
      ${hrHtml}${zoneHtml}${splitHtml}
      <div class="row" style="margin-top:16px">
        ${car ? '' : '<button class="btn" id="detShare">Paylaş</button>'}
        <button class="btn ghost" id="detDel">Sil</button>
      </div>`;
    $('detBack').onclick = closeDetail;
    $('detDel').onclick = () => {
      if (!confirm(car ? 'Bu araç yolu silinsin mi?' : 'Bu yürüyüş silinsin mi?')) return;
      walks = walks.filter((x) => x.id !== w.id);
      markDeleted(w.id);
      saveWalks(); buildIndex(); syncSoon();
      if (!walks.some((x) => dayKey(x.start) === openDay)) openDay = null;
      closeDetail();
    };
    if ($('detShare')) $('detShare').onclick = () => shareWalk(w);
    if ($('hrChart')) drawLine($('hrChart'), w.hr.s);
    // Haritada bu yürüyüş: başlangıç, bitiş, kilometre işaretleri
    dayLayer.clearLayers();
    L.polyline(w.segs, routeStyle(w, true)).addTo(dayLayer);
    const pts = w.segs.flat();
    const dotIcon = (bg, txt) => L.divIcon({ className: '', iconSize: [22, 22], html: `<div class="pin" style="background:${bg}">${txt}</div>` });
    L.marker(pts[0], { icon: dotIcon('#16a34a', ''), interactive: false }).addTo(dayLayer);
    L.marker(pts[pts.length - 1], { icon: dotIcon('#111827', '🏁'), interactive: false }).addTo(dayLayer);
    if (!car) for (const k of kmMarks(w)) L.marker(k.ll, { icon: L.divIcon({ className: '', iconSize: [24, 24], html: `<div class="kmpin">${k.km}</div>` }), interactive: false }).addTo(dayLayer);
    p.scrollTop = 0;
    map.fitBounds(L.latLngBounds(pts), panelPad());
  }
  function closeDetail() {
    detailId = null;
    $('p-detail').hidden = true;
    if (tab === 'daily') { $('p-daily').hidden = false; if (dailyView === 'list') renderList(); else renderDaily(); drawDay(); }
  }

  // ---------- Paylaşım kartı (görsel) ----------
  async function shareWalk(w) {
    const W = 1080, H = 1350, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0f766e'); bg.addColorStop(1, '#0b3b38');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const font = (wt, px) => `${wt} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    g.fillStyle = 'rgba(255,255,255,.75)'; g.font = font(600, 36);
    g.fillText(new Date(w.start).toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), 80, 120);
    g.fillStyle = '#fff'; g.font = font(800, 64);
    g.fillText(w.place ? w.place.split(',')[0] : (w.source === 'polar' ? (w.sport || 'Antrenman') : 'Yürüyüş'), 80, 200);
    // Rota (Web Mercator, kutuya sığdır)
    const merc = ([la, ln]) => [ln, -Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360)) * 180 / Math.PI];
    const pts = w.segs.map((s) => s.map(merc));
    const all = pts.flat(), xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    const bx = [80, 270, W - 160, 720], minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const k = Math.min(bx[2] / Math.max(1e-9, maxX - minX), bx[3] / Math.max(1e-9, maxY - minY));
    const ox = bx[0] + (bx[2] - (maxX - minX) * k) / 2, oy = bx[1] + (bx[3] - (maxY - minY) * k) / 2;
    const P = ([x, y]) => [ox + (x - minX) * k, oy + (y - minY) * k];
    g.fillStyle = 'rgba(255,255,255,.07)';
    g.beginPath(); g.roundRect(bx[0] - 20, bx[1] - 20, bx[2] + 40, bx[3] + 40, 40); g.fill();
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const [col, wd] of [['rgba(0,0,0,.25)', 26], ['#ffffff', 16]]) {
      g.strokeStyle = col; g.lineWidth = wd;
      for (const s of pts) { g.beginPath(); s.forEach((p, i) => { const [x, y] = P(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); }
    }
    const dot = (p, col) => { const [x, y] = P(p); g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 22, 0, 7); g.fill(); g.fillStyle = col; g.beginPath(); g.arc(x, y, 14, 0, 7); g.fill(); };
    dot(all[0], '#22c55e'); dot(all[all.length - 1], '#111827');
    // İstatistikler
    const stats = [[fmtKm(w.dist), 'km'], [fmtDur(w.dur), 'süre'], [fmtPace(w.dur, w.dist), 'dk/km']];
    if (w.hr) stats.push([String(w.hr.avg), 'ort. nabız']);
    const colW = (W - 160) / stats.length;
    stats.forEach(([v, l], i) => {
      const x = 80 + i * colW;
      g.fillStyle = '#fff'; g.font = font(800, stats.length > 3 ? 64 : 76); g.fillText(v, x, 1150);
      g.fillStyle = 'rgba(255,255,255,.7)'; g.font = font(600, 32); g.fillText(l, x, 1200);
    });
    g.fillStyle = 'rgba(255,255,255,.9)'; g.font = font(800, 40); g.textAlign = 'right'; g.fillText('İzim', W - 80, H - 70);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], `izim-${dayKey(w.start)}.png`, { type: 'image/png' });
    const text = `${fmtKm(w.dist)} km yürüdüm 🚶 (${fmtDur(w.dur)})`;
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    note('Paylaşım desteklenmiyor; görsel indirildi.');
  }

  // ---------- Mahalle keşif yüzdesi (OpenStreetMap sınırları) ----------
  const KEY_AREAS = 'izim.areas.v1';
  let areas = store.get(KEY_AREAS, {}); // anahtar -> { name, sub, bbox, polys, total }
  const areaLayer = L.layerGroup().addTo(map);
  let areaBusy = false, areaTried = new Set();

  function pipRing(pt, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  // polys: [[outer, ...holes], ...] — koordinatlar [lng, lat]
  const inArea = (ar, lng, lat) => lng >= ar.bbox[0] && lng <= ar.bbox[2] && lat >= ar.bbox[1] && lat <= ar.bbox[3] &&
    ar.polys.some(([outer, ...holes]) => pipRing([lng, lat], outer) && !holes.some((h) => pipRing([lng, lat], h)));

  function areaTotal(ar) {
    const [x0, y0] = cellXY(ar.bbox[3], ar.bbox[0]), [x1, y1] = cellXY(ar.bbox[1], ar.bbox[2]);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400000) return 0; // çok büyük bölge (ilçe/il) — sayma
    let n = 0;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const c = cellCenter(x, y);
      if (inArea(ar, c.lng, c.lat)) n++;
    }
    return n;
  }
  function areaSeen(ar) {
    let n = 0;
    for (const c of cells.values()) { const ll = cellCenter(c.x, c.y); if (inArea(ar, ll.lng, ll.lat)) n++; }
    return n;
  }

  async function fetchArea(lat, lng) {
    // Önce mahalle düzeyi, olmazsa bir üst düzey
    for (const zoom of [14, 13, 12]) {
      await (geoQueue = geoQueue.then(() => new Promise((r) => setTimeout(r, 1100))));
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=${zoom}&polygon_geojson=1&polygon_threshold=0.00003&accept-language=tr&lat=${lat}&lon=${lng}`);
        if (!res.ok) return null;
        const j = await res.json();
        const gj = j.geojson;
        if (!gj || (gj.type !== 'Polygon' && gj.type !== 'MultiPolygon')) continue;
        const polys = gj.type === 'Polygon' ? [gj.coordinates] : gj.coordinates;
        const bb = j.boundingbox.map(Number); // [güney, kuzey, batı, doğu]
        const ad = j.address || {};
        const ar = {
          name: j.name || ad.suburb || ad.neighbourhood || ad.quarter || 'Bölge',
          sub: ad.town || ad.city_district || ad.county || ad.city || '',
          bbox: [bb[2], bb[0], bb[3], bb[1]],
          polys: polys.map((p) => p.map((r) => r.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]))),
        };
        ar.total = areaTotal(ar);
        if (!ar.total) continue;
        return { key: `${j.osm_type}${j.osm_id}`, ar };
      } catch { return null; }
    }
    return null;
  }

  // Gezilen yerlerin hangi mahallelerde olduğunu bul (en çok gezilen 10 bölge)
  async function discoverAreas() {
    if (areaBusy || !cells.size) return;
    areaBusy = true;
    const groups = new Map();
    for (const c of cells.values()) {
      const k = (c.x >> 4) + ',' + (c.y >> 4); // ~1 km'lik öbekler
      const g = groups.get(k) || { n: 0, x: 0, y: 0 };
      g.n++; g.x += c.x; g.y += c.y; groups.set(k, g);
    }
    const tops = [...groups.entries()].sort((p, q) => q[1].n - p[1].n).slice(0, 10);
    for (const [k, g] of tops) {
      if (areaTried.has(k)) continue;
      const ll = cellCenter(Math.round(g.x / g.n), Math.round(g.y / g.n));
      if (Object.values(areas).some((ar) => inArea(ar, ll.lng, ll.lat))) continue;
      areaTried.add(k);
      const r = await fetchArea(ll.lat, ll.lng);
      if (r) { areas[r.key] = r.ar; store.set(KEY_AREAS, areas); if (tab === 'explore') renderAreas(); }
    }
    areaBusy = false;
  }

  function renderAreas() {
    const box = $('areas');
    if (!box) return;
    const list = Object.entries(areas).map(([k, ar]) => ({ k, ar, seen: areaSeen(ar) }))
      .filter((x) => x.seen > 0).sort((p, q) => q.seen / q.ar.total - p.seen / p.ar.total);
    if (!list.length) {
      box.innerHTML = `<div class="empty">${cells.size ? 'Mahalle sınırları alınıyor…' : 'Yürüdükçe mahallelerin yüzde kaçını gezdiğini burada göreceksin.'}</div>`;
      return;
    }
    box.innerHTML = list.map(({ k, ar, seen }) => {
      const pct = Math.min(100, seen / ar.total * 100);
      return `<div class="area" data-k="${esc(k)}"><div class="area-l"><b>${esc(ar.name)}</b><small class="muted">${esc(ar.sub)}</small></div>
        <div class="area-r"><b>%${pct < 1 ? '<1' : Math.round(pct)}</b><span class="bar"><i style="width:${Math.max(2, pct).toFixed(0)}%"></i></span></div></div>`;
    }).join('');
    box.querySelectorAll('.area').forEach((el) => (el.onclick = () => showArea(el.dataset.k)));
  }
  function showArea(k) {
    const ar = areas[k];
    if (!ar) return;
    areaLayer.clearLayers();
    const shape = L.polygon(ar.polys.map((p) => p.map((r) => r.map(([x, y]) => [y, x]))), { color: '#0f766e', weight: 2.5, fill: false, dashArray: '6 6', interactive: false }).addTo(areaLayer);
    map.fitBounds(shape.getBounds(), panelPad());
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
    $('p-detail').hidden = true; detailId = null;
    if (t === 'settings') { renderAccount(); renderPolar(); }
    map.closePopup();

    if (t === 'daily') { map.removeLayer(fog); map.addLayer(dayLayer); fillPlaces(); if (dailyView === 'list') renderList(); else renderDaily(); drawDay(); }
    else { map.removeLayer(dayLayer); map.addLayer(fog); }
    applyMode();

    if (t !== 'explore') areaLayer.clearLayers();
    if (t === 'explore') {
      renderExplore();
      renderAreas(); discoverAreas();
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
  document.querySelectorAll('#dailySeg [data-view]').forEach((b) => (b.onclick = () => setDailyView(b.dataset.view)));
  $('fileGpx').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) importTracks(fs); };
  $('bGpx2').onclick = () => $('fileGpx').click();
  document.querySelectorAll('.seg [data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  document.querySelectorAll('#typeSeg [data-type]').forEach((b) => (b.onclick = () => { startType = b.dataset.type; renderButtons(); }));
  const renderCarSeg = () => document.querySelectorAll('#carSeg [data-car]').forEach((b) => b.classList.toggle('on', (b.dataset.car === '1') === showCar));
  document.querySelectorAll('#carSeg [data-car]').forEach((b) => (b.onclick = () => {
    showCar = b.dataset.car === '1'; store.set(KEY_SHOWCAR, showCar); renderCarSeg();
    drawRoutes(); updateGlFog(true); applyMode();
  }));
  renderCarSeg();
  const renderPrefs = () => {
    document.querySelectorAll('[data-pref]').forEach((b) => b.classList.toggle('on', String(prefs[b.dataset.pref]) === b.dataset.val));
    $('prefGoal').value = prefs.goal || '';
    $('prefAge').value = prefs.age || '';
    $('hrMaxInfo').textContent = hrMax() ? `En yüksek nabız tahmini: ${hrMax()} bpm` : 'Nabız bölgeleri için yaşını gir.';
  };
  document.querySelectorAll('[data-pref]').forEach((b) => (b.onclick = () => {
    prefs[b.dataset.pref] = b.dataset.val === 'true'; savePrefs(); renderPrefs();
    if (b.dataset.pref === 'voice' && prefs.voice) say('Sesli bildirim açık');
  }));
  $('prefGoal').onchange = (e) => { const v = parseFloat(String(e.target.value).replace(',', '.')); prefs.goal = v > 0 ? Math.min(500, v) : 10; savePrefs(); renderPrefs(); renderGoal(); };
  $('prefAge').onchange = (e) => { const v = parseInt(e.target.value, 10); prefs.age = v >= 10 && v <= 100 ? v : null; savePrefs(); renderPrefs(); renderHr(); };
  renderPrefs();
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
      saveCurrent(); lockScreen(); startTick(); lastMoveT = Date.now();
      note('Yarım kalan yürüyüşe devam ediliyor.');
    }
    liveRebuild(); drawLive();
  }
  map.addLayer(fog);
  applyMode();
  startWatch();
  renderButtons(); renderStats();
  fillPlaces();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
