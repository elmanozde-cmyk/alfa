// Keşif sisi: her karenin merkezinde "sis var mı" sorusunun doğru cevabı verilmeli.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const fog = createRequire(import.meta.url)('../../fog.js');

const N = 2 ** 19, X0 = 300000, Y0 = 200000;
const lng = (x) => x / N * 360 - 180;
const lat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / N))) * 180 / Math.PI;
const inRing = (pt, ring) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const fogged = (gj, pt) => gj.features.some((f) => {
  const [outer, ...holes] = f.geometry.coordinates;
  return inRing(pt, outer) && !holes.some((h) => inRing(pt, h));
});
function wrongCells(cells) {
  const keys = new Set(cells.map(([x, y]) => `${X0 + x},${Y0 + y}`));
  const gj = fog.build(keys);
  let bad = 0;
  for (let x = -3; x < 14; x++) for (let y = -3; y < 14; y++) {
    const want = !keys.has(`${X0 + x},${Y0 + y}`);
    if (fogged(gj, [lng(X0 + x + 0.5), lat(Y0 + y + 0.5)]) !== want) bad++;
  }
  return bad;
}
const sq = (x0, y0, w, h) => { const o = []; for (let x = x0; x < x0 + w; x++) for (let y = y0; y < y0 + h; y++) o.push([x, y]); return o; };
const ring = (x0, y0, n) => sq(x0, y0, n, n).filter(([x, y]) => x === x0 || y === y0 || x === x0 + n - 1 || y === y0 + n - 1);

const cases = {
  'boş': [],
  'tek kare': [[0, 0]],
  'çapraz değen kareler': [[0, 0], [1, 1]],
  'dama tahtası': sq(0, 0, 6, 6).filter(([x, y]) => (x + y) % 2 === 0),
  'ortası boş halka': ring(0, 0, 5),
  'halka içinde ada': [...ring(0, 0, 7), [3, 3]],
  'iç içe halkalar': [...ring(0, 0, 9), ...ring(2, 2, 5), [4, 4]],
};
for (const [name, cells] of Object.entries(cases)) test(name, () => assert.equal(wrongCells(cells), 0));

test('rastgele 30 dağılım', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let t = 0; t < 30; t++) assert.equal(wrongCells(sq(0, 0, 11, 11).filter(() => rnd() < 0.2 + t * 0.02)), 0, `dağılım ${t}`);
});

test('20.000 kare 1 saniyenin altında', () => {
  const big = new Set();
  for (let i = 0; i < 20000; i++) big.add(`${X0 + Math.floor(i / 140)},${Y0 + (i % 140) * (i % 7 ? 1 : 2)}`);
  const t0 = Date.now(); fog.build(big);
  assert.ok(Date.now() - t0 < 1000);
});
