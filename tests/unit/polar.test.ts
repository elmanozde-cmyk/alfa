import { parseGpx, toWalk, syncPolar, isoDurationMs } from '../../supabase/functions/polar/lib.ts';
const assert = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok -', m); };

// Polar tarzı GPX (lon önce, saat bilgili, bir de bozuk nokta)
const pts = Array.from({ length: 40 }, (_, i) => `<trkpt lon="${(29.025 + i * 0.0001).toFixed(6)}" lat="40.990000"><ele>10</ele><time>2026-11-15T07:${String(i).padStart(2,'0')}:00.000Z</time></trkpt>`).join('\n');
const gpx = `<?xml version="1.0"?><gpx><trk><trkseg>${pts}<trkpt lat="0" lon="0"/></trkseg></trk></gpx>`;
const p = parseGpx(gpx);
assert(p.length === 40, '40 nokta okundu, (0,0) atıldı');
assert(p[0].t === Date.parse('2026-11-15T07:00:00Z'), 'zaman okundu');
assert(isoDurationMs('PT1H2M3.5S') === 3723500, 'süre biçimi çözüldü');
const w = toWalk('polar-1', { distance: 3300, duration: 'PT39M', heart_rate: { average: 121.4, maximum: 155 }, sport: 'WALKING' }, p)!;
assert(w.dist === 3300 && w.dur === 39 * 60000 && (w.hr as any).avg === 121 && w.sport === 'Yürüyüş', 'yürüyüş bilgileri doğru');
assert((w.segs as any)[0].length === 40 && w.source === 'polar', 'rota ve kaynak doğru');
assert((w.tt as any)[0][0] === 0 && (w.tt as any)[0][39] === 39 * 60, 'nokta saatleri saklandı');


// Senkronizasyon: 4 antrenman — 1 zaten var (silinmiş), 1 rotasız, 1 GPX hatalı, 1 yeni
const calls: string[] = [];
const fakeFetch = (async (url: string) => {
  calls.push(url.replace('https://www.polaraccesslink.com/v3', ''));
  if (url.endsWith('/exercises')) return new Response(JSON.stringify([
    { id: 'old', has_route: true }, { id: 'noroute', has_route: false }, { id: 'bad', has_route: true },
    { id: 'new', has_route: true, start_time: '2026-11-16T09:00:00', start_time_utc_offset: 180, duration: 'PT20M', sport: 'RUNNING' },
  ]), { status: 200 });
  if (url.includes('/bad/')) return new Response('nope', { status: 404 });
  if (url.includes('/new/gpx')) return new Response(gpx.replace(/<time>[^<]*<\/time>/g, ''), { status: 200 });
  return new Response('?', { status: 500 });
}) as typeof fetch;
const saved: Record<string, any> = {}; let marked = false;
const r = await syncPolar('TOKEN', {
  existingIds: async (ids) => new Set(ids.filter((i) => i === 'polar-old')),
  saveWalk: async (id, walk) => { saved[id] = walk; },
  markSynced: async () => { marked = true; },
}, fakeFetch);
assert(r.imported === 1 && r.noRoute === 2 && r.total === 4, 'sonuç: 1 alındı, 2 rotasız/hatalı');
assert(Object.keys(saved).join() === 'polar-new', 'silinmiş antrenman geri gelmedi');
assert(!calls.some((c) => c.includes('/old/') || c.includes('/noroute/')), 'gereksiz GPX istenmedi');
assert(saved['polar-new'].start === Date.parse('2026-11-16T06:00:00Z'), 'Polar yerel saati UTC\'ye çevrildi (+03:00)');
assert(saved['polar-new'].sport === 'Koşu' && marked, 'spor türü ve son çekme zamanı');
assert(saved['polar-new'].tt === undefined, 'saatsiz GPX: tempo verisi yok');
let threw = '';
await syncPolar('X', { existingIds: async () => new Set(), saveWalk: async () => {}, markSynced: async () => {} },
  (async () => new Response('', { status: 401 })) as typeof fetch).catch((e) => (threw = e.message));
assert(threw === 'polar_unauthorized', 'yetkisiz anahtar hatası anlaşılır');
console.log('HEPSİ GEÇTİ');
