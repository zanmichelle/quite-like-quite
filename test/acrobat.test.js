// Runs the Acrobat plug-in against a small stand-in for Acrobat's JavaScript API.
// This checks the plug-in's own logic (page order, sizes, positions) — not Acrobat itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as acorn from 'acorn';

const code = readFileSync(new URL('../acrobat/Imposer.js', import.meta.url), 'utf8');
const MM = 72 / 25.4;
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.05, `${a} ≈ ${b}`);

function acrobat() {
  const files = {}; let saved = 0;
  const mkPage = (w, h) => ({ box: [0, h, w, 0], media: [0, h, w, 0], rot: 0, marks: [], annots: 0 });
  const clone = (p) => ({ ...p, box: [...p.box], media: [...p.media], marks: [...p.marks] });
  class Doc {
    constructor(pages) { this.pages = pages; this.path = ''; this.dirty = true; this.documentFileName = 'x.pdf'; }
    get numPages() { return this.pages.length; }
    getPageBox({ cBox = 'Crop', nPage = 0 }) { return [...(cBox === 'Media' ? this.pages[nPage].media : this.pages[nPage].box)]; }
    setPageBoxes({ cBox, nStart, rBox }) { this.pages[nStart][cBox === 'Media' ? 'media' : 'box'] = [...rBox]; }
    getPageRotation({ nPage }) { return this.pages[nPage].rot; }
    setPageRotations({ nStart, nEnd, nRotate }) { for (let i = nStart; i <= nEnd; i++) this.pages[i].rot = nRotate; }
    newPage({ nWidth, nHeight }) { this.pages.push(mkPage(nWidth, nHeight)); }
    insertPages({ nPage, cPath, nStart, nEnd }) { this.pages.splice(nPage + 1, 0, ...files[cPath].slice(nStart, nEnd + 1).map(clone)); }
    deletePages({ nStart, nEnd }) { this.pages.splice(nStart, nEnd - nStart + 1); }
    movePage({ nPage, nAfter }) { const [p] = this.pages.splice(nPage, 1); this.pages.splice(nAfter + 1 - (nAfter >= nPage ? 1 : 0), 0, p); }
    addWatermarkFromFile(o) { this.pages[o.nStart].marks.push({ src: files[o.cDIPath][o.nSourcePage].id, x: o.nHorizValue, y: o.nVertValue, s: o.nScale }); }
    addWatermarkFromText(o) { this.pages[o.nStart].marks.push({ text: o.cText, ha: o.nHorizAlign, x: o.nHorizValue, y: o.nVertValue }); }
    addAnnot(o) { this.pages[o.page].annots++; }
    flattenPages() {}
    saveAs({ cPath }) { this.path = cPath; this.dirty = false; files[cPath] = this.pages.map(clone); }
  }
  const menu = [];
  const app = {
    constants: { align: { left: 0, center: 1, right: 2, top: 3, bottom: 4 } },
    trustedFunction: (f) => f, beginPriv() {}, endPriv() {},
    newDoc: ({ nWidth, nHeight }) => new Doc([mkPage(nWidth, nHeight)]),
    getPath: () => '/tmp',
    alerts: [], alert(o) { this.alerts.push(o.cMsg); return 4; },
    addSubMenu: (o) => menu.push(o.cName), addMenuItem: (o) => menu.push(o.cName),
    openDoc: ({ cPath }) => ({ numPages: files[cPath].length, closeDoc() {} }),
    answers: {}, // field key -> value typed into the dialog
    execDialog(d) {
      let data;
      d.initialize({ load: (x) => { data = x; } });
      d.commit({ store: () => data });
      return 'ok';
    },
    response: () => 'My sequence', browseForDoc: () => ({ cPath: '/other.pdf' }),
  };
  const ctx = vm.createContext({ app, color: { black: ['G', 0] }, font: { Helv: 'Helvetica' }, global: { setPersistent() {} }, util: { printd: () => '1.1.2026' }, JSON });
  vm.runInContext(code, ctx);
  const Imposer = vm.runInContext('Imposer', ctx);
  /** A saved source document with n pages; each page carries its number as id. */
  const source = (n, w = 148 * MM, h = 210 * MM, path = '/src.pdf') => {
    const d = new Doc(Array.from({ length: n }, (_, i) => ({ ...mkPage(w, h), id: i + 1 })));
    d.saveAs({ cPath: path });
    return d;
  };
  const go = (cmd, doc, opts = {}) => {
    const out = Imposer.exec(cmd, doc, { ...Imposer.defaults(cmd), ...opts });
    if (!out) throw new Error(app.alerts.at(-1));
    return out;
  };
  return { app, Imposer, source, go, menu, files, ids: (d) => d.pages.map((p) => p.id ?? 0), placed: (d) => d.pages.map((p) => p.marks.map((m) => m.src)) };
}

test('the plug-in is plain ES5 (what Acrobat runs)', () => { acorn.parse(code, { ecmaVersion: 5 }); });

test('installs its menu', () => {
  const { menu } = acrobat();
  assert.ok(menu.includes('Imposer') && menu.includes('Imposer:booklet') && menu.includes('Imposer:seqRun'));
});

test('booklet order, sheet size, spine position', () => {
  const a = acrobat(), out = a.go('booklet', a.source(8));
  assert.deepEqual(a.placed(out), [[8, 1], [2, 7], [6, 3], [4, 5]]);
  near(out.pages[0].box[2], 296 * MM);
  near(out.pages[0].marks[1].x, 148 * MM); // right-hand page starts at the spine
  assert.deepEqual(a.placed(a.go('booklet', a.source(5))), [[1], [2], [3], [4, 5]]); // blanks where pages run out
  assert.deepEqual(a.placed(a.go('booklet', a.source(8), { binding: 'Right' }))[0], [1, 8]); // same pages, swapped sides…
  near(a.go('booklet', a.source(8), { binding: 'Right' }).pages[0].marks.find((m) => m.src === 1).x, 0); // …page 1 now on the left
  assert.deepEqual(a.placed(a.go('booklet', a.source(16), { sheetsPerSig: 2 })).slice(0, 5), [[8, 1], [2, 7], [6, 3], [4, 5], [16, 9]]);
});

test('n-up fills sheets in order and scales to a fixed sheet', () => {
  const a = acrobat();
  const out = a.go('nup', a.source(6));
  assert.deepEqual(a.placed(out), [[1, 2, 3, 4], [5, 6]]);
  near(out.pages[0].box[1], 420 * MM);
  near(out.pages[0].marks[0].y, 210 * MM); // page 1 sits in the top row
  const fit = a.go('nup', a.source(2), { cols: 2, rows: 1, sheet: 'A4', landscape: true });
  near(fit.pages[0].marks[0].s, 148.5 / 148);
});

test('step & repeat turns the sheet when more fit', () => {
  const a = acrobat(), out = a.go('stepRepeat', a.source(2, 85 * MM, 55 * MM), { margin: 8, gap: 3 });
  assert.equal(out.numPages, 2);
  assert.equal(out.pages[0].marks.length, 9); // 3 x 3 on a landscape A4 beats 2 x 4 on portrait
  near(out.pages[0].box[2], 297 * MM);
  assert.ok(out.pages[1].marks.every((m) => m.src === 2));
  assert.throws(() => a.go('stepRepeat', a.source(1, 400 * MM, 400 * MM)), /does not fit/);
});

test('shuffle, tile, reverse, blanks, duplicate, interleave', () => {
  const a = acrobat();
  const sh = a.go('shuffle', a.source(6), { rule: '4* 1 2 3' });
  assert.deepEqual(a.ids(sh), [4, 1, 2, 3, 0, 5, 6, 0]);
  assert.equal(sh.pages[0].rot, 180);
  const t = a.go('tile', a.source(2, 297 * MM, 210 * MM));
  assert.deepEqual(a.ids(t), [1, 1, 2, 2]);
  near(t.pages[1].box[0], 148.5 * MM); near(t.pages[1].box[2], 297 * MM);
  assert.deepEqual(a.ids(a.go('reverse', a.source(5))), [5, 4, 3, 2, 1]);
  assert.deepEqual(a.ids(a.go('insertBlank', a.source(5))), [1, 2, 3, 4, 5, 0, 0, 0]);
  assert.deepEqual(a.ids(a.go('insertBlank', a.source(3), { mode: 'Fixed number', count: 2, where: 'At the start' })), [0, 0, 1, 2, 3]);
  assert.deepEqual(a.ids(a.go('insertBlank', a.source(3), { where: 'Before the last page' })), [1, 2, 0, 3]);
  assert.deepEqual(a.ids(a.go('duplicate', a.source(3), { range: '1-2', copies: 2 })), [1, 1, 2, 2, 3]);
  assert.deepEqual(a.ids(a.go('duplicate', a.source(3), { range: '1-2', copies: 3, collate: true })), [1, 2, 1, 2, 1, 2, 3]);
  const base = a.source(3);
  a.source(3, 100, 100, '/other.pdf').pages.forEach((p, i) => { a.files['/other.pdf'][i].id = 10 + i; });
  assert.deepEqual(a.ids(a.go('interleave', base, { file: '/other.pdf', reverseOther: true })), [1, 12, 2, 11, 3, 10]);
});

test('trim & shift and page sizes', () => {
  const a = acrobat();
  const t = a.go('trimShift', a.source(2), { left: 10, top: 5, mirror: true });
  near(t.pages[0].box[0], 10 * MM); near(t.pages[1].box[2], 138 * MM); near(t.pages[0].box[1], 205 * MM);
  const grown = a.go('trimShift', a.source(1), { left: -10 });
  near(grown.pages[0].media[0], -10 * MM);
  assert.throws(() => a.go('trimShift', a.source(1), { left: 500 }), /larger/);
  const fit = a.go('adjustSize', a.source(1), { sheet: 'A4' });
  near(fit.pages[0].box[2], 210 * MM); near(fit.pages[0].marks[0].s, 297 / 210);
  const b = a.go('bleed', a.source(1));
  near(b.pages[0].box[2], 154 * MM); assert.ok(b.pages[0].marks[0].y < 0);
});

test('text stamps, Bates numbers, tape, CSV data, sample', () => {
  const a = acrobat();
  const t = a.go('stickText', a.source(3), { text: '{n} {page}/{pages}', anchor: 'bottom-right', start: 7, digits: 4 });
  assert.equal(t.pages[2].marks[0].text, '0009 3/3');
  assert.equal(t.pages[0].marks[0].ha, 2); assert.ok(t.pages[0].marks[0].x < 0); // right aligned, pulled inwards
  assert.equal(a.go('tape', a.source(2), { range: '2' }).pages[1].annots, 1);
  const v = a.go('variableData', a.source(2), { csv: 'name;seat\nŽiga;1\nAna;2', text: '{name}/{seat}', range: '1' });
  assert.equal(v.numPages, 4);
  assert.equal(v.pages[2].marks[0].text, 'Ana/2'); assert.equal(v.pages[3].marks.length, 0);
  const s = a.go('sample', null, { pages: 3 });
  assert.equal(s.numPages, 3); assert.equal(s.pages[2].marks[0].text, '3');
});

test('unsaved documents are refused, results can be chained, sequences replay', () => {
  const a = acrobat();
  const dirty = a.source(4); dirty.dirty = true;
  assert.equal(a.Imposer.exec('booklet', dirty, a.Imposer.defaults('booklet')), null);
  assert.match(a.app.alerts.at(-1), /save this document first/);
  const src = a.source(8);
  a.Imposer.run('insertBlank', src); a.Imposer.run('reverse', src); // through the dialogs, default answers
  a.Imposer.saveSequence();
  const fresh = a.source(5);
  a.Imposer.runSequence(fresh);
  assert.deepEqual(a.ids(fresh), [0, 0, 0, 5, 4, 3, 2, 1]);
  // a command's output (never saved by the user) feeds the next command
  const chained = a.go('nup', a.go('booklet', a.source(8)), { cols: 1, rows: 2 });
  assert.equal(chained.numPages, 2);
});
