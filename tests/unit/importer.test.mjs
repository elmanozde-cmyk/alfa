// GPX / TCX içe aktarma
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const imp = createRequire(import.meta.url)('../../importer.js');
const f = (n) => imp.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8'), n, 123);

test('Polar GPX: mesafe, nabız, mola', () => {
  const p = f('polar.gpx');
  assert.ok(Math.abs(p.dist - 2000) < 30, `mesafe ${p.dist}`);
  assert.equal(p.sport, 'Yürüyüş');
  assert.equal(p.hr.max, 129);
  assert.ok(p.hr.s.length > 50);
  assert.equal(Math.round(p.dur / 1000), 1420, '3 dk mola süreye sayılmamalı');
  assert.equal(p.start, Date.parse('2026-10-05T07:00:00Z'));
  assert.equal(p.tt[0].length, p.segs[0].length);
});
test('Strava GPX: koşu, iki parça', () => {
  const s = f('strava.gpx');
  assert.equal(s.sport, 'Koşu');
  assert.equal(s.segs.length, 2);
  assert.equal(s.hr, undefined);
});
test('Garmin TCX: ad alanı önekleri, nabız', () => {
  const g = f('garmin.tcx');
  assert.ok(Math.abs(g.dist - 1075) < 30);
  assert.ok(g.hr.avg >= 120);
});
test('saatsiz GPX: süre 0, tempo verisi yok', () => {
  const n = f('notime.gpx');
  assert.equal(n.dur, 0);
  assert.equal(n.tt, undefined);
  assert.equal(n.start, 123);
});
test('rotasız, bozuk ve yabancı dosyalar alınmaz', () => {
  assert.equal(f('hronly.tcx'), null);
  assert.equal(f('bozuk.gpx'), null);
  assert.equal(imp.parse('merhaba', 'not.txt'), null);
});
