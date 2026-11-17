// Android uygulaması için web dosyalarını www/ klasörüne toplar ve Android köprüsünü paketler.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const FILES = ['index.html', 'app.js', 'fog.js', 'importer.js', 'mapstyle.js', 'manifest.webmanifest', 'icon.svg'];

rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const f of FILES) copyFileSync(f, `www/${f}`);

await build({
  entryPoints: ['native/native.js'],
  bundle: true,
  format: 'iife',
  minify: true,
  target: ['chrome100'],
  outfile: 'www/native.js',
});

// Köprüyü uygulama kodundan önce yükle
const html = readFileSync('www/index.html', 'utf8');
const anchor = '<script src="mapstyle.js';
if (!html.includes(anchor)) throw new Error('index.html içinde mapstyle.js bulunamadı');
writeFileSync('www/index.html', html.replace(anchor, '<script src="native.js"></script>\n' + anchor));
console.log('www/ hazır:', FILES.length + 1, 'dosya');
