import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const sharp=require(process.env.OPENTELEPORT_BRAND_SHARP || 'C:/Users/nadru/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root='site/public/brand/logo-options-v3';
await fs.mkdir(root,{recursive:true});
const options=[
  {id:'01-link',name:'Link',description:'Dwie połączone formy — agent zachowuje ciągłość między aplikacjami.',shape:`<rect x="8" y="13" width="30" height="38" rx="12" fill="none" stroke="#171717" stroke-width="7"/><rect x="26" y="13" width="30" height="38" rx="12" fill="none" stroke="white" stroke-width="12"/><rect x="26" y="13" width="30" height="38" rx="12" fill="none" stroke="#171717" stroke-width="7"/>`},
  {id:'02-shift',name:'Shift',description:'Dwa przesunięte moduły tworzą jeden znak przeniesienia.',shape:`<path d="M10 16 30 6V44L10 54Z M35 20 55 10V48L35 58Z" fill="#171717"/>`},
  {id:'03-threshold',name:'Próg',description:'Dwa przeciwległe narożniki i element przechodzący przez środek.',shape:`<g fill="none" stroke="#171717" stroke-width="8" stroke-linejoin="round"><path d="M10 28V10H28M36 54H54V36"/></g><rect x="23" y="23" width="18" height="18" rx="4" fill="#171717"/>`},
  {id:'04-monogram',name:'Monogram OT',description:'Litery O i T połączone w jeden zwarty symbol.',shape:`<rect x="8" y="7" width="48" height="50" rx="18" fill="#171717"/><path d="M19 21H45V28H36V47H28V28H19Z" fill="white"/>`},
  {id:'05-passage',name:'Przejście',description:'Dwie spokojne, symetryczne bramy z otwartym przejściem pomiędzy nimi.',shape:`<g fill="none" stroke="#171717" stroke-width="7" stroke-linecap="square" stroke-linejoin="round"><path d="M8 49V23Q8 11 20 11H26V49M38 49V15H44Q56 15 56 27V49"/></g>`},
];
const wrap=(w,h,body)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
for(const o of options){
  const logo=wrap(960,220,`<rect width="960" height="220" fill="white"/><g transform="translate(42 46) scale(2)">${o.shape}</g><text x="210" y="138" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="84" font-weight="600" letter-spacing="-2" fill="#171717">OpenTeleport</text>`);
  await fs.writeFile(`${root}/${o.id}.svg`,logo);
  await sharp(Buffer.from(logo)).png().toFile(`${root}/${o.id}.png`);
  const symbol=wrap(256,256,`<rect width="256" height="256" fill="white"/><g transform="translate(32 32) scale(3)">${o.shape}</g>`);
  await fs.writeFile(`${root}/${o.id}-symbol.svg`,symbol);
  await sharp(Buffer.from(symbol)).png().toFile(`${root}/${o.id}-symbol.png`);
}
await fs.writeFile(`${root}/index.html`,`<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>OpenTeleport — propozycje logo</title><style>body{margin:0;background:white;color:#171717;font:17px/1.6 system-ui,sans-serif}main{max-width:960px;margin:auto;padding:40px 24px}h1{font-size:36px;letter-spacing:-1.5px}section{margin-top:48px;padding-bottom:24px;border-bottom:1px solid #e9edf0}h2{font-size:22px;font-weight:500}p{color:#65686d}img{display:block;width:100%;height:auto}a{color:inherit}small{font-size:14px}</style><main><h1>Pięć nowych znaków</h1><p>Ten sam jasny styl i napis. Zmieniamy tylko symbol. Ikony i favicony pozostają bez zmian do wyboru kierunku. Każda propozycja jest osobnym plikiem PNG oraz SVG.</p>${options.map((o,i)=>`<section><h2>${i+1}. ${o.name}</h2><a href="${o.id}.png"><img src="${o.id}.png" alt="${o.name}: propozycja logo OpenTeleport"></a><p>${o.description}</p><small><a href="${o.id}.png" download>Logo PNG</a> · <a href="${o.id}.svg" download>Logo SVG</a> · <a href="${o.id}-symbol.png" download>Sam znak</a></small></section>`).join('')}</main></html>`);
console.log('Five separate logo proposals saved. Existing brand assets unchanged.');
