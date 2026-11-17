/* GPX / TCX dosyalarından antrenman okur (Polar Flow, Strava, Garmin vb. dışa aktarımları).
 * Tarayıcıdan bağımsız: düz metin üzerinde çalışır, her yerde test edilebilir.
 */
(function (root) {
  'use strict';

  function haversine(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  const tag = (name) => `(?:\\w+:)?${name}`; // ad alanı önekleri: ns3:Trackpoint, gpxtpx:hr …
  const first = (s, name) => {
    const m = s.match(new RegExp(`<${tag(name)}\\b[^>]*>([^<]*)</${tag(name)}>`));
    return m ? m[1].trim() : null;
  };
  const num = (v) => (v === null || v === '' ? NaN : Number(v));

  const SPORTS = [
    [/run|koş|kos/i, 'Koşu'], [/hik|trek|doğa/i, 'Doğa yürüyüşü'], [/nordic/i, 'Nordic yürüyüş'],
    [/bik|cycl|bisik|ride/i, 'Bisiklet'], [/walk|yürü/i, 'Yürüyüş'],
  ];
  const sportName = (s) => {
    if (!s) return null;
    for (const [re, n] of SPORTS) if (re.test(s)) return n;
    return null;
  };

  // GPX: <trkseg><trkpt lat lon><time/><extensions><gpxtpx:hr/></extensions></trkpt></trkseg>
  function parseGpx(text) {
    const segs = [];
    const segRe = new RegExp(`<${tag('trkseg')}\\b[^>]*>([\\s\\S]*?)</${tag('trkseg')}>`, 'g');
    const ptRe = new RegExp(`<${tag('trkpt')}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag('trkpt')}>)`, 'g');
    let sm, any = false;
    while ((sm = segRe.exec(text))) {
      any = true;
      const pts = [];
      let pm;
      ptRe.lastIndex = 0;
      while ((pm = ptRe.exec(sm[1]))) pts.push(gpxPoint(pm[1], pm[2] || ''));
      segs.push(pts);
    }
    if (!any) { // trkseg yoksa tüm noktaları tek parça say
      const pts = [];
      let pm;
      while ((pm = ptRe.exec(text))) pts.push(gpxPoint(pm[1], pm[2] || ''));
      segs.push(pts);
    }
    const trk = text.match(new RegExp(`<${tag('trk')}\\b[^>]*>([\\s\\S]*?)<${tag('trkseg')}`));
    const type = trk ? first(trk[1], 'type') : null;
    const name = trk ? first(trk[1], 'name') : null;
    return { segs, sport: sportName(type) || sportName(name) };
  }
  function gpxPoint(attrs, body) {
    const lat = num((attrs.match(/\blat\s*=\s*["']([^"']+)["']/) || [])[1]);
    const lon = num((attrs.match(/\blon\s*=\s*["']([^"']+)["']/) || [])[1]);
    const t = Date.parse(first(body, 'time') || '');
    const hr = num(first(body, 'hr') ?? first(body, 'heartrate'));
    return { lat, lon, t: isFinite(t) ? t : null, hr: isFinite(hr) && hr > 0 ? hr : null };
  }

  // TCX: <Activity Sport="Running"><Lap><Track><Trackpoint><Time/><Position>…</Position><HeartRateBpm><Value/></HeartRateBpm>
  function parseTcx(text) {
    const act = text.match(new RegExp(`<${tag('Activity')}\\b[^>]*Sport\\s*=\\s*["']([^"']+)["']`));
    const segs = [];
    const trackRe = new RegExp(`<${tag('Track')}\\b[^>]*>([\\s\\S]*?)</${tag('Track')}>`, 'g');
    const tpRe = new RegExp(`<${tag('Trackpoint')}\\b[^>]*>([\\s\\S]*?)</${tag('Trackpoint')}>`, 'g');
    let tm;
    while ((tm = trackRe.exec(text))) {
      const pts = [];
      let pm;
      tpRe.lastIndex = 0;
      while ((pm = tpRe.exec(tm[1]))) {
        const b = pm[1];
        const t = Date.parse(first(b, 'Time') || '');
        const hrBlock = b.match(new RegExp(`<${tag('HeartRateBpm')}\\b[^>]*>([\\s\\S]*?)</${tag('HeartRateBpm')}>`));
        const hr = hrBlock ? num(first(hrBlock[1], 'Value')) : NaN;
        pts.push({
          lat: num(first(b, 'LatitudeDegrees')), lon: num(first(b, 'LongitudeDegrees')),
          t: isFinite(t) ? t : null, hr: isFinite(hr) && hr > 0 ? hr : null,
        });
      }
      segs.push(pts);
    }
    return { segs, sport: sportName(act && act[1]) };
  }

  // Noktalardan uygulamanın yürüyüş kaydını oluştur
  function build(parsed, fallbackTime) {
    const all = parsed.segs.flat();
    const times = all.map((p) => p.t).filter((t) => t !== null);
    const start = times.length ? Math.min(...times) : (fallbackTime || Date.now());
    const hasTime = times.length > 0;
    const segs = [], tts = [];
    let dist = 0, moving = 0;
    for (const s of parsed.segs) {
      const kept = [];
      for (const p of s) {
        if (!isFinite(p.lat) || !isFinite(p.lon) || (p.lat === 0 && p.lon === 0)) continue;
        const last = kept[kept.length - 1];
        if (!last || haversine([last.lat, last.lon], [p.lat, p.lon]) >= 5) kept.push(p);
      }
      if (kept.length < 2) continue;
      for (let i = 1; i < kept.length; i++) {
        const d = haversine([kept[i - 1].lat, kept[i - 1].lon], [kept[i].lat, kept[i].lon]);
        dist += d;
        if (hasTime && kept[i].t !== null && kept[i - 1].t !== null) {
          const dt = kept[i].t - kept[i - 1].t;
          // Uzun aralıkta neredeyse hiç ilerlenmediyse mola: süreye sayma
          const stop = dt > 30000 && d / (dt / 1000) < 0.4;
          if (dt > 0 && !stop) moving += dt;
        }
      }
      segs.push(kept.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]));
      tts.push(kept.map((p) => (p.t !== null ? Math.round((p.t - start) / 1000) : null)));
    }
    if (!segs.length) return null;
    const w = {
      id: 'f' + start.toString(36),
      start,
      end: hasTime ? Math.max(...times) : start,
      dist: Math.round(dist),
      dur: Math.round(moving),
      segs,
      source: 'dosya',
    };
    if (parsed.sport) w.sport = parsed.sport;
    if (hasTime && tts.every((t) => t.every((v) => v !== null))) w.tt = tts;
    // Nabız: ortalama, en yüksek, ~10 sn'de bir örnek
    const hrPts = all.filter((p) => p.hr !== null && p.t !== null).sort((a, b) => a.t - b.t);
    if (hrPts.length) {
      const s = [];
      for (const p of hrPts) {
        const sec = Math.round((p.t - start) / 1000);
        if (!s.length || sec - s[s.length - 1][0] >= 10) s.push([sec, Math.round(p.hr)]);
      }
      w.hr = {
        avg: Math.round(hrPts.reduce((a, p) => a + p.hr, 0) / hrPts.length),
        max: Math.round(Math.max(...hrPts.map((p) => p.hr))),
        s,
      };
    }
    return w;
  }

  function parse(text, filename, fallbackTime) {
    const isTcx = /\.tcx$/i.test(filename || '') || /<(?:\w+:)?TrainingCenterDatabase\b/.test(text);
    const isGpx = /\.gpx$/i.test(filename || '') || /<(?:\w+:)?gpx\b/.test(text);
    if (!isTcx && !isGpx) return null;
    return build(isTcx ? parseTcx(text) : parseGpx(text), fallbackTime);
  }

  const api = { parse, parseGpx, parseTcx, build };
  root.izimImport = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
