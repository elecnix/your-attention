// Gathers the built-in page and the OpenUI browser bundle into .cloudflare/assets for wrangler.
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('.cloudflare/assets');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
for (const f of fs.readdirSync('web')) if (!f.endsWith('.d.ts')) fs.copyFileSync(path.join('web', f), path.join(out, f));
const vendor = path.resolve('node_modules/@openuidev/browser-bundle/dist');
for (const f of fs.readdirSync(vendor)) fs.copyFileSync(path.join(vendor, f), path.join(out, 'vendor', f));
console.log(`assets in ${out}`);
