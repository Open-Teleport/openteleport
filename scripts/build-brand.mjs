import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require(process.env.OPENTELEPORT_BRAND_SHARP || 'C:/Users/nadru/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const out = path.resolve('site/public/brand');
await fs.mkdir(out, { recursive: true });
const ink = '#06050b', cream = '#ede7db', amber = '#e4b46e';
const svg = (w,h,body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const mark = (color=amber) => `<g fill="none" stroke="${color}" stroke-width="5" stroke-linecap="square" stroke-linejoin="miter"><path d="M49 15 A23 23 0 1 0 49 49"/><path d="M26 32H59M51 24L59 32L51 40"/></g>`;
const text = (x,y,size,content,color=cream,extra='') => `<text x="${x}" y="${y}" fill="${color}" ${extra.includes('font-family=')?'':'font-family="Segoe UI, Arial, sans-serif"'} font-size="${size}" ${extra}>${content}</text>`;
const word = (x,y,size,color) => text(x,y,size,'OpenTeleport',color,'font-weight="600" letter-spacing="-2"');
async function save(name,source,png=true) {
  await fs.writeFile(path.join(out,`${name}.svg`),source);
  if(png) await sharp(Buffer.from(source)).png().toFile(path.join(out,`${name}.png`));
}
for (const [name,fg,accent,bg] of [['dark',cream,amber,ink],['light',ink,ink,'#f5f5f3'],['white', '#ffffff','#ffffff',null],['black',ink,ink,null],['color',cream,amber,null]]) {
  await save(`logo-horizontal-${name}`,svg(720,128,`${bg?`<rect width="720" height="128" fill="${bg}"/>`:''}<g transform="translate(24 24) scale(1.25)">${mark(accent)}</g>${word(126,86,70,fg)}`));
  await save(`logo-stacked-${name}`,svg(600,400,`${bg?`<rect width="600" height="400" fill="${bg}"/>`:''}<g transform="translate(204 50) scale(3)">${mark(accent)}</g>${word(91,328,66,fg)}`));
  await save(`mark-${name}`,svg(256,256,`${bg?`<rect width="256" height="256" fill="${bg}"/>`:''}<g transform="translate(32 32) scale(3)">${mark(accent)}</g>`));
}
for(const [name,bg,fg] of [['dark',ink,amber],['light','#f5f5f3',ink],['amber',amber,ink]]) {
  await save(`avatar-${name}`,svg(1024,1024,`<rect width="1024" height="1024" fill="${bg}"/><g transform="translate(192 192) scale(10)">${mark(fg)}</g>`));
}
const favicon=svg(64,64,`<rect width="64" height="64" rx="14" fill="${ink}"/><g transform="translate(4 4) scale(.875)">${mark()}</g>`);
await fs.writeFile(path.resolve('site/public/favicon.svg'),favicon);
for(const n of [16,32,48,180,192,512]) await sharp(Buffer.from(favicon)).resize(n,n).png().toFile(path.join(out,`icon-${n}.png`));
await fs.copyFile(path.join(out,'icon-180.png'),path.resolve('site/public/apple-touch-icon.png'));
const icoPng = await sharp(Buffer.from(favicon)).resize(32,32).png().toBuffer();
const ico = Buffer.alloc(22); ico.writeUInt16LE(1,2); ico.writeUInt16LE(1,4); ico[6]=32;ico[7]=32;ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(icoPng.length,14);ico.writeUInt32LE(22,18);
await fs.writeFile(path.resolve('site/public/favicon.ico'),Buffer.concat([ico,icoPng]));
// A repeating vector texture complements the photographic campaign backgrounds.
await save('background-grid',svg(1920,1080,`<defs><pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse"><path d="M80 0H0V80" fill="none" stroke="${cream}" stroke-opacity=".055"/></pattern><radialGradient id="glow"><stop stop-color="${amber}" stop-opacity=".16"/><stop offset="1" stop-color="${ink}" stop-opacity="0"/></radialGradient></defs><rect width="1920" height="1080" fill="${ink}"/><rect width="1920" height="1080" fill="url(#grid)"/><ellipse cx="1430" cy="540" rx="600" ry="520" fill="url(#glow)"/><g transform="translate(1180 284) scale(8)">${mark()}</g>`));
const photo=path.join(out,'background-portal.png');
let hasPhoto=false;try{await fs.access(photo);hasPhoto=true;}catch{}
for (const [name,w,h] of [['banner-x',1500,500],['banner-linkedin',1584,396],['banner-github',1280,640],['social-og',1200,630],['banner-community',1920,1080]]) {
  const compact=h<510;
  const x=name==='banner-x'?390:Math.round(w*.065);
  const y=compact?Math.round(h*.25):Math.round(h*.18);
  const size=compact?49:Math.round(w*.047);
  const label=svg(w,h,`<defs><linearGradient id="shade"><stop stop-color="${ink}" stop-opacity=".96"/><stop offset=".68" stop-color="${ink}" stop-opacity=".6"/><stop offset="1" stop-color="${ink}" stop-opacity=".1"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#shade)"/><g transform="translate(${x} ${y}) scale(.8)">${mark()}</g>${word(x+68,y+40,size,cream)}${text(x,y+(compact?112:156),compact?29:Math.round(w*.041),'Your agent. Anywhere.',cream,'font-family="Georgia, serif"')}${text(x,y+(compact?157:218),compact?16:20,'Move your AI agent between apps in one command.',cream)}${text(x,h-36,13,'openteleport.dev',amber,'letter-spacing="2"')}`);
  const base=await sharp(hasPhoto?photo:path.join(out,'background-grid.png')).resize(w,h,{fit:'cover',position:'centre'}).toBuffer();
  await sharp(base).composite([{input:Buffer.from(label)}]).png().toFile(path.join(out,`${name}.png`));
}
if(hasPhoto) {
  await sharp(photo).resize(1920,1080,{fit:'cover'}).jpeg({quality:90}).toFile(path.join(out,'wallpaper-desktop.jpg'));
  await sharp(photo).resize(1080,1920,{fit:'cover',position:'right'}).jpeg({quality:90}).toFile(path.join(out,'wallpaper-mobile.jpg'));
}
// A compact contact sheet for checking the complete identity at once.
const board=svg(1600,1200,`<rect width="1600" height="1200" fill="${ink}"/>${text(60,65,15,'OPENTELEPORT / VISUAL IDENTITY',amber,'letter-spacing="4"')}<path d="M60 95H1540" stroke="${cream}" stroke-opacity=".2"/>${word(60,220,100,cream)}${text(62,276,25,'Your agent. Anywhere.',cream)}${text(60,1100,16,'VOID  #06050B     IVORY  #EDE7DB     AMBER  #E4B46E',amber)}${text(60,1140,16,'Open portal / portable identity / one command',cream)}`);
const overlays=[];
for(const [file,left,top,width,height] of [['avatar-dark.png',60,330,230,230],['avatar-light.png',310,330,230,230],['avatar-amber.png',560,330,230,230],['logo-horizontal-light.png',860,345,680,121],['social-og.png',60,620,720,378],['banner-x.png',820,620,720,240]]) overlays.push({input:await sharp(path.join(out,file)).resize(width,height).toBuffer(),left,top});
await sharp(Buffer.from(board)).composite(overlays).png().toFile(path.join(out,'brand-preview.png'));
console.log(`Brand assets saved to ${out}; photographic background: ${hasPhoto}`);
