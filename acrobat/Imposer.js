/*
 * Imposer — imposition plug-in for Adobe Acrobat (Pro / Standard).
 *
 * Install: copy this file into Acrobat's "JavaScripts" folder and restart Acrobat
 * (see INSTALL.md). It adds an "Imposer" submenu to the Edit menu.
 *
 * Folder-level script: written in plain ES5 because that is what Acrobat runs.
 * All lengths in dialogs are millimetres; internally everything is PDF points.
 */
var Imposer = (function () {
  var MM = 72 / 25.4;
  var SIZES = {
    A6: [105, 148], A5: [148, 210], A4: [210, 297], A3: [297, 420], A2: [420, 594],
    SRA3: [320, 450], SRA4: [225, 320], Letter: [215.9, 279.4], Legal: [215.9, 355.6], Tabloid: [279.4, 431.8]
  };
  var SIZE_NAMES = ['A6', 'A5', 'A4', 'A3', 'A2', 'SRA3', 'SRA4', 'Letter', 'Legal', 'Tabloid'];
  var ANCHORS = ['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'];
  var AL = app.constants.align;

  function mm(v) { return (Number(v) || 0) * MM; }

  // ---------- privileged helpers ----------
  // Acrobat only allows these calls directly inside a trusted function, so each gets its own.

  var pNewDoc = app.trustedFunction(function (w, h) {
    app.beginPriv(); var d = app.newDoc({ nWidth: w, nHeight: h }); app.endPriv(); return d;
  });
  var pNewPage = app.trustedFunction(function (doc, w, h) { // appends a blank page
    app.beginPriv(); doc.newPage({ nWidth: w, nHeight: h }); app.endPriv(); // no nPage = after the last page
  });
  var pInsert = app.trustedFunction(function (doc, after, path, start, end) {
    app.beginPriv(); doc.insertPages({ nPage: after, cPath: path, nStart: start, nEnd: end }); app.endPriv();
  });
  var pWmFile = app.trustedFunction(function (doc, o) {
    app.beginPriv(); doc.addWatermarkFromFile(o); app.endPriv();
  });
  var pWmText = app.trustedFunction(function (doc, o) {
    app.beginPriv(); doc.addWatermarkFromText(o); app.endPriv();
  });
  var pBrowse = app.trustedFunction(function () {
    app.beginPriv(); var r = app.browseForDoc(); app.endPriv(); return r ? r.cPath : null;
  });
  var pCountPages = app.trustedFunction(function (path) {
    app.beginPriv();
    var d = app.openDoc({ cPath: path, bHidden: true }), n = d.numPages;
    d.closeDoc(true);
    app.endPriv();
    return n;
  });
  // saved sequences live in Acrobat's persistent "global" object
  var pGlobalGet = app.trustedFunction(function () {
    app.beginPriv(); var v = global.imposerSequences; app.endPriv(); return v;
  });
  var pGlobalSet = app.trustedFunction(function (v) {
    app.beginPriv(); global.imposerSequences = v; global.setPersistent('imposerSequences', true); app.endPriv();
  });
  var pSaveTemp = app.trustedFunction(function (doc, name) {
    app.beginPriv();
    var dir = app.getPath({ cCategory: 'user', cFolder: 'temp' });
    doc.saveAs({ cPath: dir + '/' + name });
    app.endPriv();
  });

  // ---------- small helpers ----------

  var ours = [];      // documents this plug-in created (safe to auto-save to the temp folder)
  var tempCount = 0;

  function pageSize(doc, i) {
    var b = doc.getPageBox({ cBox: 'Crop', nPage: i }); // [left, top, right, bottom]
    return { w: b[2] - b[0], h: b[1] - b[3], box: b };
  }

  /** The file other commands read pages from. Returns a path, or null after telling the user what to do. */
  function savedPath(doc) {
    var mine = false, i;
    for (i = 0; i < ours.length; i++) if (ours[i] === doc) mine = true;
    if (doc.path && !doc.dirty) return doc.path;
    if (mine) {
      try {
        tempCount++;
        pSaveTemp(doc, 'imposer-' + (new Date()).getTime() + '-' + tempCount + '.pdf');
        return doc.path;
      } catch (e) { /* fall through to the message */ }
    }
    app.alert({ cMsg: 'Please save this document first (File > Save), then run the command again.\n\nImposer reads the pages from the saved file.', cTitle: 'Imposer', nIcon: 1 });
    return null;
  }

  function newDoc(w, h) { var d = pNewDoc(w, h); ours.push(d); return d; }

  /** "1-3,5,8-" | "all" | "even" | "odd" | "last" -> sorted 0-based indices */
  function parseRange(str, n) {
    var s = String(str == null ? 'all' : str).replace(/^\s+|\s+$/g, '').toLowerCase();
    var out = [], seen = {}, i, parts, p, m, a, b;
    if (!s || s === 'all') { for (i = 0; i < n; i++) out.push(i); return out; }
    if (s === 'even' || s === 'odd') { for (i = (s === 'even' ? 1 : 0); i < n; i += 2) out.push(i); return out; }
    function num(t, dflt) { return t === '' ? dflt : t === 'last' ? n : parseInt(t, 10); }
    parts = s.split(',');
    for (p = 0; p < parts.length; p++) {
      var part = parts[p].replace(/\s+/g, '');
      if (!part) continue;
      m = /^(\d*|last)-(\d*|last)$/.exec(part);
      if (m) { a = num(m[1], 1); b = num(m[2], n); } else { a = b = num(part); }
      if (isNaN(a) || isNaN(b)) throw new Error('Cannot read page range "' + parts[p] + '"');
      for (i = Math.max(1, a); i <= Math.min(n, b); i++) seen[i - 1] = true;
    }
    for (i = 0; i < n; i++) if (seen[i]) out.push(i);
    return out;
  }

  function inSet(list) { var s = {}, i; for (i = 0; i < list.length; i++) s[list[i]] = true; return s; }

  /** Sheet size in points from options; null = automatic. */
  function sheetSize(o) {
    if (o.sheet === 'Auto') return null;
    var w, h, t;
    if (o.sheet === 'Custom') { w = o.sheetW; h = o.sheetH; } else { w = SIZES[o.sheet][0]; h = SIZES[o.sheet][1]; }
    if (!(w > 0 && h > 0)) throw new Error('Sheet size must be larger than zero');
    if (o.landscape && h > w) { t = w; w = h; h = t; }
    return [mm(w), mm(h)];
  }

  /** Put page srcPage of the file at path onto page pg of doc; lower-left corner at x,y. */
  function place(doc, pg, path, srcPage, x, y, scale, onTop) {
    pWmFile(doc, {
      cDIPath: path, nSourcePage: srcPage, nStart: pg, nEnd: pg, bOnTop: onTop !== false,
      nHorizAlign: AL.left, nVertAlign: AL.bottom, nHorizValue: x, nVertValue: y,
      bPercentage: false, nScale: scale, nRotation: 0, nOpacity: 1
    });
  }

  /** Place into a cell, scaled to fit (if fit) and centred. it = {w,h} of the source page. */
  function placeInCell(doc, pg, path, srcPage, it, cx, cy, cw, ch, fit) {
    var s = fit ? Math.min(cw / it.w, ch / it.h) : 1;
    place(doc, pg, path, srcPage, cx + (cw - it.w * s) / 2, cy + (ch - it.h * s) / 2, s);
  }

  /** Crop marks outside a grid, drawn as line annotations (flattened by the caller). */
  function cropMarks(doc, pg, xs, ys, box) {
    var gap = mm(2), len = mm(5), i;
    function line(x1, y1, x2, y2) {
      doc.addAnnot({ type: 'Line', page: pg, points: [[x1, y1], [x2, y2]], strokeColor: color.black, width: 0.25 });
    }
    for (i = 0; i < xs.length; i++) {
      line(xs[i], box.top + gap, xs[i], box.top + gap + len);
      line(xs[i], box.bottom - gap, xs[i], box.bottom - gap - len);
    }
    for (i = 0; i < ys.length; i++) {
      line(box.left - gap, ys[i], box.left - gap - len, ys[i]);
      line(box.right + gap, ys[i], box.right + gap + len, ys[i]);
    }
  }

  function flatten(doc) { try { doc.flattenPages(); } catch (e) { /* annotations stay as annotations */ } }

  /** Sheets are created one at a time; newDoc already gives the first. */
  function Sheets(W, H) {
    this.doc = newDoc(W, H); this.W = W; this.H = H; this.count = 0;
  }
  Sheets.prototype.add = function () {
    if (this.count > 0) pNewPage(this.doc, this.W, this.H);
    return this.count++;
  };

  /** n-up style grid. get(sheet, k) -> source page index or -1 (empty cell). */
  function layoutGrid(path, o, cols, rows, sheets, get, sizeOf, cellW, cellH) {
    var m = mm(o.margin), g = mm(o.gap), size = sheetSize(o), cw = cellW, ch = cellH;
    if (!size) size = [2 * m + cols * cw + (cols - 1) * g, 2 * m + rows * ch + (rows - 1) * g];
    else if (o.fit) { cw = (size[0] - 2 * m - (cols - 1) * g) / cols; ch = (size[1] - 2 * m - (rows - 1) * g) / rows; }
    if (cw <= 0 || ch <= 0) throw new Error('Margins and gaps leave no room for the pages');
    var W = size[0], H = size[1];
    var gw = cols * cw + (cols - 1) * g, gh = rows * ch + (rows - 1) * g;
    var x0 = (W - gw) / 2, y0 = (H - gh) / 2;
    var down = o.order === 'Down then across';
    var out = o._sheets || new Sheets(W, H), s, k, c, r, pg, src, xs, ys;
    for (s = 0; s < sheets; s++) {
      pg = out.add();
      for (k = 0; k < cols * rows; k++) {
        if (down) { c = Math.floor(k / rows); r = k % rows; } else { c = k % cols; r = Math.floor(k / cols); }
        src = get(s, k);
        if (src >= 0) placeInCell(out.doc, pg, path, src, sizeOf(src), x0 + c * (cw + g), y0 + (rows - 1 - r) * (ch + g), cw, ch, o.fit);
      }
      if (o.marks) {
        xs = []; ys = [];
        for (c = 0; c < cols; c++) { xs.push(x0 + c * (cw + g)); xs.push(x0 + c * (cw + g) + cw); }
        for (r = 0; r < rows; r++) { ys.push(y0 + r * (ch + g)); ys.push(y0 + r * (ch + g) + ch); }
        cropMarks(out.doc, pg, xs, ys, { left: x0, right: x0 + gw, bottom: y0, top: y0 + gh });
      }
    }
    return out;
  }

  /** Copy pages of the saved file into a fresh document, in the order given.
   *  entries: {i: page} | {blank: [w,h]}, optional rotate / crop ([l,t,r,b]). */
  function assemble(path, entries, firstSize) {
    var out = newDoc(firstSize[0], firstSize[1]), k, e, last;
    for (k = 0; k < entries.length; k++) {
      e = entries[k];
      last = out.numPages - 1;
      if (e.blank) pNewPage(out, e.blank[0], e.blank[1]);
      else pInsert(out, last, e.path || path, e.i, e.i);
      last = out.numPages - 1;
      if (e.rotate) out.setPageRotations({ nStart: last, nEnd: last, nRotate: (out.getPageRotation({ nPage: last }) + e.rotate) % 360 });
      if (e.crop) out.setPageBoxes({ cBox: 'Crop', nStart: last, nEnd: last, rBox: e.crop });
    }
    out.deletePages({ nStart: 0, nEnd: 0 }); // the placeholder page newDoc started with
    return out;
  }

  function fill(tpl, vals) {
    return String(tpl).replace(/\{(\w+)\}/g, function (m, k) { return vals.hasOwnProperty(k) ? String(vals[k]) : m; });
  }
  function pad(n, digits) { var s = String(n); while (s.length < digits) s = '0' + s; return s; }
  function hexColor(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''), v = m ? parseInt(m[1], 16) : 0;
    return ['RGB', ((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }

  /** Watermark alignment + offsets for an anchor name. dx, dy = distance in from the edges (points). */
  function anchorAlign(anchor, dx, dy) {
    var a = anchor || 'center', o = {};
    o.nHorizAlign = /left/.test(a) ? AL.left : /right/.test(a) ? AL.right : AL.center;
    o.nHorizValue = /right/.test(a) ? -dx : dx;
    o.nVertAlign = /^top/.test(a) ? AL.top : /^bottom/.test(a) ? AL.bottom : AL.center;
    o.nVertValue = /^top/.test(a) ? -dy : dy;
    o.bPercentage = false;
    return o;
  }

  function stampText(doc, pg, text, o) {
    var w = anchorAlign(o.anchor, mm(o.dx), mm(o.dy));
    w.cText = text; w.nTextAlign = AL.left; w.cFont = font.Helv; w.nFontSize = Number(o.size) || 10;
    w.aColor = hexColor(o.color); w.nStart = pg; w.nEnd = pg; w.bOnTop = true; w.nScale = 1; w.nRotation = 0; w.nOpacity = 1;
    pWmText(doc, w);
  }

  function parseCsv(text) {
    var src = String(text || ''), first = src.split('\n')[0];
    var sep = (first.split(';').length > first.split(',').length) ? ';' : (first.indexOf('\t') >= 0 && first.indexOf(',') < 0) ? '\t' : ',';
    var rows = [], row = [], cell = '', q = false, i, ch;
    function endRow() {
      row.push(cell); cell = '';
      for (var k = 0, any = false; k < row.length; k++) if (/\S/.test(row[k])) any = true;
      if (any) rows.push(row);
      row = [];
    }
    for (i = 0; i < src.length; i++) {
      ch = src.charAt(i);
      if (q) {
        if (ch === '"' && src.charAt(i + 1) === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src.charAt(i + 1) === '\n') i++; endRow(); }
      else cell += ch;
    }
    endRow();
    return rows;
  }

  // ---------- field presets ----------

  var SHEET = [
    { key: 'sheet', label: 'Sheet size', type: 'select', options: ['Auto'].concat(SIZE_NAMES, ['Custom']), dflt: 'Auto' },
    { key: 'sheetW', label: 'Custom width (mm)', type: 'number', dflt: 320 },
    { key: 'sheetH', label: 'Custom height (mm)', type: 'number', dflt: 450 },
    { key: 'landscape', label: 'Landscape sheet', type: 'checkbox', dflt: false }
  ];
  function sheetFields(label, dflt) {
    return [{ key: 'sheet', label: label || 'Sheet size', type: 'select', options: SIZE_NAMES.concat(['Custom']), dflt: dflt || 'A4' }, SHEET[1], SHEET[2]];
  }
  var RANGE = { key: 'range', label: 'Pages (all, odd, even, 1-4,7,9-)', type: 'text', dflt: 'all' };
  var POS = [
    { key: 'anchor', label: 'Position', type: 'select', options: ANCHORS, dflt: 'bottom-center' },
    { key: 'dx', label: 'Distance from side (mm)', type: 'number', dflt: 10 },
    { key: 'dy', label: 'Distance from top/bottom (mm)', type: 'number', dflt: 8 }
  ];

  // ---------- commands ----------
  // run(doc, o) returns the document holding the result (a new one, or doc itself when edited in place).

  var COMMANDS = {
    booklet: {
      title: 'Booklet', help: 'Fold-in-half booklet. Print double-sided, flip on the short edge.',
      fields: SHEET.concat([
        { key: 'binding', label: 'Binding', type: 'select', options: ['Left', 'Right'], dflt: 'Left' },
        { key: 'sheetsPerSig', label: 'Sheets per signature (0 = one)', type: 'number', dflt: 0 },
        { key: 'creep', label: 'Creep, total (mm)', type: 'number', dflt: 0 },
        { key: 'marks', label: 'Crop marks', type: 'checkbox', dflt: false }
      ]),
      run: function (doc, o) {
        var path = savedPath(doc); if (!path) return null;
        var n = doc.numPages, p0 = pageSize(doc, 0), pw = p0.w, ph = p0.h;
        var size = sheetSize(o) || [pw * 2, ph], W = size[0], H = size[1];
        var per = o.sheetsPerSig > 0 ? Math.round(o.sheetsPerSig) * 4 : Math.ceil(n / 4) * 4;
        var right = o.binding === 'Right', out = new Sheets(W, H);
        var cw = W / 2, s2 = Math.min(cw / pw, H / ph, 1), w = pw * s2, h = ph * s2, y = (H - h) / 2;
        var start, P, sheets, s, shift, sides, k, l, r, pg;
        for (start = 0; start < n; start += per) {
          P = Math.min(per, Math.ceil((n - start) / 4) * 4);
          sheets = P / 4;
          for (s = 0; s < sheets; s++) {
            shift = sheets > 1 ? (mm(o.creep) * s) / (sheets - 1) / 2 : 0;
            sides = [[P - 1 - 2 * s, 2 * s], [2 * s + 1, P - 2 - 2 * s]];
            for (k = 0; k < 2; k++) {
              l = start + sides[k][right ? 1 : 0]; r = start + sides[k][right ? 0 : 1];
              pg = out.add();
              // pages butt against the spine; creep pushes them further in
              if (l < n) place(out.doc, pg, path, l, cw - w + shift, y, s2);
              if (r < n) place(out.doc, pg, path, r, cw - shift, y, s2);
              if (o.marks) cropMarks(out.doc, pg, [cw - w, cw, cw + w], [y, y + h], { left: cw - w, right: cw + w, bottom: y, top: y + h });
            }
          }
        }
        if (o.marks) flatten(out.doc);
        return out.doc;
      }
    },

    nup: {
      title: 'N-up', help: 'Several consecutive pages on each sheet, e.g. 2 x 2.',
      fields: [
        { key: 'cols', label: 'Columns', type: 'number', dflt: 2 },
        { key: 'rows', label: 'Rows', type: 'number', dflt: 2 }
      ].concat(SHEET, [
        { key: 'margin', label: 'Sheet margin (mm)', type: 'number', dflt: 0 },
        { key: 'gap', label: 'Gap between pages (mm)', type: 'number', dflt: 0 },
        { key: 'fit', label: 'Scale pages to fit', type: 'checkbox', dflt: true },
        { key: 'order', label: 'Order', type: 'select', options: ['Across then down', 'Down then across'], dflt: 'Across then down' },
        { key: 'marks', label: 'Crop marks', type: 'checkbox', dflt: false }
      ]),
      run: function (doc, o) {
        var path = savedPath(doc); if (!path) return null;
        var n = doc.numPages, cols = Math.max(1, Math.round(o.cols)), rows = Math.max(1, Math.round(o.rows)), per = cols * rows;
        var maxW = 0, maxH = 0, i, sz;
        for (i = 0; i < n; i++) { sz = pageSize(doc, i); maxW = Math.max(maxW, sz.w); maxH = Math.max(maxH, sz.h); }
        var out = layoutGrid(path, o, cols, rows, Math.ceil(n / per),
          function (s, k) { return s * per + k < n ? s * per + k : -1; },
          function (i) { return pageSize(doc, i); }, maxW, maxH);
        if (o.marks) flatten(out.doc);
        return out.doc;
      }
    },

    stepRepeat: {
      title: 'Step & repeat', help: 'Fill each sheet with copies of the same page (cards, labels, tickets).',
      fields: sheetFields().concat([
        { key: 'landscape', label: 'Landscape sheet', type: 'checkbox', dflt: false },
        { key: 'margin', label: 'Sheet margin (mm)', type: 'number', dflt: 5 },
        { key: 'gap', label: 'Gap between copies (mm)', type: 'number', dflt: 0 },
        { key: 'autoRotate', label: 'Turn the sheet if more copies fit', type: 'checkbox', dflt: true },
        { key: 'marks', label: 'Crop marks', type: 'checkbox', dflt: true }
      ]),
      run: function (doc, o) {
        var path = savedPath(doc); if (!path) return null;
        var size = sheetSize(o), m = mm(o.margin), g = mm(o.gap), n = doc.numPages, i, it, a, b, W, H, out = null, go;
        function count(W, H, w, h) { return [Math.floor((W - 2 * m + g) / (w + g)), Math.floor((H - 2 * m + g) / (h + g))]; }
        for (i = 0; i < n; i++) {
          it = pageSize(doc, i);
          W = size[0]; H = size[1];
          a = count(W, H, it.w, it.h); b = count(H, W, it.w, it.h);
          // pages are never rotated; instead the sheet is used in its other orientation when that holds more
          if (o.autoRotate && b[0] * b[1] > a[0] * a[1]) { a = b; W = size[1]; H = size[0]; }
          if (a[0] * a[1] < 1) throw new Error('Page ' + (i + 1) + ' does not fit on the sheet even once. Pick a larger sheet or a smaller margin.');
          go = { sheet: 'Custom', sheetW: W / MM, sheetH: H / MM, landscape: false, fit: false, margin: o.margin, gap: o.gap, marks: o.marks, _sheets: null };
          if (out && out.W === W && out.H === H) go._sheets = out;
          else if (out) throw new Error('Pages of different sizes need different sheet orientations. Run Step & repeat on them separately.');
          out = layoutGrid(path, go, a[0], a[1], 1, (function (p) { return function () { return p; }; })(i), function () { return it; }, it.w, it.h);
        }
        if (o.marks) flatten(out.doc);
        return out.doc;
      }
    },

    shuffle: {
      title: 'Shuffle pages',
      help: 'Reorder pages in repeating groups. "4 1 2 3" = take 4 pages at a time, output 4th, 1st, 2nd, 3rd. Add * (upside down), > or < (turn), 0 = blank.',
      fields: [
        { key: 'rule', label: 'Rule', type: 'text', dflt: '4 1 2 3' },
        { key: 'group', label: 'Pages per group (0 = largest number in rule)', type: 'number', dflt: 0 }
      ],
      run: function (doc, o) {
        var path = savedPath(doc); if (!path) return null;
        var n = doc.numPages, raw = String(o.rule).replace(/^\s+|\s+$/g, '').split(/[\s,]+/), toks = [], i, m, size = 0, g, t, idx, entries = [], ps;
        var ROT = { '*': 180, '>': 90, '<': 270, '': 0 };
        for (i = 0; i < raw.length; i++) {
          if (!raw[i]) continue;
          m = /^(\d+)([*<>]?)$/.exec(raw[i]);
          if (!m) throw new Error('Cannot read "' + raw[i] + '" in the rule');
          toks.push({ k: +m[1], rotate: ROT[m[2]] });
          size = Math.max(size, +m[1]);
        }
        if (o.group > 0) size = Math.round(o.group);
        if (!toks.length || size < 1) throw new Error('The rule needs at least one page number');
        for (g = 0; g < n; g += size) {
          for (i = 0; i < toks.length; i++) {
            t = toks[i]; idx = g + t.k - 1;
            if (t.k === 0 || t.k > size || idx >= n) { ps = pageSize(doc, g); entries.push({ blank: [ps.w, ps.h] }); }
            else entries.push({ i: idx, rotate: t.rotate });
          }
        }
        ps = pageSize(doc, 0);
        return assemble(path, entries, [ps.w, ps.h]);
      }
    },

    tile: {
      title: 'Tile pages', help: 'Cut each page into a grid of smaller pages (split spreads, posters).',
      fields: [RANGE,
        { key: 'cols', label: 'Columns', type: 'number', dflt: 2 },
        { key: 'rows', label: 'Rows', type: 'number', dflt: 1 },
        { key: 'overlap', label: 'Overlap / bleed (mm)', type: 'number', dflt: 0 }],
      run: function (doc, o) {
        var path = savedPath(doc); if (!path) return null;
        var n = doc.numPages, chosen = inSet(parseRange(o.range, n)), entries = [], i, it, r, c, tw, th, x0, y0, b, ps;
        var cols = Math.max(1, Math.round(o.cols)), rows = Math.max(1, Math.round(o.rows)), ov = mm(o.overlap);
        function clamp(v, max) { return Math.min(Math.max(v, 0), max); }
        for (i = 0; i < n; i++) {
          if (!chosen[i]) { entries.push({ i: i }); continue; }
          it = pageSize(doc, i); b = it.box;
          tw = Math.min(it.w, it.w / cols + ov); th = Math.min(it.h, it.h / rows + ov);
          for (r = 0; r < rows; r++) for (c = 0; c < cols; c++) {
            x0 = clamp(c * (it.w / cols) - ov / 2, it.w - tw);
            y0 = clamp((rows - 1 - r) * (it.h / rows) - ov / 2, it.h - th);
            entries.push({ i: i, crop: [b[0] + x0, b[3] + y0 + th, b[0] + x0 + tw, b[3] + y0] });
          }
        }
        ps = pageSize(doc, 0);
        return assemble(path, entries, [ps.w, ps.h]);
      }
    },

    trimShift: {
      title: 'Trim & shift', help: 'Cut strips off the edges and/or move the content. Negative trim adds space. Changes this document.',
      fields: [RANGE,
        { key: 'left', label: 'Trim left (mm)', type: 'number', dflt: 0 },
        { key: 'right', label: 'Trim right (mm)', type: 'number', dflt: 0 },
        { key: 'top', label: 'Trim top (mm)', type: 'number', dflt: 0 },
        { key: 'bottom', label: 'Trim bottom (mm)', type: 'number', dflt: 0 },
        { key: 'dx', label: 'Shift right (mm)', type: 'number', dflt: 0 },
        { key: 'dy', label: 'Shift up (mm)', type: 'number', dflt: 0 },
        { key: 'mirror', label: 'Mirror left/right on even pages', type: 'checkbox', dflt: false }],
      run: function (doc, o) {
        var sel = parseRange(o.range, doc.numPages), k, i, b, flip, l, r, dx, nb;
        for (k = 0; k < sel.length; k++) {
          i = sel[k]; b = pageSize(doc, i).box; flip = o.mirror && i % 2 === 1;
          l = mm(flip ? o.right : o.left); r = mm(flip ? o.left : o.right); dx = (flip ? -1 : 1) * mm(o.dx);
          // moving the content right is the same as moving the page window left
          nb = [b[0] + l - dx, b[1] - mm(o.top) - mm(o.dy), b[2] - r - dx, b[3] + mm(o.bottom) - mm(o.dy)];
          if (nb[2] - nb[0] <= 0 || nb[1] - nb[3] <= 0) throw new Error('Trim is larger than page ' + (i + 1));
          setBox(doc, i, nb);
        }
        return doc;
      }
    },

    adjustSize: {
      title: 'Adjust page size', help: 'Scale pages, fit them to a paper size, or change the paper around the content.',
      fields: [RANGE,
        { key: 'mode', label: 'What to do', type: 'select', options: ['Scale to fit size', 'Scale by percent', 'Change size, keep content'], dflt: 'Scale to fit size' },
        { key: 'percent', label: 'Percent (for "Scale by percent")', type: 'number', dflt: 100 }
      ].concat(sheetFields('New size'), [
        { key: 'matchOrient', label: 'Match each page\'s orientation', type: 'checkbox', dflt: true }]),
      run: function (doc, o) {
        var n = doc.numPages, sel = parseRange(o.range, n), chosen = inSet(sel), i, it, W, H, t, s, size, cx, cy, path, out, pg;
        function target(it) {
          var sz = sheetSize({ sheet: o.sheet, sheetW: o.sheetW, sheetH: o.sheetH }), W = sz[0], H = sz[1];
          if (o.matchOrient && (W > H) !== (it.w > it.h)) { t = W; W = H; H = t; }
          return [W, H];
        }
        if (o.mode === 'Change size, keep content') {
          for (i = 0; i < sel.length; i++) {
            it = pageSize(doc, sel[i]); size = target(it);
            cx = (it.box[0] + it.box[2]) / 2; cy = (it.box[1] + it.box[3]) / 2;
            setBox(doc, sel[i], [cx - size[0] / 2, cy + size[1] / 2, cx + size[0] / 2, cy - size[1] / 2]);
          }
          return doc;
        }
        path = savedPath(doc); if (!path) return null;
        if (o.mode === 'Scale by percent' && !(o.percent > 0)) throw new Error('Percent must be above zero');
        for (i = 0; i < n; i++) {
          it = pageSize(doc, i);
          if (!chosen[i]) { W = it.w; H = it.h; s = 1; }
          else if (o.mode === 'Scale by percent') { s = o.percent / 100; W = it.w * s; H = it.h * s; }
          else { size = target(it); W = size[0]; H = size[1]; s = Math.min(W / it.w, H / it.h); }
          if (!out) out = newDoc(W, H); else pNewPage(out, W, H);
          pg = out.numPages - 1;
          place(out, pg, path, i, (W - it.w * s) / 2, (H - it.h * s) / 2, s);
        }
        return out;
      }
    },

    bleed: {
      title: 'Generate bleed', help: 'Grow each page on all sides and fill the border by enlarging the artwork slightly.',
      fields: [{ key: 'amount', label: 'Bleed (mm)', type: 'number', dflt: 3 }],
      run: function (doc, o) {
        var path = savedPath(doc); if (!path) return null;
        var n = doc.numPages, b = mm(o.amount), i, it, W, H, s, out;
        for (i = 0; i < n; i++) {
          it = pageSize(doc, i); W = it.w + 2 * b; H = it.h + 2 * b;
          s = Math.max(W / it.w, H / it.h);
          if (!out) out = newDoc(W, H); else pNewPage(out, W, H);
          place(out, out.numPages - 1, path, i, (W - it.w * s) / 2, (H - it.h * s) / 2, s);
        }
        return out;
      }
    },

    reverse: {
      title: 'Reverse pages', help: 'Put the pages in the opposite order. Changes this document.', fields: [],
      run: function (doc) {
        var n = doc.numPages, i;
        for (i = 0; i < n - 1; i++) doc.movePage({ nPage: n - 1, nAfter: i - 1 });
        return doc;
      }
    },

    insertBlank: {
      title: 'Insert blank pages', help: 'Add empty pages: a fixed number, or enough to reach a multiple (4 for a booklet). Changes this document.',
      fields: [
        { key: 'mode', label: 'How many', type: 'select', options: ['Until page count is a multiple of', 'Fixed number'], dflt: 'Until page count is a multiple of' },
        { key: 'count', label: 'Number (count, or the multiple)', type: 'number', dflt: 4 },
        { key: 'where', label: 'Where', type: 'select', options: ['At the end', 'At the start', 'After page number below', 'Before the last page'], dflt: 'At the end' },
        { key: 'after', label: 'After page', type: 'number', dflt: 1 }],
      run: function (doc, o) {
        var n = doc.numPages, c = Math.max(1, Math.round(o.count)), add = o.mode === 'Fixed number' ? c : (c - (n % c)) % c;
        var at = o.where === 'At the end' ? n : o.where === 'At the start' ? 0 : o.where === 'Before the last page' ? Math.max(0, n - 1) : Math.min(n, Math.max(0, Math.round(o.after)));
        var ps = pageSize(doc, Math.max(0, at - 1)), k;
        for (k = 0; k < add; k++) {
          pNewPage(doc, ps.w, ps.h);                                  // appended at the end…
          if (at + k < doc.numPages - 1) doc.movePage({ nPage: doc.numPages - 1, nAfter: at + k - 1 }); // …then moved into place
        }
        return doc;
      }
    },

    duplicate: {
      title: 'Duplicate pages', help: 'Make extra copies of pages. Changes this document.',
      fields: [RANGE,
        { key: 'copies', label: 'Copies of each (total)', type: 'number', dflt: 2 },
        { key: 'collate', label: 'Collate (1 2 3, 1 2 3)', type: 'checkbox', dflt: false }],
      run: function (doc, o) {
        var path = savedPath(doc); if (!path) return null;
        var sel = parseRange(o.range, doc.numPages), c = Math.max(1, Math.round(o.copies)), k, j, x, after;
        if (!sel.length) return doc;
        if (o.collate) {
          // extra copies of the whole run go right after its last page
          after = sel[sel.length - 1];
          for (j = 1; j < c; j++) for (k = 0; k < sel.length; k++) { pInsert(doc, after, path, sel[k], sel[k]); after++; }
        } else {
          // work backwards so earlier page numbers still match the saved file
          for (k = sel.length - 1; k >= 0; k--) for (x = 1; x < c; x++) pInsert(doc, sel[k], path, sel[k], sel[k]);
        }
        return doc;
      }
    },

    interleave: {
      title: 'Interleave another PDF', help: 'Merge another PDF page by page: this, other, this, other… (e.g. separately scanned odd and even pages). Changes this document.',
      fields: [{ key: 'reverseOther', label: 'The other PDF is in reverse order', type: 'checkbox', dflt: false }],
      needsFile: 'Choose the PDF to interleave',
      run: function (doc, o) {
        var m = pCountPages(o.file), n = doc.numPages, k, j;
        for (k = 0; k < m; k++) {
          j = o.reverseOther ? m - 1 - k : k;
          pInsert(doc, Math.min(2 * k, n + k - 1), o.file, j, j);
        }
        return doc;
      }
    },

    stickText: {
      title: 'Text & page numbers',
      help: 'Stamp text on pages. Fields: {page} {pages} {file} {date}, and {n} = running number with leading zeros (Bates). Changes this document.',
      fields: [{ key: 'text', label: 'Text', type: 'text', dflt: '{page} / {pages}' }, RANGE].concat(POS, [
        { key: 'size', label: 'Font size (pt)', type: 'number', dflt: 10 },
        { key: 'color', label: 'Colour (hex, e.g. #000000)', type: 'text', dflt: '#000000' },
        { key: 'firstPageNo', label: '{page} of the first page', type: 'number', dflt: 1 },
        { key: 'start', label: '{n} starts at', type: 'number', dflt: 1 },
        { key: 'digits', label: '{n} digits', type: 'number', dflt: 6 }]),
      run: function (doc, o) {
        var n = doc.numPages, sel = parseRange(o.range, n), k, i;
        for (k = 0; k < sel.length; k++) {
          i = sel[k];
          stampText(doc, i, fill(o.text, {
            page: i + Math.round(o.firstPageNo), pages: n, file: doc.documentFileName, date: util.printd('d.m.yyyy', new Date()),
            n: pad(Math.round(o.start) + k, Math.round(o.digits))
          }), o);
        }
        return doc;
      }
    },

    stickPage: {
      title: 'Place a PDF page', help: 'Put a page of another PDF on top of (or behind) pages: logo, letterhead, watermark, manual imposition. Changes this document.',
      fields: [{ key: 'sourcePage', label: 'Page number to place', type: 'number', dflt: 1 }, RANGE,
        { key: 'anchor', label: 'Position', type: 'select', options: ANCHORS, dflt: 'center' },
        { key: 'dx', label: 'Distance from side (mm)', type: 'number', dflt: 0 },
        { key: 'dy', label: 'Distance from top/bottom (mm)', type: 'number', dflt: 0 },
        { key: 'scale', label: 'Scale (%)', type: 'number', dflt: 100 },
        { key: 'fitPage', label: 'Scale to fill the whole page instead', type: 'checkbox', dflt: false },
        { key: 'behind', label: 'Place behind the page content', type: 'checkbox', dflt: false }],
      needsFile: 'Choose the PDF that holds the page to place',
      run: function (doc, o) {
        var sel = parseRange(o.range, doc.numPages), k, w;
        for (k = 0; k < sel.length; k++) {
          w = o.fitPage ? anchorAlign('center', 0, 0) : anchorAlign(o.anchor, mm(o.dx), mm(o.dy));
          w.cDIPath = o.file; w.nSourcePage = Math.max(0, Math.round(o.sourcePage) - 1);
          w.nStart = sel[k]; w.nEnd = sel[k]; w.bOnTop = !o.behind;
          w.nScale = o.fitPage ? -1 : o.scale / 100; w.nRotation = 0; w.nOpacity = 1;
          pWmFile(doc, w);
        }
        return doc;
      }
    },

    tape: {
      title: 'Masking tape', help: 'Cover part of the page with a solid rectangle (hide old page numbers or marks). Changes this document.',
      fields: [RANGE,
        { key: 'anchor', label: 'Position', type: 'select', options: ANCHORS, dflt: 'bottom-center' },
        { key: 'dx', label: 'Distance from side (mm)', type: 'number', dflt: 0 },
        { key: 'dy', label: 'Distance from top/bottom (mm)', type: 'number', dflt: 0 },
        { key: 'w', label: 'Width (mm)', type: 'number', dflt: 60 },
        { key: 'h', label: 'Height (mm)', type: 'number', dflt: 15 },
        { key: 'color', label: 'Colour (hex)', type: 'text', dflt: '#ffffff' }],
      run: function (doc, o) {
        var sel = parseRange(o.range, doc.numPages), k, it, b, w = mm(o.w), h = mm(o.h), dx = mm(o.dx), dy = mm(o.dy), x, y, a = o.anchor, c = hexColor(o.color);
        for (k = 0; k < sel.length; k++) {
          it = pageSize(doc, sel[k]); b = it.box;
          x = b[0] + (/left/.test(a) ? dx : /right/.test(a) ? it.w - w - dx : (it.w - w) / 2 + dx);
          y = b[3] + (/^top/.test(a) ? it.h - h - dy : /^bottom/.test(a) ? dy : (it.h - h) / 2 + dy);
          doc.addAnnot({ type: 'Square', page: sel[k], rect: [x, y, x + w, y + h], fillColor: c, strokeColor: c, width: 0 });
        }
        flatten(doc);
        return doc;
      }
    },

    variableData: {
      title: 'Variable data (CSV)',
      help: 'One copy of the document per CSV row, stamped with that row\'s values. First line = column names; use them in the text as {name}.',
      fields: [
        { key: 'csv', label: 'CSV data (paste here)', type: 'textarea', dflt: 'name,seat\nAna,12\nBor,13' },
        { key: 'text', label: 'Text', type: 'text', dflt: '{name} - seat {seat}' },
        { key: 'range', label: 'Stamp on pages (of each copy)', type: 'text', dflt: 'all' },
        { key: 'anchor', label: 'Position', type: 'select', options: ANCHORS, dflt: 'center' },
        { key: 'dx', label: 'Distance from side (mm)', type: 'number', dflt: 0 },
        { key: 'dy', label: 'Distance from top/bottom (mm)', type: 'number', dflt: 0 },
        { key: 'size', label: 'Font size (pt)', type: 'number', dflt: 14 },
        { key: 'color', label: 'Colour (hex)', type: 'text', dflt: '#000000' }],
      run: function (doc, o) {
        var rows = parseCsv(o.csv);
        if (rows.length < 2) throw new Error('The CSV needs a header line and at least one data row');
        var path = savedPath(doc); if (!path) return null;
        var n = doc.numPages, head = rows[0], sel = parseRange(o.range, n), ps = pageSize(doc, 0), out = newDoc(ps.w, ps.h), r, c, k, vals;
        for (r = 1; r < rows.length; r++) pInsert(out, out.numPages - 1, path, 0, n - 1);
        out.deletePages({ nStart: 0, nEnd: 0 });
        for (r = 1; r < rows.length; r++) {
          vals = { row: r, pages: n };
          for (c = 0; c < head.length; c++) vals[head[c].replace(/^\s+|\s+$/g, '')] = rows[r][c] == null ? '' : rows[r][c];
          for (k = 0; k < sel.length; k++) { vals.page = sel[k] + 1; stampText(out, (r - 1) * n + sel[k], fill(o.text, vals), o); }
        }
        return out;
      }
    },

    sample: {
      title: 'Create sample document', help: 'A numbered test document to try layouts on.', needsNoDoc: true,
      fields: [{ key: 'pages', label: 'Pages', type: 'number', dflt: 8 }].concat(sheetFields('Page size', 'A5'), [
        { key: 'landscape', label: 'Landscape', type: 'checkbox', dflt: false }]),
      run: function (doc, o) {
        var size = sheetSize(o), W = size[0], H = size[1], n = Math.min(500, Math.max(1, Math.round(o.pages))), out = newDoc(W, H), i;
        for (i = 1; i < n; i++) pNewPage(out, W, H);
        for (i = 0; i < n; i++) {
          stampText(out, i, String(i + 1), { anchor: 'center', dx: 0, dy: 0, size: Math.min(W, H) * 0.4, color: '#1f5fd0' });
          stampText(out, i, 'Page ' + (i + 1) + ' of ' + n + ' - TOP', { anchor: 'top-left', dx: 8, dy: 8, size: 9, color: '#444444' });
        }
        return out;
      }
    }
  };

  /** Set the visible page box; grows the media box first when the new box reaches outside it. */
  function setBox(doc, i, nb) {
    var m = doc.getPageBox({ cBox: 'Media', nPage: i });
    var u = [Math.min(m[0], nb[0]), Math.max(m[1], nb[1]), Math.max(m[2], nb[2]), Math.min(m[3], nb[3])];
    if (u[0] !== m[0] || u[1] !== m[1] || u[2] !== m[2] || u[3] !== m[3]) doc.setPageBoxes({ cBox: 'Media', nStart: i, nEnd: i, rBox: u });
    doc.setPageBoxes({ cBox: 'Crop', nStart: i, nEnd: i, rBox: nb });
  }

  // ---------- dialog ----------

  var remembered = {}; // last options used per command, for this Acrobat session

  function defaults(cmd) {
    var o = {}, f = COMMANDS[cmd].fields, i;
    for (i = 0; i < f.length; i++) o[f[i].key] = f[i].dflt;
    return o;
  }

  function num(s) { var v = parseFloat(String(s).replace(',', '.')); return isNaN(v) ? 0 : v; }

  /** Show the settings dialog for a command. Returns options, or null if cancelled. */
  function ask(cmd) {
    var c = COMMANDS[cmd], o = remembered[cmd] || defaults(cmd), rows = [], ids = [], i, f, id, ctl;
    if (!c.fields.length) return o;
    for (i = 0; i < c.fields.length; i++) {
      f = c.fields[i]; id = 'f' + pad(i, 3); ids.push(id); // item ids must be exactly 4 characters
      if (f.type === 'checkbox') ctl = { type: 'check_box', item_id: id, name: f.label };
      else if (f.type === 'select') ctl = { type: 'popup', item_id: id, width: 230 };
      else if (f.type === 'textarea') ctl = { type: 'edit_text', item_id: id, multiline: true, width: 230, height: 90 };
      else ctl = { type: 'edit_text', item_id: id, width: 230 };
      rows.push({ type: 'view', align_children: 'align_row', elements: f.type === 'checkbox'
        ? [{ type: 'static_text', name: ' ', width: 230 }, ctl]
        : [{ type: 'static_text', name: f.label + ':', width: 230 }, ctl] });
    }
    var dlg = {
      result: null,
      initialize: function (dialog) {
        var data = {}, i, f, list, k;
        for (i = 0; i < c.fields.length; i++) {
          f = c.fields[i];
          if (f.type === 'select') {
            list = {};
            for (k = 0; k < f.options.length; k++) list[f.options[k]] = (f.options[k] === o[f.key] ? 1 : -1) * (k + 1);
            data[ids[i]] = list;
          } else if (f.type === 'checkbox') data[ids[i]] = !!o[f.key];
          else data[ids[i]] = String(o[f.key]);
        }
        dialog.load(data);
      },
      commit: function (dialog) {
        var data = dialog.store(), r = {}, i, f, v, k;
        for (i = 0; i < c.fields.length; i++) {
          f = c.fields[i]; v = data[ids[i]];
          if (f.type === 'select') { r[f.key] = f.dflt; for (k in v) if (v[k] > 0) r[f.key] = k; }
          else if (f.type === 'checkbox') r[f.key] = !!v;
          else if (f.type === 'number') r[f.key] = num(v);
          else r[f.key] = String(v);
        }
        this.result = r;
      },
      description: {
        name: 'Imposer - ' + c.title,
        elements: [{ type: 'view', align_children: 'align_left', elements: [
          { type: 'static_text', name: c.help, width: 470, height: 34, multiline: true }
        ].concat(rows, [{ type: 'ok_cancel', ok_name: 'Apply' }]) }]
      }
    };
    if (app.execDialog(dlg) !== 'ok' || !dlg.result) return null;
    remembered[cmd] = dlg.result;
    return dlg.result;
  }

  // ---------- running, recording, sequences ----------

  var steps = []; // what was done this session, for "Save steps as a sequence"

  function exec(cmd, doc, o) {
    var c = COMMANDS[cmd];
    if (!doc && !c.needsNoDoc) { app.alert({ cMsg: 'Open a PDF first.', cTitle: 'Imposer' }); return null; }
    try {
      return c.run(doc, o);
    } catch (e) {
      app.alert({ cMsg: c.title + ' did not work:\n\n' + (e.message || e), cTitle: 'Imposer', nIcon: 0 });
      return null;
    }
  }

  function run(cmd, doc) {
    var c = COMMANDS[cmd], o;
    if (!doc && !c.needsNoDoc) { app.alert({ cMsg: 'Open a PDF first.', cTitle: 'Imposer' }); return; }
    o = ask(cmd);
    if (!o) return;
    if (c.needsFile) {
      app.alert({ cMsg: c.needsFile + ' in the next window.', cTitle: 'Imposer', nIcon: 3 });
      o.file = pBrowse();
      if (!o.file) return;
    }
    if (exec(cmd, doc, o)) steps.push({ cmd: cmd, opts: o });
  }

  function loadSeqs() {
    try { var v = pGlobalGet(); return v ? JSON.parse(v) : {}; } catch (e) { return {}; }
  }
  function storeSeqs(all) {
    try { pGlobalSet(JSON.stringify(all)); return true; }
    catch (e) { app.alert({ cMsg: 'Acrobat would not store the sequence:\n\n' + (e.message || e), cTitle: 'Imposer' }); return false; }
  }
  function seqNames() { var all = loadSeqs(), names = [], k; for (k in all) if (all.hasOwnProperty(k)) names.push(k); return names; }

  function saveSequence() {
    var list = [], i, name, all;
    for (i = 0; i < steps.length; i++) if (!COMMANDS[steps[i].cmd].needsNoDoc) list.push(steps[i]);
    if (!list.length) { app.alert({ cMsg: 'Nothing to save yet. Run the Imposer commands you want first, then save them as a sequence.', cTitle: 'Imposer' }); return; }
    var titles = [];
    for (i = 0; i < list.length; i++) titles.push((i + 1) + '. ' + COMMANDS[list[i].cmd].title);
    name = app.response({ cQuestion: 'These steps will be saved:\n\n' + titles.join('\n') + '\n\nName for this sequence:', cTitle: 'Imposer - save sequence' });
    if (!name) return;
    all = loadSeqs(); all[name] = list;
    if (!storeSeqs(all)) return;
    steps = [];
    app.alert({ cMsg: 'Saved "' + name + '". Run it from Imposer > Run a saved sequence.', cTitle: 'Imposer', nIcon: 3 });
  }

  function pickSequence(title) {
    var names = seqNames(), list = {}, k, picked = null;
    if (!names.length) { app.alert({ cMsg: 'There are no saved sequences yet.', cTitle: 'Imposer' }); return null; }
    for (k = 0; k < names.length; k++) list[names[k]] = (k === 0 ? 1 : -1) * (k + 1);
    var dlg = {
      initialize: function (d) { d.load({ seqn: list }); },
      commit: function (d) { var v = d.store().seqn, k; for (k in v) if (v[k] > 0) picked = k; },
      description: { name: title, elements: [{ type: 'view', elements: [
        { type: 'popup', item_id: 'seqn', width: 300 }, { type: 'ok_cancel' }] }] }
    };
    return app.execDialog(dlg) === 'ok' ? picked : null;
  }

  function runSequence(doc) {
    var name, list, i, cur = doc;
    if (!doc) { app.alert({ cMsg: 'Open a PDF first.', cTitle: 'Imposer' }); return; }
    name = pickSequence('Imposer - run sequence');
    if (!name) return;
    list = loadSeqs()[name];
    for (i = 0; i < list.length; i++) {
      if (!COMMANDS[list[i].cmd]) { app.alert({ cMsg: 'This sequence has a step this version does not know.', cTitle: 'Imposer' }); return; }
      cur = exec(list[i].cmd, cur, list[i].opts);
      if (!cur) return;
    }
  }

  function deleteSequence() {
    var name = pickSequence('Imposer - delete sequence'), all;
    if (!name) return;
    if (app.alert({ cMsg: 'Delete the sequence "' + name + '"?', cTitle: 'Imposer', nIcon: 2, nType: 2 }) !== 4) return;
    all = loadSeqs(); delete all[name]; storeSeqs(all);
  }

  // ---------- menu ----------

  var MENU = [
    ['Impose', ['booklet', 'nup', 'stepRepeat', 'shuffle', 'tile']],
    ['Pages', ['trimShift', 'adjustSize', 'bleed', 'reverse', 'insertBlank', 'duplicate', 'interleave']],
    ['Stick on', ['stickText', 'stickPage', 'tape', 'variableData']]
  ];

  function install() {
    var g, k, cmd, parent, needDoc = 'event.rc = (event.target != null);';
    app.addSubMenu({ cName: 'Imposer', cUser: 'Imposer', cParent: 'Edit', nPos: 0 });
    for (g = 0; g < MENU.length; g++) {
      parent = 'Imposer:' + MENU[g][0];
      app.addSubMenu({ cName: parent, cUser: MENU[g][0], cParent: 'Imposer' });
      for (k = 0; k < MENU[g][1].length; k++) {
        cmd = MENU[g][1][k];
        app.addMenuItem({ cName: 'Imposer:' + cmd, cUser: COMMANDS[cmd].title + '...', cParent: parent,
          cExec: 'Imposer.run("' + cmd + '", event.target);', cEnable: needDoc });
      }
    }
    app.addMenuItem({ cName: 'Imposer:sample', cUser: 'Create sample document...', cParent: 'Imposer', cExec: 'Imposer.run("sample", event.target);' });
    app.addMenuItem({ cName: 'Imposer:seqRun', cUser: 'Run a saved sequence...', cParent: 'Imposer', cExec: 'Imposer.runSequence(event.target);', cEnable: needDoc });
    app.addMenuItem({ cName: 'Imposer:seqSave', cUser: 'Save my steps as a sequence...', cParent: 'Imposer', cExec: 'Imposer.saveSequence();' });
    app.addMenuItem({ cName: 'Imposer:seqDel', cUser: 'Delete a saved sequence...', cParent: 'Imposer', cExec: 'Imposer.deleteSequence();' });
  }

  return {
    run: run, exec: exec, runSequence: runSequence, saveSequence: saveSequence, deleteSequence: deleteSequence,
    install: install, COMMANDS: COMMANDS, defaults: defaults, parseRange: parseRange, parseCsv: parseCsv
  };
})();

Imposer.install();
