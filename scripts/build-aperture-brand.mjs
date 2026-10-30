import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require(process.env.OPENTELEPORT_BRAND_SHARP || 'C:/Users/nadru/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root = path.resolve('site/public/brand/aperture-v2');
for (const dir of ['favicon', 'icons', 'avatars', 'logos', 'backgrounds', 'banners', 'source']) await fs.mkdir(path.join(root, dir), {recursive:true});
const white = '#ffffff', ink = '#171717', grey = '#e9edf0';
const svg = (w,h,body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
// An open O carries a displaced square. One geometry is used at every size.
const mark = (color=ink) => `<g fill="none" stroke="${color}" stroke-width="8" stroke-linejoin="round"><path d="M44 19V18C44 12 39 8 32 8H25C17 8 12 14 12 22V42C12 50 17 56 25 56H32C39 56 44 52 44 45"/></g><rect x="39" y="26" width="14" height="12" rx="2" fill="${color}"/>`;
const type = (x,y,size,content,color=ink,extra='') => `<text x="${x}" y="${y}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${size}" fill="${color}" ${extra}>${content}</text>`;
const word = (x,y,size,color=ink) => type(x,y,size,'OpenTeleport',color,'font-weight="600" letter-spacing="-1.8"');
async function save(name, data) {
  await fs.writeFile(path.join(root, name+'.svg'), data);
  await sharp(Buffer.from(data)).png().toFile(path.join(root,name+'.png'));
}
for(const [name,color,bg] of [['black-transparent',ink,null],['white-transparent',white,null],['on-white',ink,white],['on-charcoal',white,ink]]) {
  const back = (w,h) => bg?`<rect width="${w}" height="${h}" fill="${bg}"/>`:'';
  await save('logos/logo-horizontal-'+name, svg(960,160,back(960,160)+`<g transform="translate(30 32) scale(1.5)">${mark(color)}</g>`+word(140,111,94,color)));
  await save('logos/logo-stacked-'+name, svg(640,480,back(640,480)+`<g transform="translate(224 56) scale(3)">${mark(color)}</g>`+word(74,370,80,color)));
  await save('logos/wordmark-'+name, svg(840,140,back(840,140)+word(24,102,100,color)));
  await save('logos/symbol-'+name, svg(512,512,back(512,512)+`<g transform="translate(64 64) scale(6)">${mark(color)}</g>`));
}
for(const [name,bg,color] of [['white',white,ink],['grey',grey,ink],['charcoal',ink,white]]) {
  const source=svg(1024,1024,`<rect width="1024" height="1024" fill="${bg}"/><g transform="translate(192 192) scale(10)">${mark(color)}</g>`);
  await save('avatars/avatar-'+name,source);
}
const icon = svg(512,512,`<rect width="512" height="512" rx="112" fill="${white}"/><g transform="translate(80 80) scale(5.5)">${mark()}</g>`);
await fs.writeFile(path.join(root,'icons/app-icon.svg'),icon);
for(const size of [64,128,192,256,512,1024]) await sharp(Buffer.from(icon)).resize(size,size).png().toFile(path.join(root,`icons/app-icon-${size}.png`));
const fav = svg(64,64,`<rect width="64" height="64" rx="12" fill="white"/><g transform="translate(6 6) scale(.8125)">${mark()}</g>`);
await fs.writeFile(path.join(root,'favicon/favicon.svg'),fav);
for(const size of [16,32,48,64,180]) await sharp(Buffer.from(fav)).resize(size,size).png().toFile(path.join(root,`favicon/${size===180?'apple-touch-icon':'favicon-'+size}.png`));
const frames=[]; for(const size of [16,32,48]) frames.push(await sharp(Buffer.from(fav)).resize(size,size).png().toBuffer());
const header=Buffer.alloc(6+16*frames.length);header.writeUInt16LE(1,2);header.writeUInt16LE(frames.length,4);let offset=header.length;
frames.forEach((data,i)=>{const p=6+i*16;header[p]=[16,32,48][i];header[p+1]=[16,32,48][i];header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(data.length,p+8);header.writeUInt32LE(offset,p+12);offset+=data.length;});
await fs.writeFile(path.join(root,'favicon/favicon.ico'),Buffer.concat([header,...frames]));
await fs.writeFile(path.join(root,'icons/site.webmanifest'),JSON.stringify({name:'OpenTeleport',short_name:'OpenTeleport',icons:[192,512].map(s=>({src:`app-icon-${s}.png`,sizes:`${s}x${s}`,type:'image/png',purpose:'any'})),theme_color:white,background_color:white,display:'standalone',start_url:'/'},null,2));
// Each background and each banner is a separate deliverable. No contact sheets.
for (const [file,w,h,source,position] of [['desktop',1920,1080,'background-desktop','centre'],['mobile',1080,1920,'background-mobile','centre'],['wide',2400,800,'banner-wide','centre'],['square',1080,1080,'social-square','centre']]) {
  await sharp(path.join(root,'source',source+'.png')).resize(w,h,{fit:'cover',position}).jpeg({quality:94,mozjpeg:true}).toFile(path.join(root,'backgrounds',`background-${file}.jpg`));
}
for(const [name,w,h,source] of [['x',1500,500,'banner-wide'],['linkedin',1584,396,'banner-wide'],['github',1280,640,'background-desktop'],['open-graph',1200,630,'background-desktop'],['social-post',1080,1080,'social-square']]) {
  const square=w===h; const short=h<510; const x=name==='x'?370:Math.round(w*.06);const y=Math.round(h*(square?.09:short?.21:.18));
  const font=short?45:square?64:54;
  const branding = `<g transform="translate(${x} ${y}) scale(.82)">${mark()}</g>${word(x+67,y+39,font)}${type(x,y+(short?108: square?143:150),short?27:square?39:38,'Your agent. Anywhere.',ink,'letter-spacing="-1"')}${square?'':type(x,y+(short?153:203),short?16:19,'Move your AI agent between apps in one command.','#5d6268')}${type(x,h-34,14,'openteleport.dev','#5d6268')}`;
  const base=await sharp(path.join(root,'source',source+'.png')).resize(w,h,{fit:'cover'}).toBuffer();
  // A soft white field protects copy while preserving the reference's physical shadows.
  const overlay=svg(w,h,`<defs><linearGradient id="veil"><stop stop-color="white" stop-opacity=".85"/><stop offset=".58" stop-color="white" stop-opacity=".45"/><stop offset="1" stop-color="white" stop-opacity="0"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#veil)"/>${branding}`);
  await sharp(base).composite([{input:Buffer.from(overlay)}]).png().toFile(path.join(root,'banners',`banner-${name}.png`));
}
const dirs=['favicon','icons','avatars','logos','backgrounds','banners'];let entries=[];
for(const dir of dirs) for(const file of await fs.readdir(path.join(root,dir))) {
  if(!/\.(svg|png|jpg)$/.test(file)) continue;
  const info=await sharp(path.join(root,dir,file)).metadata();
  entries.push({category:dir,file:dir+'/'+file,width:info.width,height:info.height,format:info.format,alpha:info.hasAlpha});
}
await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(entries,null,2));
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
const gallery=dirs.map(dir=>`<h2>${dir}</h2><div class="grid">${entries.filter(e=>e.category===dir&&!e.file.endsWith('.svg')).map(e=>`<a href="${e.file}" download><figure class="${e.file.includes('white-transparent')?'dark':''}"><img src="${e.file}" alt="${e.file}" loading="lazy"></figure><span>${esc(e.file.split('/')[1])}<small>${e.width} × ${e.height}</small></span></a>`).join('')}</div>`).join('');
await fs.writeFile(path.join(root,'index.html'),`<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>OpenTeleport — Aperture v2</title><style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#171717;font:16px/1.5 system-ui,sans-serif}main{max-width:1240px;margin:auto;padding:48px 24px}h1{font-size:42px;letter-spacing:-2px}h2{margin-top:52px;font-weight:500}p{max-width:760px;color:#5d6268}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px}a{color:inherit;text-decoration:none}figure{margin:0;display:grid;place-items:center;height:220px;background:#f5f6f7;border:1px solid #e9edf0;border-radius:12px;overflow:hidden}figure.dark{background:#171717}img{max-width:100%;max-height:100%;object-fit:contain}span{display:block;padding:12px 0;font-size:14px}small{display:block;color:#70757a}</style><main><h1>OpenTeleport / Aperture v2</h1><p>Każdy materiał jest osobnym plikiem. Kliknij obraz, aby pobrać PNG lub JPG. W folderach logo, avatary i ikony są też w SVG. Paleta: white #FFFFFF, charcoal #171717, cool grey #E9EDF0.</p><p>Nowy znak: otwarte O i przenoszony element. Białe fizyczne portale zachowują wybrany styl. Logo używa Segoe UI Semibold; PNG zachowują gotowy wygląd, SVG zawierają edytowalny tekst. Zachowaj wolne miejsce wokół znaku co najmniej 1/4 jego szerokości; minimalny rozmiar logo z napisem 160 px. W mniejszych rozmiarach użyj symbolu.</p><p>Banery mają docelowe wymiary. X pozostawia miejsce na avatar po lewej. Sprawdź kadrowanie w docelowym serwisie. Pliki źródłowe i prompty imagegen są w source/. Galeria jest lokalną paczką materiałów; witryna nie jest automatycznie publikowana.</p>${gallery}</main></html>`);
console.log(`${entries.length} independently saved image files verified in ${root}`);
