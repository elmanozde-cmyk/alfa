/* Keşif sisi: gezilen karelerden "açılmış bölge" sınırlarını çıkarır,
 * sisi bu bölgelerin dışına çizen GeoJSON üretir (MapLibre için).
 * Kareler zoom-19 karo koordinatlarıdır ("x,y").
 */
(function (root) {
  'use strict';
  const Z = 19, N = 2 ** Z;
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1]; // 0 sağ, 1 aşağı, 2 sol, 3 yukarı (y aşağı doğru artar)

  const lng = (x) => +(x / N * 360 - 180).toFixed(7);
  const lat = (y) => +(Math.atan(Math.sinh(Math.PI * (1 - 2 * y / N))) * 180 / Math.PI).toFixed(7);

  // Dolu kareleri saat yönünde dolaşan kenarlar (dolu taraf hep sağda)
  function traceRings(keys) {
    const has = (x, y) => keys.has(x + ',' + y);
    const out = new Map(); // "x,y" -> [{to, d}]
    const add = (x1, y1, d) => {
      const k = x1 + ',' + y1;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push({ x: x1, y: y1, d, used: false });
    };
    for (const k of keys) {
      const i = k.indexOf(','), x = +k.slice(0, i), y = +k.slice(i + 1);
      if (!has(x, y - 1)) add(x, y, 0);         // üst kenar: sağa
      if (!has(x + 1, y)) add(x + 1, y, 1);     // sağ kenar: aşağı
      if (!has(x, y + 1)) add(x + 1, y + 1, 2); // alt kenar: sola
      if (!has(x - 1, y)) add(x, y + 1, 3);     // sol kenar: yukarı
    }
    const rings = [];
    for (const list of out.values()) {
      for (const start of list) {
        if (start.used) continue;
        const ring = [];
        let e = start;
        while (e && !e.used) {
          e.used = true;
          ring.push([e.x, e.y, e.d]);
          const nx = e.x + DX[e.d], ny = e.y + DY[e.d];
          const cands = out.get(nx + ',' + ny) || [];
          // Önce sağa dön (çapraz değen kareleri ayrı tutar), sonra düz, sonra sola
          const pref = [(e.d + 1) % 4, e.d, (e.d + 3) % 4];
          let next = null;
          for (const d of pref) { next = cands.find((c) => !c.used && c.d === d); if (next) break; }
          e = next;
        }
        // Yön değişmeyen ara noktaları at
        const pts = ring.filter((p, i) => p[2] !== ring[(i - 1 + ring.length) % ring.length][2]).map((p) => [p[0], p[1]]);
        if (pts.length >= 4) rings.push({ pts, first: ring[0] });
      }
    }
    return rings;
  }

  function area(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2; // y aşağı: dış sınırlar pozitif, iç boşluklar negatif
  }

  function inside(pt, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  const toLngLat = (pts) => {
    const r = pts.map(([x, y]) => [lng(x), lat(y)]);
    r.push(r[0]);
    return r;
  };

  // Sis: dünya çapında bir çokgen, gezilen bölgeler delik; gezilen bölge içindeki gezilmemiş boşluklar ayrı sis parçası
  function build(keys) {
    const rings = traceRings(keys).map((r) => ({ ...r, a: area(r.pts) }));
    const outers = rings.filter((r) => r.a > 0), inners = rings.filter((r) => r.a < 0);
    const world = [[-180, -85.0511], [180, -85.0511], [180, 85.0511], [-180, 85.0511], [-180, -85.0511]];
    const polys = [{ rings: [world], holes: [] }];
    const innerPolys = inners.sort((p, q) => q.a - p.a).map((r) => ({ src: r, rings: [toLngLat(r.pts)] }));
    for (const o of outers) {
      // Bu bölgenin ilk karesinin merkezi
      const f = o.first, c = [f[0] + DX[f[2]] * 0.5 - DY[f[2]] * 0.5, f[1] + DY[f[2]] * 0.5 + DX[f[2]] * 0.5];
      let host = null;
      for (const ip of innerPolys) {
        if (inside(c, ip.src.pts) && (!host || -ip.src.a < -host.src.a)) host = ip;
      }
      (host ? host.rings : polys[0].rings).push(toLngLat(o.pts));
    }
    const features = polys.concat(innerPolys).map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: p.rings } }));
    return { type: 'FeatureCollection', features };
  }

  const api = { build, traceRings, area };
  root.izimFog = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
