// Bundles everything into one self-contained file: imposer.html (open it by double-click, works offline).
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const js = (await build({ entryPoints: ['src/app.js'], bundle: true, minify: true, format: 'iife', target: 'es2021', write: false, legalComments: 'none' })).outputFiles[0].text;
const parts = {
  '/*CSS*/': readFileSync('src/style.css', 'utf8'),
  '/*FONT*/': readFileSync('assets/DejaVuSans.ttf').toString('base64'),
  '/*JS*/': js.replace(/<\/script/gi, '<\\/script'),
};
let html = readFileSync('src/index.html', 'utf8');
for (const [k, v] of Object.entries(parts)) html = html.replace(k, () => v);
writeFileSync('imposer.html', html);
console.log(`imposer.html ${(html.length / 1048576).toFixed(2)} MB`);
