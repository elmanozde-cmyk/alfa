// Uçtan uca test yardımcıları: küçük bir web sunucusu ve dış servisleri taklit eden tarayıcı bağlamı
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.css': 'text/css',
};

export async function startServer() {
  const srv = http.createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

// Sunucu tarafını taklit eden bellek içi Supabase tablosu (iki "telefon" aynı nesneyi paylaşabilir)
export function makeDb() {
  const rows = new Map();
  let clock = Date.parse('2026-11-17T10:00:00Z');
  const fn = async (q) => {
    if (q.op === 'upsert') { for (const r of q.rows) rows.set(r.id, { ...r, updated_at: new Date(clock++).toISOString() }); return { error: null }; }
    if (q.op === 'polar_status') return { data: null, error: null };
    if (q.op === 'fn') return { data: { linked: false } };
    const all = [...rows.values()].filter((r) => new Date(r.updated_at) > new Date(q.since))
      .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
    return { data: all.slice(q.from, q.to + 1), error: null };
  };
  fn.rows = rows;
  return fn;
}

export async function newContext(browser, { db, walks, loggedIn, init, ...opts } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    geolocation: { latitude: 40.99, longitude: 29.025, accuracy: 5 },
    permissions: ['geolocation'],
    ...opts,
  });
  await ctx.route(/jsdelivr|openfreemap|openstreetmap|nominatim|cartocdn/, (r) => r.abort());
  await ctx.route(/cdnjs.*leaflet\.min\.js/, (r) => r.fulfill({ path: path.join(ROOT, 'node_modules/leaflet/dist/leaflet.js'), contentType: 'text/javascript' }));
  await ctx.route(/cdnjs.*leaflet\.min\.css/, (r) => r.fulfill({ path: path.join(ROOT, 'node_modules/leaflet/dist/leaflet.css'), contentType: 'text/css' }));
  await ctx.route(/supabase-js/, (r) => r.fulfill({ path: path.join(ROOT, 'tests/e2e/supabase-mock.js'), contentType: 'text/javascript' }));
  await ctx.exposeFunction('__db', db || makeDb());
  if (walks) await ctx.addInitScript((w) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('izim.walks.v1', JSON.stringify(w)); sessionStorage.setItem('seeded', '1'); } }, walks);
  if (loggedIn) await ctx.addInitScript(() => localStorage.setItem('mockAuth', '1'));
  if (init) await ctx.addInitScript(init);
  return ctx;
}

export async function openApp(ctx, url) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(url);
  await page.evaluate(() => window.izimDebug.ready);
  await page.waitForTimeout(300);
  return page;
}

export const walkCount = (page) => page.evaluate(() => window.izimDebug.walks().length);

// Kuzeye doğru yürü: her adım ~10 m, ~1 sn arayla (gerçekçi hız)
export async function walk(ctx, page, steps, from = [40.99, 29.025], stepDeg = 0.00009) {
  let [la, lo] = from;
  for (let i = 0; i < steps; i++) {
    la += stepDeg;
    await ctx.setGeolocation({ latitude: la, longitude: lo, accuracy: 5 });
    await page.waitForTimeout(1050);
  }
  return [la, lo];
}

export function sampleWalk(id, daysAgo, extra = {}) {
  const start = Date.now() - daysAgo * 864e5;
  return { id, start, end: start + 6e5, dist: 1000 + daysAgo, dur: 6e5, segs: [[[40.99, 29.025], [40.991, 29.026], [40.992, 29.025]]], ...extra };
}
