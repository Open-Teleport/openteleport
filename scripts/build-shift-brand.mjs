import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
await import('./build-brand-assets.mjs');
const require = createRequire(import.meta.url);
const sharp = require(process.env.OPENTELEPORT_BRAND_SHARP || 'C:/Users/nadru/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root='site/public/brand/shift';
for(const file of ['favicon.svg','favicon.ico','apple-touch-icon.png']) await fs.copyFile(`${root}/favicon/${file}`,`site/public/${file}`);
await fs.mkdir('site/public/social',{recursive:true});
for(const [source,name] of [['open-graph','og'],['twitter-card','x']]) {
  await sharp(`${root}/banners/banner-${source}.png`).jpeg({quality:92,mozjpeg:true}).toFile(`site/public/social/openteleport-shift-${name}-v1.jpg`);
}
let gallery=await fs.readFile(`${root}/index.html`,'utf8');
gallery=gallery.replaceAll('Aperture v2','Shift').replace('Nowy znak: otwarte O i przenoszony element.','Wybrany znak 02 — Shift: dwa przesunięte moduły.');
await fs.writeFile(`${root}/index.html`,gallery);
