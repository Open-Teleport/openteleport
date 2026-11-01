import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../site/dist/',import.meta.url));
const html=await fs.readFile(path.join(root,'index.html'),'utf8');
const robots=await fs.readFile(path.join(root,'robots.txt'),'utf8');
const meta=new Map([...html.matchAll(/<meta\s+[^>]*>/g)].map(([tag])=>{
  const attrs=Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map(([,key,value])=>[key,value]));
  return [attrs.name??attrs.property,attrs.content];
}));
assert.equal(meta.get('twitter:card'),'summary_large_image');
for(const [key,w,h] of [['og:image',1200,630],['twitter:image',1200,600]]) {
  const url=new URL(meta.get(key));assert.equal(url.origin,'https://openteleport.dev');
  // Guard the actual regression: the preview asset must not be disallowed by robots.txt.
  const rules=[...robots.matchAll(/^(Allow|Disallow):\s*(\S+)/gm)].filter(([, ,prefix])=>url.pathname.startsWith(prefix)).sort((a,b)=>b[2].length-a[2].length);
  assert.notEqual(rules[0]?.[1],'Disallow',`${key} is blocked by robots.txt`);
  const bytes=await fs.readFile(path.join(root,url.pathname.slice(1)));
  assert.ok(bytes.length<5_000_000);assert.equal(bytes.readUInt16BE(0),0xffd8,'Preview must be a JPEG');
  let dims;for(let i=2;i<bytes.length;){assert.equal(bytes[i],0xff);const marker=bytes[i+1];const len=bytes.readUInt16BE(i+2);if([0xc0,0xc1,0xc2].includes(marker)){dims=[bytes.readUInt16BE(i+7),bytes.readUInt16BE(i+5)];break;}i+=len+2;}
  assert.deepEqual(dims,[w,h]);console.log(`${key}: ${dims.join('×')}, ${bytes.length} bytes, crawler access allowed`);
}
assert.equal(meta.get('og:image:type'),'image/jpeg');
assert.ok(meta.get('twitter:image:alt'));
assert.ok(meta.get('og:image:alt'));
console.log('Built social metadata and preview assets verified.');
