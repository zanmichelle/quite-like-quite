# Imposer

PDF imposition, two ways:

- **Acrobat plug-in** — `acrobat/Imposer.js`, adds an *Imposer* menu inside Adobe Acrobat Pro/Standard. See [acrobat/INSTALL.md](acrobat/INSTALL.md).
- **Standalone** — `imposer.html`, runs in any browser, offline (double-click).

## Acrobat plug-in

| Menu | Commands |
| --- | --- |
| Impose | Booklet (signatures, creep, crop marks) · N-up · Step & repeat · Shuffle pages (rule like `4 1 2 3`) · Tile pages |
| Pages | Trim & shift · Adjust page size · Generate bleed · Reverse · Insert blank pages (fixed or "until multiple of 4") · Duplicate pages · Interleave another PDF |
| Stick on | Text, page numbers, Bates numbers (`{page} {pages} {file} {date} {n}`) · Place a PDF page · Masking tape · Variable data from CSV |
| | Create sample document · Saved sequences |

It is a folder-level JavaScript (plain ES5), so it installs by copying one file — no compiler or Adobe SDK.
`npm test` checks its logic against a stand-in for Acrobat's API (`test/acrobat.test.js`); it has **not yet been run inside a real Acrobat**.

Limits of Acrobat's scripting API: pages are never rotated while placing (Step & repeat turns the sheet instead), bleed is made by enlarging rather than mirroring, and placed pages become Acrobat watermarks.

## Standalone app

Open `imposer.html` — files never leave your computer.

| Group | Tools |
| --- | --- |
| Impose | Booklet (signatures, creep, crop marks) · N-up · Step & repeat · Shuffle pages (rule like `4 1 2 3`) · Tile pages |
| Pages | Trim & shift · Adjust page size · Generate bleed · Delete / duplicate / rotate / move · Reverse · Insert blank pages (fixed or "until multiple of 4") · Insert / interleave another PDF |
| Stick on | Text, page numbers, Bates numbers, fields (`{page} {pages} {file} {date} {n}`) · Place a PDF page (logo, watermark, manual imposition) · Masking tape · Variable data from CSV |
| Tools | Create sample document · Undo / redo · Saved sequences (replay your steps on the next file) |

## Develop

```
npm install
npm test          # engine tests (src/core.js) + plug-in logic tests
npm run build     # bundles src/ into imposer.html
```

`src/core.js` is the engine (each command is `bytes, options -> bytes`, usable from Node too); `src/app.js` is the UI.
Built on [pdf-lib](https://pdf-lib.js.org/). Stamped text uses DejaVu Sans (see `assets/`), so č š ž work.

Not included: PDF/X handling, imposing annotations and form fields (they are dropped from imposed pages), hot folders.
