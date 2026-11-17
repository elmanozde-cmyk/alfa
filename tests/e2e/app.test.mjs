// Gerçek tarayıcıda uçtan uca testler (dış servisler taklit edilir)
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startServer, makeDb, newContext, openApp, walkCount, walk, sampleWalk } from './helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.close(); });

test('yürüyüş kaydı: mesafe, keşif ve günlük', async () => {
  const ctx = await newContext(browser);
  const p = await openApp(ctx, server.url);
  await p.click('#bStart');
  await walk(ctx, p, 12);
  assert.match(await p.textContent('#liveExtra'), /GPS iyi/);
  await p.click('#bStop');
  await p.waitForTimeout(300);
  assert.match(await p.textContent('#note'), /Kaydedildi: 0,1\d km/);
  const w = await p.evaluate(() => window.izimDebug.walks()[0]);
  assert.equal(w.tt[0].length, w.segs[0].length, 'her noktanın saati var');
  assert.ok(w.segs[0].length <= 3, 'düz yol sadeleştirildi');
  await p.click('.nav [data-tab=explore]');
  await p.waitForTimeout(300);
  assert.ok(Number(await p.textContent('#eCells')) > 0);
  await p.click('.nav [data-tab=daily]');
  await p.waitForTimeout(300);
  assert.match(await p.textContent('.day-head'), /Bugün/);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('depolama: localStorage → IndexedDB aktarımı ve kalıcılık', async () => {
  const ctx = await newContext(browser, { walks: [sampleWalk('a', 1), sampleWalk('b', 2), sampleWalk('c', 3)] });
  const p = await openApp(ctx, server.url);
  assert.equal(await walkCount(p), 3);
  assert.equal(await p.evaluate(() => localStorage.getItem('izim.walks.v1')), null, 'eski alan boşaltıldı');
  await p.reload(); await p.evaluate(() => window.izimDebug.ready);
  assert.equal(await walkCount(p), 3);
  await p.click('.nav [data-tab=daily]'); await p.waitForTimeout(200);
  await p.click('.day-head'); await p.click('.walk'); await p.waitForTimeout(200);
  await p.click('#detDel'); await p.waitForTimeout(300);
  await p.reload(); await p.evaluate(() => window.izimDebug.ready);
  assert.equal(await walkCount(p), 2, 'silme kalıcı');
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('bulut eşitleme: iki telefon arasında ekleme ve silme', async () => {
  const db = makeDb();
  const A = await newContext(browser, { db, loggedIn: true, walks: [sampleWalk('a', 1), sampleWalk('b', 2), sampleWalk('c', 3)] });
  const pa = await openApp(A, server.url);
  await pa.waitForTimeout(800);
  assert.equal(db.rows.size, 3, 'A yükledi');
  const B = await newContext(browser, { db, loggedIn: true });
  const pb = await openApp(B, server.url);
  await pb.waitForTimeout(800);
  assert.equal(await walkCount(pb), 3, 'B indirdi');
  await pb.click('.nav [data-tab=daily]'); await pb.waitForTimeout(200);
  await pb.click('.day-head'); await pb.click('.walk'); await pb.waitForTimeout(200);
  await pb.click('#detDel'); await pb.waitForTimeout(1500);
  await pa.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await pa.waitForTimeout(1500);
  assert.equal(await walkCount(pa), 2, "B'deki silme A'ya geçti");
  assert.deepEqual([...pa.errors, ...pb.errors], []);
  await A.close(); await B.close();
});

test('GPX/TCX içe aktarma ve antrenman listesi', async () => {
  const ctx = await newContext(browser);
  const p = await openApp(ctx, server.url);
  let alertText = '';
  p.removeAllListeners('dialog');
  p.on('dialog', (d) => { alertText = d.message(); d.accept(); });
  await p.click('.nav [data-tab=daily]');
  await p.click('#dailySeg [data-view=list]');
  const fx = (n) => path.join(ROOT, 'tests/fixtures', n);
  await p.setInputFiles('#fileGpx', [fx('polar.gpx'), fx('strava.gpx'), fx('hronly.tcx')]);
  await p.waitForTimeout(600);
  assert.match(alertText, /2 antrenman eklendi.*1 dosya okunamadı/);
  assert.equal(await p.locator('.trow').count(), 2);
  await p.click('.fchip[data-f=kosu]');
  assert.equal(await p.locator('.trow').count(), 1);
  await p.setInputFiles('#fileGpx', [fx('polar.gpx')]);
  await p.waitForTimeout(400);
  assert.match(alertText, /0 antrenman eklendi, 1 tanesi zaten vardı/);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('nabız (Web Bluetooth) ve kayda işlenmesi', async () => {
  const ctx = await newContext(browser, {
    init: () => {
      const dev = new EventTarget(); dev.name = 'Test bandı';
      dev.gatt = { connect: async () => ({ getPrimaryService: async () => ({ getCharacteristic: async () => {
        const ch = new EventTarget();
        ch.startNotifications = async () => setInterval(() => { ch.value = new DataView(new Uint8Array([0, 130]).buffer); ch.dispatchEvent(new Event('characteristicvaluechanged')); }, 500);
        return ch;
      } }) }), disconnect() {} };
      Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => dev } });
    },
  });
  const p = await openApp(ctx, server.url);
  await p.click('#bHr'); await p.waitForTimeout(800);
  assert.match(await p.textContent('#bHr'), /130 bpm/);
  await p.click('#bStart');
  await walk(ctx, p, 6);
  await p.click('#bStop'); await p.waitForTimeout(300);
  const hr = await p.evaluate(() => window.izimDebug.walks()[0].hr);
  assert.equal(hr.avg, 130);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('Android köprüsü: arka plan servisi kayıtla açılıp kapanır', async () => {
  const ctx = await newContext(browser, {
    init: () => {
      window.__log = []; let cb = null, n = 0;
      window.izimNative = {
        isNative: true,
        async startTracking(onLoc) { cb = onLoc; window.__log.push('aç'); return 'w' + (++n); },
        async stopTracking() { cb = null; window.__log.push('kapat'); },
        openSettings() {}, async hrConnect() { return { id: 'x', name: 'x' }; }, async hrAttach() {}, async hrDisconnect() {},
      };
      window.__send = (lat) => cb && cb({ latitude: lat, longitude: 29.025, accuracy: 5, time: Date.now() });
    },
  });
  const p = await openApp(ctx, server.url);
  await p.click('#bStart'); await p.waitForTimeout(300);
  assert.match(await p.textContent('#note'), /Ekranı kapatabilirsin/);
  let la = 40.99;
  for (let i = 0; i < 6; i++) { la += 0.00009; await p.evaluate((l) => window.__send(l), la); await p.waitForTimeout(1050); }
  await p.click('#bPause'); await p.click('#bPause'); await p.waitForTimeout(200);
  await p.click('#bStop'); await p.waitForTimeout(300);
  assert.deepEqual(await p.evaluate(() => window.__log), ['aç', 'kapat', 'aç', 'kapat']);
  assert.ok((await p.evaluate(() => window.izimDebug.walks()[0].dist)) > 40);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});
