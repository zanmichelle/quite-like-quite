import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PDFDocument, degrees } from 'pdf-lib';
import { run, describe, parseRange, parseCsv, COMMANDS, MM } from '../src/core.js';

const OUT = process.env.OUT_DIR;
if (OUT) mkdirSync(OUT, { recursive: true });
const keep = (name, bytes) => { if (OUT) writeFileSync(`${OUT}/${name}.pdf`, bytes); return bytes; };
const ctx = { fileName: 'test.pdf', loadFont: async () => readFileSync(new URL('../assets/DejaVuSans.ttf', import.meta.url)) };
const sample = (pages = 8, extra = {}) => run('sample', null, { pages, sheet: 'A5', ...extra });
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.02, `${a} ≈ ${b}`);
const size = async (bytes, i = 0) => (await describe(bytes)).sizes[i];
const count = async (bytes) => (await describe(bytes)).pages;

test('parseRange', () => {
  assert.deepEqual(parseRange('all', 3), [0, 1, 2]);
  assert.deepEqual(parseRange('1-2, 5, 7-', 8), [0, 1, 4, 6, 7]);
  assert.deepEqual(parseRange('even', 5), [1, 3]);
  assert.deepEqual(parseRange('odd', 5), [0, 2, 4]);
  assert.deepEqual(parseRange('last', 5), [4]);
  assert.throws(() => parseRange('x', 5));
});

test('parseCsv handles quotes and semicolons', () => {
  assert.deepEqual(parseCsv('a;b\n"x;1";"say ""hi"""\n'), [['a', 'b'], ['x;1', 'say "hi"']]);
});

test('sample', async () => {
  const b = keep('sample', await sample(8));
  assert.equal(await count(b), 8);
  const [w, h] = await size(b); near(w, 148); near(h, 210);
});

test('booklet: 8 pages -> 4 sides of A4 landscape', async () => {
  const b = keep('booklet', await run('booklet', await sample(8), { marks: false }));
  assert.equal(await count(b), 4);
  const [w, h] = await size(b); near(w, 296); near(h, 210);
});

test('booklet pads to a multiple of 4, signatures split', async () => {
  assert.equal(await count(await run('booklet', await sample(5))), 4);
  assert.equal(await count(keep('booklet-sig', await run('booklet', await sample(16), { sheetsPerSig: 2, creep: 2, marks: true, sheet: 'A3', landscape: true }))), 8);
});

test('n-up 2x2 auto sheet and fixed sheet', async () => {
  const a = keep('nup-auto', await run('nup', await sample(8), {}));
  assert.equal(await count(a), 2);
  const [w, h] = await size(a); near(w, 296); near(h, 420);
  const f = keep('nup-a4', await run('nup', await sample(7), { cols: 3, rows: 2, sheet: 'A4', landscape: true, margin: 8, gap: 4, marks: true, order: 'Down then across' }));
  assert.equal(await count(f), 2);
  near((await size(f))[0], 297);
});

test('step & repeat fills the sheet, rotating when more fit', async () => {
  const card = await run('sample', null, { pages: 2, sheet: 'Custom', sheetW: 85, sheetH: 55 });
  const b = keep('step', await run('stepRepeat', card, { sheet: 'A4', margin: 8, gap: 3 }));
  assert.equal(await count(b), 2);
  await assert.rejects(run('stepRepeat', await sample(1, { sheet: 'A3' }), { sheet: 'A4' }), /does not fit/);
});

test('shuffle rule', async () => {
  const b = keep('shuffle', await run('shuffle', await sample(6), { rule: '4* 1 2> 3 0' }));
  assert.equal(await count(b), 10); // 2 groups x 5 outputs, missing pages become blanks
  const doc = await PDFDocument.load(b);
  assert.equal(doc.getPage(0).getRotation().angle, 180);
  assert.equal(doc.getPage(2).getRotation().angle, 90);
});

test('tile splits a page', async () => {
  const b = keep('tile', await run('tile', await sample(2, { sheet: 'A4', landscape: true }), { cols: 2, rows: 1 }));
  assert.equal(await count(b), 4);
  const [w, h] = await size(b); near(w, 148.5); near(h, 210);
});

test('trim & shift', async () => {
  const b = keep('trim', await run('trimShift', await sample(2), { left: 10, top: 5, dx: 3, mirror: true }));
  const [w, h] = await size(b); near(w, 138); near(h, 205);
  await assert.rejects(run('trimShift', await sample(1), { left: 200 }), /larger/);
});

test('adjust size', async () => {
  near((await size(await run('adjustSize', await sample(1), { mode: 'Scale by percent', percent: 50 })))[0], 74);
  const land = await run('adjustSize', await sample(1, { landscape: true }), { mode: 'Scale to fit size', sheet: 'A4' });
  const [w, h] = await size(keep('adjust', land)); near(w, 297); near(h, 210);
  const only = await run('adjustSize', await sample(3), { range: '2', mode: 'Change size, keep content', sheet: 'A3' });
  near((await size(only, 0))[0], 148); near((await size(only, 1))[0], 297);
});

test('bleed grows the page', async () => {
  for (const method of ['Mirror edges', 'Scale up']) {
    const [w, h] = await size(keep('bleed-' + method[0], await run('bleed', await sample(1), { amount: 3, method })));
    near(w, 154); near(h, 216);
  }
});

test('page tools', async () => {
  const s = await sample(6);
  assert.equal(await count(await run('pageTools', s, { action: 'Delete', range: '2-3' })), 4);
  assert.equal(await count(await run('pageTools', s, { action: 'Keep only these', range: 'odd' })), 3);
  assert.equal(await count(await run('pageTools', s, { action: 'Duplicate', range: '1-2', copies: 3 })), 10);
  assert.equal(await count(await run('pageTools', s, { action: 'Duplicate', range: '1-2', copies: 3, collate: true })), 10);
  assert.equal(await count(await run('pageTools', s, { action: 'Move', range: '1', after: 6 })), 6);
  const r = await run('pageTools', s, { action: 'Rotate', range: '1', angle: '90° right' });
  const [w, h] = await size(r); near(w, 210); near(h, 148);
  await assert.rejects(run('pageTools', s, { action: 'Delete', range: 'all' }), /no pages/);
});

test('reverse and insert blanks', async () => {
  assert.equal(await count(await run('reverse', await sample(3))), 3);
  assert.equal(await count(await run('insertBlank', await sample(5), {})), 8);
  assert.equal(await count(await run('insertBlank', await sample(8), {})), 8);
  assert.equal(await count(await run('insertBlank', await sample(5), { mode: 'Fixed number', count: 2, where: 'At the start' })), 7);
  // blank pages survive imposition
  assert.equal(await count(await run('booklet', await run('insertBlank', await sample(5), { where: 'Before the last page' }))), 4);
});

test('insert / interleave another file', async () => {
  const a = await sample(3), b = await sample(3, { sheet: 'A4' });
  assert.equal(await count(await run('insertFile', a, { file: b, copies: 2, where: 'After page…', after: 1 })), 9);
  const mix = await run('insertFile', a, { file: b, where: 'Interleave (this, other, this, other…)', reverseOther: true });
  assert.equal(await count(mix), 6);
  near((await size(mix, 1))[0], 210);
  await assert.rejects(run('insertFile', a, {}), /Choose/);
});

test('stick on text with Slovenian letters, Bates numbers, on a rotated page', async () => {
  const doc = await PDFDocument.load(await sample(3));
  doc.getPage(1).setRotation(degrees(90));
  const b = keep('text', await run('stickText', await doc.save(), { text: 'Št. {n} · {file} · čšž {page}/{pages}', anchor: 'top-right', size: 12, color: '#cc0000' }, ctx));
  assert.equal(await count(b), 3);
  keep('text-std', await run('stickText', await sample(1), { text: 'č {page}' })); // standard font: č falls back to ?
});

test('place page, masking tape, variable data', async () => {
  const logo = await run('sample', null, { pages: 1, sheet: 'Custom', sheetW: 40, sheetH: 20 });
  keep('place', await run('stickPage', await sample(2), { file: logo, anchor: 'top-right', dx: 5, dy: 5 }));
  keep('place-self', await run('stickPage', await sample(3), { sourcePage: 3, range: '1', scale: 30, anchor: 'bottom-left', behind: false }));
  await assert.rejects(run('stickPage', await sample(2), { sourcePage: 9 }), /no page/);
  keep('tape', await run('tape', await sample(1), { color: '#ffcc00' }));
  const vd = keep('vdp', await run('variableData', await sample(2), { csv: 'name;seat\nŽiga;1\nAna;2\nBor;3' }, ctx));
  assert.equal(await count(vd), 6);
});

test('rotated source pages impose upright', async () => {
  const doc = await PDFDocument.load(await sample(4, { landscape: true }));
  doc.getPages().forEach((p) => p.setRotation(degrees(90)));
  const b = keep('rot-nup', await run('nup', await doc.save(), { cols: 2, rows: 1 }));
  const [w, h] = await size(b); near(w, 296); near(h, 210);
});

test('every command has a title, group and help', () => {
  for (const c of Object.values(COMMANDS)) assert.ok(c.title && c.group && c.help && Array.isArray(c.fields));
  assert.ok(MM > 2.8);
});
