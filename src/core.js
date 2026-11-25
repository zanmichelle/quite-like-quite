// Imposition engine. Every command is: async (bytes, options, ctx) -> bytes.
// Lengths in options are millimetres; internally everything is PDF points.
import {
  PDFDocument, degrees, rgb, StandardFonts,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export const MM = 72 / 25.4;
const mm = (v) => (Number(v) || 0) * MM;

export const SIZES = {
  A6: [105, 148], A5: [148, 210], A4: [210, 297], A3: [297, 420], A2: [420, 594],
  SRA3: [320, 450], SRA4: [225, 320], Letter: [215.9, 279.4], Legal: [215.9, 355.6],
  Tabloid: [279.4, 431.8],
};
const SIZE_NAMES = Object.keys(SIZES);

// ---------- helpers ----------

/** "1-3,5,8-" | "all" | "even" | "odd" | "last" -> sorted unique 0-based indices */
export function parseRange(str, n) {
  const s = String(str ?? 'all').trim().toLowerCase();
  const all = [...Array(n).keys()];
  if (!s || s === 'all') return all;
  if (s === 'even') return all.filter((i) => i % 2 === 1);
  if (s === 'odd') return all.filter((i) => i % 2 === 0);
  const set = new Set();
  for (const part of s.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const num = (t, dflt) => (t === '' ? dflt : t === 'last' ? n : parseInt(t, 10));
    const m = p.match(/^(\d*|last)\s*-\s*(\d*|last)$/);
    const [a, b] = m ? [num(m[1], 1), num(m[2], n)] : [num(p), num(p)];
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Can't read page range "${p}"`);
    for (let i = Math.max(1, a); i <= Math.min(n, b); i++) set.add(i - 1);
  }
  return [...set].sort((x, y) => x - y);
}

/** Sheet size in points from options {sheet, sheetW, sheetH, landscape}. null = automatic. */
function sheetSize(o) {
  if (o.sheet === 'Auto') return null;
  let [w, h] = o.sheet === 'Custom' ? [o.sheetW, o.sheetH] : SIZES[o.sheet];
  if (!(w > 0 && h > 0)) throw new Error('Sheet size must be larger than zero');
  if (o.landscape) [w, h] = [Math.max(w, h), Math.min(w, h)];
  return [mm(w), mm(h)];
}

const load = (bytes) => PDFDocument.load(bytes, { ignoreEncryption: true });
const save = (doc) => doc.save();

/** Visible box + rotation of a page, as the reader sees it. */
function visual(page) {
  const b = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const [w, h] = rot % 180 ? [b.height, b.width] : [b.width, b.height];
  return { box: b, rot, w, h };
}

/** Embed every page of src into out. Blank pages (no content) get emb = null. */
async function embedAll(out, src) {
  const pages = src.getPages();
  const info = pages.map(visual);
  const has = pages.map((p) => p.node.Contents() !== undefined);
  const idx = pages.map((_, i) => i).filter((i) => has[i]);
  const embs = await out.embedPages(
    idx.map((i) => pages[i]),
    idx.map((i) => {
      const b = info[i].box;
      return { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height };
    }),
  );
  idx.forEach((i, k) => { info[i].emb = embs[k]; });
  return info;
}

/** Draw item so it visually fills box x,y,w,h. extra = extra clockwise rotation (0/90/180/270). */
function draw(page, item, x, y, w, h, extra = 0) {
  if (!item || !item.emb) return;
  const r = (item.rot + extra) % 360;
  if (r === 0) page.drawPage(item.emb, { x, y, width: w, height: h });
  else if (r === 90) page.drawPage(item.emb, { x, y: y + h, width: h, height: w, rotate: degrees(-90) });
  else if (r === 180) page.drawPage(item.emb, { x: x + w, y: y + h, width: w, height: h, rotate: degrees(180) });
  else page.drawPage(item.emb, { x: x + w, y, width: h, height: w, rotate: degrees(90) });
}

/** Draw item inside a cell: scaled to fit (if fit) and centred. */
function drawInCell(page, item, cx, cy, cw, ch, fit, extra = 0) {
  if (!item) return;
  const [iw, ih] = extra % 180 ? [item.h, item.w] : [item.w, item.h];
  const s = fit ? Math.min(cw / iw, ch / ih) : 1;
  draw(page, item, cx + (cw - iw * s) / 2, cy + (ch - ih * s) / 2, iw * s, ih * s, extra);
}

/** Crop marks outside a grid: xs / ys are the cut positions, box is the grid bounds. */
function cropMarks(page, xs, ys, box) {
  const gap = mm(2), len = mm(5), opt = { thickness: 0.25, color: rgb(0, 0, 0) };
  for (const x of xs) {
    page.drawLine({ start: { x, y: box.top + gap }, end: { x, y: box.top + gap + len }, ...opt });
    page.drawLine({ start: { x, y: box.bottom - gap }, end: { x, y: box.bottom - gap - len }, ...opt });
  }
  for (const y of ys) {
    page.drawLine({ start: { x: box.left - gap, y }, end: { x: box.left - gap - len, y }, ...opt });
    page.drawLine({ start: { x: box.right + gap, y }, end: { x: box.right + gap + len, y }, ...opt });
  }
}

/** Build a new document from a list of entries: a 0-based page index, or {blank:[w,h]}, or {from:doc,i}. */
async function assemble(src, entries) {
  const out = await PDFDocument.create();
  const groups = new Map(); // doc -> indices
  for (const e of entries) {
    if (typeof e === 'number') (groups.get(src) ?? groups.set(src, []).get(src)).push(e);
    else if (e.from) (groups.get(e.from) ?? groups.set(e.from, []).get(e.from)).push(e.i);
  }
  const copied = new Map();
  for (const [doc, idx] of groups) {
    const uniq = [...new Set(idx)];
    const pages = await out.copyPages(doc, uniq);
    copied.set(doc, new Map(uniq.map((i, k) => [i, pages[k]])));
  }
  const used = new Set();
  for (const e of entries) {
    if (typeof e !== 'number' && e.blank) { out.addPage(e.blank); continue; }
    const [doc, i] = typeof e === 'number' ? [src, e] : [e.from, e.i];
    let p = copied.get(doc).get(i);
    if (used.has(p)) [p] = await out.copyPages(doc, [i]); // same page twice needs a fresh copy
    used.add(p);
    out.addPage(p);
    if (e.rotate) p.setRotation(degrees((p.getRotation().angle + e.rotate) % 360));
  }
  return out;
}

const pageSizeOf = (doc, i) => {
  const n = doc.getPageCount();
  if (!n) return [mm(210), mm(297)];
  const v = visual(doc.getPage(Math.min(Math.max(i, 0), n - 1)));
  return [v.w, v.h];
};

async function getFont(doc, ctx) {
  if (ctx && ctx.loadFont) {
    doc.registerFontkit(fontkit);
    return doc.embedFont(await ctx.loadFont(), { subset: true });
  }
  return doc.embedFont(StandardFonts.Helvetica);
}

function hexColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const v = m ? parseInt(m[1], 16) : 0;
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

/** Position of a w x h thing on a W x H page. anchor like "top-left", "center", "bottom-right". */
function anchorPos(anchor, W, H, w, h, dx, dy) {
  const a = anchor || 'bottom-center';
  const x = a.includes('left') ? dx : a.includes('right') ? W - w - dx : (W - w) / 2 + dx;
  const y = a.startsWith('top') ? H - h - dy : a.startsWith('bottom') ? dy : (H - h) / 2 + dy;
  return [x, y];
}

/** Rebuild chosen pages by drawing them onto new pages; others are copied untouched. */
async function redraw(bytes, range, fn) {
  const src = await load(bytes);
  const n = src.getPageCount();
  const chosen = new Set(parseRange(range, n));
  const out = await PDFDocument.create();
  const items = await embedAll(out, src);
  const keep = [...Array(n).keys()].filter((i) => !chosen.has(i));
  const kept = new Map((await out.copyPages(src, keep)).map((p, k) => [keep[k], p]));
  for (let i = 0; i < n; i++) {
    if (chosen.has(i)) await fn(out, items[i], i, n);
    else out.addPage(kept.get(i));
  }
  return save(out);
}

// ---------- field presets ----------

const SHEET = [
  { key: 'sheet', label: 'Sheet size', type: 'select', options: ['Auto', ...SIZE_NAMES, 'Custom'], default: 'Auto' },
  { key: 'sheetW', label: 'Custom width', type: 'number', unit: 'mm', default: 320, showIf: (o) => o.sheet === 'Custom' },
  { key: 'sheetH', label: 'Custom height', type: 'number', unit: 'mm', default: 450, showIf: (o) => o.sheet === 'Custom' },
  { key: 'landscape', label: 'Landscape sheet', type: 'checkbox', default: false, showIf: (o) => o.sheet !== 'Auto' },
];
const RANGE = { key: 'range', label: 'Pages', type: 'text', default: 'all', hint: 'all, odd, even, or e.g. 1-4,7,9-' };
const ANCHORS = ['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'];

// ---------- commands ----------

export const COMMANDS = {
  booklet: {
    title: 'Booklet', group: 'Impose',
    help: 'Fold-in-half booklet: two pages per side, ordered so the sheets nest. Print double-sided, flip on the short edge.',
    fields: [
      ...SHEET,
      { key: 'binding', label: 'Binding', type: 'select', options: ['Left', 'Right'], default: 'Left' },
      { key: 'sheetsPerSig', label: 'Sheets per signature', type: 'number', default: 0, hint: '0 = one signature (saddle stitch)' },
      { key: 'creep', label: 'Creep (total)', type: 'number', unit: 'mm', default: 0, hint: 'Moves inner pages toward the spine' },
      { key: 'marks', label: 'Crop marks', type: 'checkbox', default: false },
    ],
    async run(bytes, o) {
      const src = await load(bytes);
      const out = await PDFDocument.create();
      const items = await embedAll(out, src);
      if (!items.length) throw new Error('The document has no pages');
      const [pw, ph] = [items[0].w, items[0].h];
      const [W, H] = sheetSize(o) ?? [pw * 2, ph];
      const per = o.sheetsPerSig > 0 ? o.sheetsPerSig * 4 : Math.ceil(items.length / 4) * 4;
      const right = o.binding === 'Right';
      for (let start = 0; start < items.length; start += per) {
        const P = Math.min(per, Math.ceil((items.length - start) / 4) * 4);
        const sheets = P / 4;
        for (let s = 0; s < sheets; s++) {
          const shift = sheets > 1 ? (mm(o.creep) * s) / (sheets - 1) / 2 : 0;
          const sides = [[P - 1 - 2 * s, 2 * s], [2 * s + 1, P - 2 - 2 * s]];
          for (const pair of sides) {
            const [l, r] = right ? [pair[1], pair[0]] : pair;
            const page = out.addPage([W, H]);
            const cw = W / 2;
            const s2 = Math.min(cw / pw, H / ph, 1);
            const [w, h] = [pw * s2, ph * s2];
            const y = (H - h) / 2;
            // pages butt against the spine; creep pushes them further in
            draw(page, items[start + l], cw - w + shift, y, w, h);
            draw(page, items[start + r], cw - shift, y, w, h);
            if (o.marks) cropMarks(page, [cw - w, cw, cw + w], [y, y + h], { left: cw - w, right: cw + w, bottom: y, top: y + h });
          }
        }
      }
      return save(out);
    },
  },

  nup: {
    title: 'N-up', group: 'Impose',
    help: 'Put several consecutive pages on each sheet, e.g. 2 × 2.',
    fields: [
      { key: 'cols', label: 'Columns', type: 'number', default: 2 },
      { key: 'rows', label: 'Rows', type: 'number', default: 2 },
      ...SHEET,
      { key: 'margin', label: 'Sheet margin', type: 'number', unit: 'mm', default: 0 },
      { key: 'gap', label: 'Gap between pages', type: 'number', unit: 'mm', default: 0 },
      { key: 'fit', label: 'Scale pages to fit', type: 'checkbox', default: true },
      { key: 'order', label: 'Order', type: 'select', options: ['Across then down', 'Down then across'], default: 'Across then down' },
      { key: 'marks', label: 'Crop marks', type: 'checkbox', default: false },
    ],
    async run(bytes, o) {
      const src = await load(bytes);
      const out = await PDFDocument.create();
      const items = await embedAll(out, src);
      const cols = Math.max(1, Math.round(o.cols)), rows = Math.max(1, Math.round(o.rows));
      const per = cols * rows;
      layoutGrid(out, o, cols, rows, Math.ceil(items.length / per), (sheet, k) => items[sheet * per + k],
        Math.max(...items.map((i) => i.w)), Math.max(...items.map((i) => i.h)));
      return save(out);
    },
  },

  stepRepeat: {
    title: 'Step & repeat', group: 'Impose',
    help: 'Fill each sheet with copies of the same page — business cards, labels, tickets.',
    fields: [
      { ...SHEET[0], options: [...SIZE_NAMES, 'Custom'], default: 'A4' }, ...SHEET.slice(1),
      { key: 'margin', label: 'Sheet margin', type: 'number', unit: 'mm', default: 5 },
      { key: 'gap', label: 'Gap between copies', type: 'number', unit: 'mm', default: 0 },
      { key: 'autoRotate', label: 'Rotate if more fit', type: 'checkbox', default: true },
      { key: 'marks', label: 'Crop marks', type: 'checkbox', default: true },
    ],
    async run(bytes, o) {
      const src = await load(bytes);
      const out = await PDFDocument.create();
      const items = await embedAll(out, src);
      const [W, H] = sheetSize(o);
      const m = mm(o.margin), g = mm(o.gap);
      const count = (w, h) => [Math.floor((W - 2 * m + g) / (w + g)), Math.floor((H - 2 * m + g) / (h + g))];
      for (const it of items) {
        let [c, r] = count(it.w, it.h), turn = 0;
        const [c2, r2] = count(it.h, it.w);
        if (o.autoRotate && c2 * r2 > c * r) { [c, r, turn] = [c2, r2, 90]; }
        if (c * r < 1) throw new Error('The page does not fit on the sheet even once. Pick a larger sheet or smaller margin.');
        const [w, h] = turn ? [it.h, it.w] : [it.w, it.h];
        layoutGrid(out, { ...o, sheet: 'Custom', sheetW: W / MM, sheetH: H / MM, landscape: false, fit: false }, c, r, 1, () => it, w, h, turn);
      }
      return save(out);
    },
  },

  shuffle: {
    title: 'Shuffle pages', group: 'Impose',
    help: 'Reorder pages in repeating groups using a rule. "4 1 2 3" takes pages four at a time and outputs the 4th, 1st, 2nd, 3rd. Add * to turn a page upside down, > or < to turn it right or left, 0 for a blank.',
    fields: [
      { key: 'rule', label: 'Rule', type: 'text', default: '4 1 2 3' },
      { key: 'group', label: 'Pages per group', type: 'number', default: 0, hint: '0 = largest number in the rule' },
    ],
    async run(bytes, o) {
      const src = await load(bytes);
      const n = src.getPageCount();
      const toks = String(o.rule).trim().split(/[\s,]+/).filter(Boolean).map((t) => {
        const m = /^(\d+)([*<>]?)$/.exec(t);
        if (!m) throw new Error(`Can't read "${t}" in the rule`);
        return { k: +m[1], rotate: { '*': 180, '>': 90, '<': 270, '': 0 }[m[2]] };
      });
      const size = o.group > 0 ? Math.round(o.group) : Math.max(...toks.map((t) => t.k));
      if (!toks.length || !(size > 0)) throw new Error('The rule needs at least one page number');
      const entries = [];
      for (let g = 0; g < n; g += size) {
        for (const t of toks) {
          const i = g + t.k - 1;
          entries.push(t.k === 0 || t.k > size || i >= n ? { blank: pageSizeOf(src, g) } : { from: src, i, rotate: t.rotate });
        }
      }
      return save(await assemble(src, entries));
    },
  },

  tile: {
    title: 'Tile pages', group: 'Impose',
    help: 'Cut each page into a grid of smaller pages — split spreads, or print a poster on small sheets.',
    fields: [
      RANGE,
      { key: 'cols', label: 'Columns', type: 'number', default: 2 },
      { key: 'rows', label: 'Rows', type: 'number', default: 1 },
      { key: 'overlap', label: 'Overlap / bleed', type: 'number', unit: 'mm', default: 0 },
    ],
    run: (bytes, o) => redraw(bytes, o.range, (out, it) => {
      const cols = Math.max(1, Math.round(o.cols)), rows = Math.max(1, Math.round(o.rows));
      const ov = mm(o.overlap);
      const tw = Math.min(it.w, it.w / cols + ov), th = Math.min(it.h, it.h / rows + ov);
      const clamp = (v, max) => Math.min(Math.max(v, 0), max);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x0 = clamp(c * (it.w / cols) - ov / 2, it.w - tw);
        const y0 = clamp((rows - 1 - r) * (it.h / rows) - ov / 2, it.h - th);
        draw(out.addPage([tw, th]), it, -x0, -y0, it.w, it.h);
      }
    }),
  },

  trimShift: {
    title: 'Trim & shift', group: 'Pages',
    help: 'Cut strips off the page edges and/or move the content. Negative trim adds space.',
    fields: [
      RANGE,
      { key: 'left', label: 'Trim left', type: 'number', unit: 'mm', default: 0 },
      { key: 'right', label: 'Trim right', type: 'number', unit: 'mm', default: 0 },
      { key: 'top', label: 'Trim top', type: 'number', unit: 'mm', default: 0 },
      { key: 'bottom', label: 'Trim bottom', type: 'number', unit: 'mm', default: 0 },
      { key: 'dx', label: 'Shift right', type: 'number', unit: 'mm', default: 0 },
      { key: 'dy', label: 'Shift up', type: 'number', unit: 'mm', default: 0 },
      { key: 'mirror', label: 'Mirror left/right on even pages', type: 'checkbox', default: false },
    ],
    run: (bytes, o) => redraw(bytes, o.range, (out, it, i) => {
      const flip = o.mirror && i % 2 === 1;
      const [l, r] = flip ? [mm(o.right), mm(o.left)] : [mm(o.left), mm(o.right)];
      const W = it.w - l - r, H = it.h - mm(o.top) - mm(o.bottom);
      if (W <= 0 || H <= 0) throw new Error('Trim is larger than the page');
      draw(out.addPage([W, H]), it, (flip ? -1 : 1) * mm(o.dx) - l, mm(o.dy) - mm(o.bottom), it.w, it.h);
    }),
  },

  adjustSize: {
    title: 'Adjust page size', group: 'Pages',
    help: 'Scale pages, fit them to a paper size, or change the paper size around the content (crops or adds space).',
    fields: [
      RANGE,
      { key: 'mode', label: 'What to do', type: 'select', options: ['Scale by percent', 'Scale to fit size', 'Change size, keep content'], default: 'Scale to fit size' },
      { key: 'percent', label: 'Percent', type: 'number', unit: '%', default: 100, showIf: (o) => o.mode === 'Scale by percent' },
      { ...SHEET[0], label: 'New size', options: [...SIZE_NAMES, 'Custom'], default: 'A4', showIf: (o) => o.mode !== 'Scale by percent' },
      { ...SHEET[1], showIf: (o) => o.mode !== 'Scale by percent' && o.sheet === 'Custom' },
      { ...SHEET[2], showIf: (o) => o.mode !== 'Scale by percent' && o.sheet === 'Custom' },
      { key: 'matchOrient', label: 'Match each page’s orientation', type: 'checkbox', default: true, showIf: (o) => o.mode !== 'Scale by percent' },
    ],
    run: (bytes, o) => redraw(bytes, o.range, (out, it) => {
      if (o.mode === 'Scale by percent') {
        const s = o.percent / 100;
        if (!(s > 0)) throw new Error('Percent must be above zero');
        return draw(out.addPage([it.w * s, it.h * s]), it, 0, 0, it.w * s, it.h * s);
      }
      let [W, H] = sheetSize({ ...o, landscape: false });
      if (o.matchOrient && (W > H) !== (it.w > it.h)) [W, H] = [H, W];
      drawInCell(out.addPage([W, H]), it, 0, 0, W, H, o.mode === 'Scale to fit size');
    }),
  },

  bleed: {
    title: 'Generate bleed', group: 'Pages',
    help: 'Grow each page on all sides and fill the new border by mirroring (or stretching) the artwork.',
    fields: [
      RANGE,
      { key: 'amount', label: 'Bleed', type: 'number', unit: 'mm', default: 3 },
      { key: 'method', label: 'Method', type: 'select', options: ['Mirror edges', 'Scale up'], default: 'Mirror edges' },
    ],
    run: (bytes, o) => redraw(bytes, o.range, (out, it) => {
      const b = mm(o.amount), W = it.w + 2 * b, H = it.h + 2 * b;
      const page = out.addPage([W, H]);
      if (o.method === 'Scale up') draw(page, it, 0, 0, W, H);
      else {
        // 8 mirrored neighbours; the page edge clips them to the bleed strip
        const fx = [[-1, 2 * b], [1, 0], [-1, 2 * (b + it.w)]], fy = [[-1, 2 * b], [1, 0], [-1, 2 * (b + it.h)]];
        for (const [sx, tx] of fx) for (const [sy, ty] of fy) {
          if (sx === 1 && sy === 1) continue;
          page.pushOperators(pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, tx, ty));
          draw(page, it, b, b, it.w, it.h);
          page.pushOperators(popGraphicsState());
        }
      }
      draw(page, it, b, b, it.w, it.h);
    }),
  },

  pageTools: {
    title: 'Delete / duplicate / rotate / move', group: 'Pages',
    help: 'Quick page edits on a range of pages.',
    fields: [
      { key: 'action', label: 'Action', type: 'select', options: ['Delete', 'Keep only these', 'Duplicate', 'Rotate', 'Move'], default: 'Rotate' },
      RANGE,
      { key: 'copies', label: 'Copies of each', type: 'number', default: 2, showIf: (o) => o.action === 'Duplicate' },
      { key: 'collate', label: 'Collate (1 2 3, 1 2 3)', type: 'checkbox', default: false, showIf: (o) => o.action === 'Duplicate' },
      { key: 'angle', label: 'Turn', type: 'select', options: ['90° right', '180°', '90° left'], default: '90° right', showIf: (o) => o.action === 'Rotate' },
      { key: 'after', label: 'Move to after page', type: 'number', default: 0, hint: '0 = the very start', showIf: (o) => o.action === 'Move' },
    ],
    async run(bytes, o) {
      const src = await load(bytes);
      const n = src.getPageCount();
      const sel = parseRange(o.range, n), S = new Set(sel);
      const all = [...Array(n).keys()];
      let entries;
      if (o.action === 'Delete') entries = all.filter((i) => !S.has(i));
      else if (o.action === 'Keep only these') entries = sel;
      else if (o.action === 'Rotate') {
        const rotate = { '90° right': 90, '180°': 180, '90° left': 270 }[o.angle];
        entries = all.map((i) => (S.has(i) ? { from: src, i, rotate } : i));
      } else if (o.action === 'Duplicate') {
        const c = Math.max(1, Math.round(o.copies));
        if (o.collate) {
          // the selected run repeated as a block, placed where its first page was
          entries = [];
          for (const i of all) {
            if (!S.has(i)) entries.push(i);
            else if (i === sel[0]) for (let k = 0; k < c; k++) entries.push(...sel);
          }
        } else entries = all.flatMap((i) => (S.has(i) ? Array(c).fill(i) : [i]));
      } else {
        const rest = all.filter((i) => !S.has(i));
        const at = rest.filter((i) => i < o.after).length;
        entries = [...rest.slice(0, at), ...sel, ...rest.slice(at)];
      }
      if (!entries.length) throw new Error('That would leave no pages');
      return save(await assemble(src, entries));
    },
  },

  reverse: {
    title: 'Reverse pages', group: 'Pages',
    help: 'Put the pages in the opposite order.',
    fields: [],
    async run(bytes) {
      const src = await load(bytes);
      return save(await assemble(src, [...Array(src.getPageCount()).keys()].reverse()));
    },
  },

  insertBlank: {
    title: 'Insert blank pages', group: 'Pages',
    help: 'Add empty pages — a fixed number, or just enough to reach a multiple (e.g. 4 for a booklet).',
    fields: [
      { key: 'mode', label: 'How many', type: 'select', options: ['Fixed number', 'Until page count is a multiple of'], default: 'Until page count is a multiple of' },
      { key: 'count', label: 'Number', type: 'number', default: 4, hint: 'Count, or the multiple to reach' },
      { key: 'where', label: 'Where', type: 'select', options: ['At the end', 'At the start', 'After page…', 'Before the last page'], default: 'At the end' },
      { key: 'after', label: 'After page', type: 'number', default: 1, showIf: (o) => o.where === 'After page…' },
    ],
    async run(bytes, o) {
      const src = await load(bytes);
      const n = src.getPageCount(), c = Math.max(1, Math.round(o.count));
      const add = o.mode === 'Fixed number' ? c : (c - (n % c)) % c;
      const at = { 'At the end': n, 'At the start': 0, 'Before the last page': Math.max(0, n - 1) }[o.where] ?? Math.min(n, Math.max(0, Math.round(o.after)));
      const all = [...Array(n).keys()];
      const blanks = Array.from({ length: add }, () => ({ blank: pageSizeOf(src, at - 1) }));
      return save(await assemble(src, [...all.slice(0, at), ...blanks, ...all.slice(at)]));
    },
  },

  insertFile: {
    title: 'Insert / merge another PDF', group: 'Pages',
    help: 'Add pages from another PDF: at a position, or interleaved with this one (e.g. merge separately scanned odd and even pages).',
    fields: [
      { key: 'file', label: 'PDF to insert', type: 'file' },
      { key: 'range', label: 'Pages from that PDF', type: 'text', default: 'all' },
      { key: 'where', label: 'Where', type: 'select', options: ['At the end', 'At the start', 'After page…', 'Interleave (this, other, this, other…)'], default: 'At the end' },
      { key: 'after', label: 'After page', type: 'number', default: 1, showIf: (o) => o.where === 'After page…' },
      { key: 'copies', label: 'Copies', type: 'number', default: 1, showIf: (o) => !o.where.startsWith('Interleave') },
      { key: 'reverseOther', label: 'Other PDF is in reverse order', type: 'checkbox', default: false, showIf: (o) => o.where.startsWith('Interleave') },
    ],
    async run(bytes, o) {
      if (!o.file) throw new Error('Choose the PDF to insert first');
      const src = await load(bytes), other = await load(o.file);
      const n = src.getPageCount();
      let ins = parseRange(o.range, other.getPageCount()).map((i) => ({ from: other, i }));
      const all = [...Array(n).keys()];
      let entries;
      if (o.where.startsWith('Interleave')) {
        if (o.reverseOther) ins.reverse();
        entries = [];
        for (let k = 0; k < Math.max(n, ins.length); k++) {
          if (k < n) entries.push(k);
          if (k < ins.length) entries.push(ins[k]);
        }
      } else {
        const block = Array.from({ length: Math.max(1, Math.round(o.copies)) }, () => ins).flat();
        const at = { 'At the end': n, 'At the start': 0 }[o.where] ?? Math.min(n, Math.max(0, Math.round(o.after)));
        entries = [...all.slice(0, at), ...block, ...all.slice(at)];
      }
      return save(await assemble(src, entries));
    },
  },

  stickText: {
    title: 'Text & page numbers', group: 'Stick on',
    help: 'Stamp text on pages. Fields: {page} {pages} {file} {date} and {n} for a running number with leading zeros (Bates stamping).',
    fields: [
      { key: 'text', label: 'Text', type: 'text', default: '{page} / {pages}' },
      RANGE,
      { key: 'anchor', label: 'Position', type: 'select', options: ANCHORS, default: 'bottom-center' },
      { key: 'dx', label: 'Distance from side', type: 'number', unit: 'mm', default: 10 },
      { key: 'dy', label: 'Distance from top/bottom', type: 'number', unit: 'mm', default: 8 },
      { key: 'size', label: 'Font size', type: 'number', unit: 'pt', default: 10 },
      { key: 'color', label: 'Colour', type: 'color', default: '#000000' },
      { key: 'start', label: '{n} starts at', type: 'number', default: 1, showIf: (o) => /\{n\}/.test(o.text) },
      { key: 'digits', label: '{n} digits', type: 'number', default: 6, showIf: (o) => /\{n\}/.test(o.text) },
      { key: 'firstPageNo', label: '{page} starts at', type: 'number', default: 1, showIf: (o) => /\{page\}/.test(o.text) },
    ],
    async run(bytes, o, ctx = {}) {
      const doc = await load(bytes);
      const font = await getFont(doc, ctx);
      const n = doc.getPageCount();
      const sel = parseRange(o.range, n);
      sel.forEach((i, k) => {
        const text = fill(o.text, {
          page: i + Math.round(o.firstPageNo ?? 1), pages: n, file: ctx.fileName ?? '', date: ctx.date ?? new Date().toLocaleDateString(),
          n: String(Math.round(o.start ?? 1) + k).padStart(Math.round(o.digits ?? 6), '0'),
        });
        stamp(doc.getPage(i), text, font, o);
      });
      return save(doc);
    },
  },

  stickPage: {
    title: 'Place a PDF page', group: 'Stick on',
    help: 'Put a page — from another PDF or from this one — on top of (or behind) other pages at any position and scale. Use for logos, letterheads, watermarks and manual imposition.',
    fields: [
      { key: 'file', label: 'Take page from', type: 'file', hint: 'Leave empty to use a page of this document' },
      { key: 'sourcePage', label: 'Page number to place', type: 'number', default: 1 },
      RANGE,
      { key: 'anchor', label: 'Position', type: 'select', options: ANCHORS, default: 'center' },
      { key: 'dx', label: 'Offset sideways', type: 'number', unit: 'mm', default: 0 },
      { key: 'dy', label: 'Offset up/down', type: 'number', unit: 'mm', default: 0 },
      { key: 'scale', label: 'Scale', type: 'number', unit: '%', default: 100 },
      { key: 'fitPage', label: 'Scale to fill the whole page instead', type: 'checkbox', default: false },
      { key: 'behind', label: 'Place behind the page content', type: 'checkbox', default: false },
    ],
    async run(bytes, o) {
      const src = await load(bytes);
      const from = o.file ? await load(o.file) : src;
      const k = Math.round(o.sourcePage) - 1;
      if (!(k >= 0 && k < from.getPageCount())) throw new Error(`There is no page ${o.sourcePage} to place`);
      return redraw(bytes, o.range, async (out, it) => {
        out._stick ??= (await embedAll(out, await subset(from, k)))[0];
        const st = out._stick;
        const page = out.addPage([it.w, it.h]);
        const s = o.fitPage ? Math.min(it.w / st.w, it.h / st.h) : o.scale / 100;
        const [w, h] = [st.w * s, st.h * s];
        const [x, y] = o.fitPage ? [(it.w - w) / 2, (it.h - h) / 2] : anchorPos(o.anchor, it.w, it.h, w, h, mm(o.dx), mm(o.dy));
        if (!o.behind) draw(page, it, 0, 0, it.w, it.h);
        draw(page, st, x, y, w, h);
        if (o.behind) draw(page, it, 0, 0, it.w, it.h);
      });
    },
  },

  tape: {
    title: 'Masking tape', group: 'Stick on',
    help: 'Cover part of the page with a solid rectangle — hide old page numbers, marks or mistakes.',
    fields: [
      RANGE,
      { key: 'anchor', label: 'Position', type: 'select', options: ANCHORS, default: 'bottom-center' },
      { key: 'dx', label: 'Distance from side', type: 'number', unit: 'mm', default: 0 },
      { key: 'dy', label: 'Distance from top/bottom', type: 'number', unit: 'mm', default: 0 },
      { key: 'w', label: 'Width', type: 'number', unit: 'mm', default: 60 },
      { key: 'h', label: 'Height', type: 'number', unit: 'mm', default: 15 },
      { key: 'color', label: 'Colour', type: 'color', default: '#ffffff' },
    ],
    async run(bytes, o) {
      const doc = await load(bytes);
      for (const i of parseRange(o.range, doc.getPageCount())) {
        const page = doc.getPage(i);
        onVisual(page, (W, H) => {
          const [x, y] = anchorPos(o.anchor, W, H, mm(o.w), mm(o.h), mm(o.dx), mm(o.dy));
          page.drawRectangle({ x, y, width: mm(o.w), height: mm(o.h), color: hexColor(o.color) });
        });
      }
      return save(doc);
    },
  },

  variableData: {
    title: 'Variable data (CSV)', group: 'Stick on',
    help: 'Make one copy of the document per CSV row and stamp that row’s values on it. First CSV line = column names; write them in the text as {name}.',
    fields: [
      { key: 'csv', label: 'CSV data', type: 'textarea', default: 'name,seat\nAna,12\nBor,13' },
      { key: 'text', label: 'Text', type: 'text', default: '{name} — seat {seat}' },
      { ...RANGE, label: 'Stamp on pages (of each copy)' },
      { key: 'anchor', label: 'Position', type: 'select', options: ANCHORS, default: 'center' },
      { key: 'dx', label: 'Distance from side', type: 'number', unit: 'mm', default: 0 },
      { key: 'dy', label: 'Distance from top/bottom', type: 'number', unit: 'mm', default: 0 },
      { key: 'size', label: 'Font size', type: 'number', unit: 'pt', default: 14 },
      { key: 'color', label: 'Colour', type: 'color', default: '#000000' },
    ],
    async run(bytes, o, ctx = {}) {
      const rows = parseCsv(o.csv);
      if (rows.length < 2) throw new Error('The CSV needs a header line and at least one data row');
      const [head, ...data] = rows;
      const src = await load(bytes);
      const n = src.getPageCount();
      const out = await assemble(src, data.flatMap(() => [...Array(n).keys()]));
      const font = await getFont(out, ctx);
      const sel = parseRange(o.range, n);
      data.forEach((row, r) => {
        const vals = Object.fromEntries(head.map((h, c) => [h.trim(), row[c] ?? '']));
        for (const i of sel) stamp(out.getPage(r * n + i), fill(o.text, { ...vals, row: r + 1, page: i + 1, pages: n }), font, o);
      });
      return save(out);
    },
  },

  sample: {
    title: 'Create sample document', group: 'Tools',
    help: 'Make a numbered test document to try layouts on. Replaces the current document.',
    needsNoDoc: true,
    fields: [
      { key: 'pages', label: 'Pages', type: 'number', default: 8 },
      { ...SHEET[0], label: 'Page size', options: [...SIZE_NAMES, 'Custom'], default: 'A5' }, SHEET[1], SHEET[2],
      { key: 'landscape', label: 'Landscape', type: 'checkbox', default: false },
    ],
    async run(_bytes, o) {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      const [W, H] = sheetSize(o);
      const n = Math.min(2000, Math.max(1, Math.round(o.pages)));
      for (let i = 1; i <= n; i++) {
        const page = doc.addPage([W, H]);
        const hue = (i * 47) % 360, c = hsl(hue);
        page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: c });
        page.drawRectangle({ x: mm(5), y: mm(5), width: W - mm(10), height: H - mm(10), color: rgb(1, 1, 1) });
        const size = Math.min(W, H) * 0.45, t = String(i);
        page.drawText(t, { x: (W - font.widthOfTextAtSize(t, size)) / 2, y: (H - size * 0.7) / 2, size, font, color: c });
        page.drawText(`Page ${i} of ${n}  ·  TOP`, { x: mm(9), y: H - mm(13), size: 9, font, color: rgb(0.3, 0.3, 0.3) });
      }
      return save(doc);
    },
  },
};

// ---------- shared drawing used by several commands ----------

/** n-up style grid. get(sheet, k) returns the item for cell k on that sheet. */
function layoutGrid(out, o, cols, rows, sheets, get, cellW, cellH, extra = 0) {
  const m = mm(o.margin), g = mm(o.gap);
  let size = sheetSize(o), cw = cellW, ch = cellH;
  if (!size) size = [2 * m + cols * cw + (cols - 1) * g, 2 * m + rows * ch + (rows - 1) * g];
  else if (o.fit) { cw = (size[0] - 2 * m - (cols - 1) * g) / cols; ch = (size[1] - 2 * m - (rows - 1) * g) / rows; }
  if (cw <= 0 || ch <= 0) throw new Error('Margins and gaps leave no room for the pages');
  const [W, H] = size;
  const gw = cols * cw + (cols - 1) * g, gh = rows * ch + (rows - 1) * g;
  const x0 = (W - gw) / 2, y0 = (H - gh) / 2;
  const down = o.order === 'Down then across';
  for (let s = 0; s < sheets; s++) {
    const page = out.addPage([W, H]);
    for (let k = 0; k < cols * rows; k++) {
      const [c, r] = down ? [Math.floor(k / rows), k % rows] : [k % cols, Math.floor(k / cols)];
      drawInCell(page, get(s, k), x0 + c * (cw + g), y0 + (rows - 1 - r) * (ch + g), cw, ch, o.fit, extra);
    }
    if (o.marks) {
      const xs = [], ys = [];
      for (let c = 0; c < cols; c++) xs.push(x0 + c * (cw + g), x0 + c * (cw + g) + cw);
      for (let r = 0; r < rows; r++) ys.push(y0 + r * (ch + g), y0 + r * (ch + g) + ch);
      cropMarks(page, xs, ys, { left: x0, right: x0 + gw, bottom: y0, top: y0 + gh });
    }
  }
}

/** Run fn(W, H) with the page's coordinate system set up as the reader sees it (handles rotated pages / offset boxes). */
function onVisual(page, fn) {
  const { box, rot, w, h } = visual(page);
  const M = { 0: [1, 0, 0, 1, box.x, box.y], 90: [0, 1, -1, 0, box.x + box.width, box.y], 180: [-1, 0, 0, -1, box.x + box.width, box.y + box.height], 270: [0, -1, 1, 0, box.x, box.y + box.height] }[rot];
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...M));
  fn(w, h);
  page.pushOperators(popGraphicsState());
}

function stamp(page, text, font, o) {
  const size = Number(o.size) || 10;
  let t = text;
  try { font.encodeText(t); } catch { t = [...t].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join(''); }
  onVisual(page, (W, H) => {
    const tw = font.widthOfTextAtSize(t, size), th = size * 0.72;
    const [x, y] = anchorPos(o.anchor, W, H, tw, th, mm(o.dx), mm(o.dy));
    page.drawText(t, { x, y, size, font, color: hexColor(o.color) });
  });
}

const fill = (tpl, vals) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vals ? String(vals[k]) : m));

async function subset(doc, i) {
  const d = await PDFDocument.create();
  d.addPage((await d.copyPages(doc, [i]))[0]);
  return d;
}

export function parseCsv(text) {
  const src = String(text ?? '');
  const first = src.split('\n')[0];
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : first.includes('\t') && !first.includes(',') ? '\t' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function hsl(h) {
  const f = (n) => { const k = (n + h / 30) % 12; return 0.5 - 0.35 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return rgb(f(0), f(8), f(4));
}

// ---------- public API ----------

export function defaults(cmd) {
  return Object.fromEntries(COMMANDS[cmd].fields.filter((f) => f.type !== 'file').map((f) => [f.key, f.default]));
}

export async function run(cmd, bytes, opts = {}, ctx = {}) {
  const c = COMMANDS[cmd];
  if (!c) throw new Error(`Unknown command "${cmd}"`);
  return c.run(bytes, { ...defaults(cmd), ...opts }, ctx);
}

/** Page count and the size (mm) of each page, for the status bar. */
export async function describe(bytes) {
  const doc = await load(bytes);
  const sizes = doc.getPages().map((p) => { const v = visual(p); return [v.w / MM, v.h / MM]; });
  return { pages: sizes.length, sizes };
}
