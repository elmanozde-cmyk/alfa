// Polar AccessLink yardımcıları (test edilebilir, ağ ve veritabanı dışarıdan verilir)

export const POLAR_AUTH = 'https://flow.polar.com/oauth2/authorization';
export const POLAR_TOKEN = 'https://polarremote.com/v2/oauth2/token';
export const POLAR_API = 'https://www.polaraccesslink.com/v3';

export type Pt = { lat: number; lon: number; t: number | null };

// GPX içindeki rota noktalarını oku (lat/lon sırası ne olursa olsun)
export function parseGpx(xml: string): Pt[] {
  const out: Pt[] = [];
  const re = /<trkpt\b([^>]*?)(\/>|>([\s\S]*?)<\/trkpt>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const lat = Number((attrs.match(/\blat\s*=\s*["']([^"']+)["']/) || [])[1]);
    const lon = Number((attrs.match(/\blon\s*=\s*["']([^"']+)["']/) || [])[1]);
    if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const tm = m[3] ? m[3].match(/<time>([^<]+)<\/time>/) : null;
    const t = tm ? Date.parse(tm[1].trim()) : NaN;
    out.push({ lat, lon, t: isFinite(t) ? t : null });
  }
  return out;
}

export function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// "PT1H2M3.5S" -> milisaniye
export function isoDurationMs(d: unknown): number | null {
  if (typeof d !== 'string') return null;
  const m = d.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
  if (!m) return null;
  const [, D, H, M, S] = m;
  return Math.round(((+(D || 0) * 24 + +(H || 0)) * 3600 + +(M || 0) * 60 + +(S || 0)) * 1000);
}

// Polar "start_time" yerel saattir; start_time_utc_offset dakika cinsindendir
function polarStart(ex: Record<string, unknown>): number | null {
  const s = ex.start_time;
  if (typeof s !== 'string') return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
  const off = typeof ex.start_time_utc_offset === 'number' ? ex.start_time_utc_offset : 0;
  const t = Date.parse(s + 'Z');
  return isFinite(t) ? t - off * 60000 : null;
}

const SPORTS: Record<string, string> = {
  WALKING: 'Yürüyüş', RUNNING: 'Koşu', HIKING: 'Doğa yürüyüşü', CYCLING: 'Bisiklet',
  NORDIC_WALKING: 'Nordic yürüyüş', TRAIL_RUNNING: 'Arazi koşusu', OTHER_OUTDOOR: 'Açık hava',
};

export function toWalk(id: string, ex: Record<string, unknown>, pts: Pt[]) {
  const kept: Pt[] = [];
  for (const p of pts) {
    const last = kept[kept.length - 1];
    if (!last || haversine([last.lat, last.lon], [p.lat, p.lon]) >= 5) kept.push(p);
  }
  if (kept.length < 2) return null;
  let dist = 0;
  for (let i = 1; i < kept.length; i++) dist += haversine([kept[i - 1].lat, kept[i - 1].lon], [kept[i].lat, kept[i].lon]);
  const start = kept[0].t ?? polarStart(ex) ?? Date.now();
  const durEx = isoDurationMs(ex.duration);
  const lastT = kept[kept.length - 1].t;
  const dur = durEx ?? (lastT ? lastT - start : 0);
  const end = lastT ?? start + dur;
  const hr = ex.heart_rate as { average?: number; maximum?: number } | undefined;
  const sportKey = String(ex.detailed_sport_info || ex.sport || '').toUpperCase();
  const walk: Record<string, unknown> = {
    id, start, end,
    dist: Math.round(typeof ex.distance === 'number' && ex.distance > 0 ? ex.distance : dist),
    dur,
    segs: [kept.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)])],
    ...(kept.every((p) => p.t !== null) ? { tt: [kept.map((p) => Math.round(((p.t as number) - start) / 1000))] } : {}),
    source: 'polar',
    sport: SPORTS[sportKey] || (sportKey ? sportKey.toLowerCase().replace(/_/g, ' ') : 'Polar'),
  };
  if (hr && hr.average) walk.hr = { avg: Math.round(hr.average), max: Math.round(hr.maximum || hr.average) };
  return walk;
}

export interface Db {
  existingIds(ids: string[]): Promise<Set<string>>; // silinmiş olanlar dahil
  saveWalk(id: string, walk: Record<string, unknown>): Promise<void>;
  markSynced(): Promise<void>;
}

// Polar'daki antrenmanları çek, rotası olan ve daha önce alınmamış olanları kaydet
export async function syncPolar(token: string, db: Db, fetchFn: typeof fetch = fetch) {
  const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const lr = await fetchFn(`${POLAR_API}/exercises`, { headers: h });
  if (lr.status === 401 || lr.status === 403) throw new Error('polar_unauthorized');
  if (!lr.ok && lr.status !== 204) throw new Error(`polar_exercises_${lr.status}`);
  const body = lr.status === 204 ? [] : await lr.json();
  const list: Record<string, unknown>[] = Array.isArray(body) ? body : (body?.exercises ?? []);

  const ids = list.map((e) => `polar-${e.id}`);
  const have = ids.length ? await db.existingIds(ids) : new Set<string>();
  let imported = 0, noRoute = 0;
  for (const ex of list) {
    const id = `polar-${ex.id}`;
    if (have.has(id)) continue;
    if (ex.has_route === false) { noRoute++; continue; }
    const gr = await fetchFn(`${POLAR_API}/exercises/${encodeURIComponent(String(ex.id))}/gpx`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/gpx+xml' },
    });
    if (!gr.ok) { noRoute++; continue; }
    const walk = toWalk(id, ex, parseGpx(await gr.text()));
    if (!walk) { noRoute++; continue; }
    await db.saveWalk(id, walk);
    imported++;
  }
  await db.markSynced();
  return { imported, noRoute, total: list.length };
}
