// Gathers the built-in page and the OpenUI browser bundle into .cloudflare/assets for wrangler.
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('.cloudflare/assets');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
// The page files only: stories and type declarations stay out of the deployment.
for (const f of fs.readdirSync('web', { withFileTypes: true })) {
  if (f.isFile() && !f.name.endsWith('.d.ts')) fs.copyFileSync(path.join('web', f.name), path.join(out, f.name));
}
const vendor = path.resolve('node_modules/@openuidev/browser-bundle/dist');
for (const f of fs.readdirSync(vendor)) fs.copyFileSync(path.join(vendor, f), path.join(out, 'vendor', f));
// The QR encoder the phone link draws with.
fs.copyFileSync(path.resolve('node_modules/qrcode-generator/dist/qrcode.mjs'), path.join(out, 'vendor', 'qrcode.mjs'));
// The diagram renderer, the version the inbox checks diagrams with.
fs.copyFileSync(path.resolve('node_modules/mermaid/dist/mermaid.min.js'), path.join(out, 'vendor', 'mermaid.min.js'));
console.log(`assets in ${out}`);
