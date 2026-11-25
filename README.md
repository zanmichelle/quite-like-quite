# Imposer

PDF imposition in the browser. Open `imposer.html` (double-click, works offline) — files never leave your computer.

| Group | Tools |
| --- | --- |
| Impose | Booklet (signatures, creep, crop marks) · N-up · Step & repeat · Shuffle pages (rule like `4 1 2 3`) · Tile pages |
| Pages | Trim & shift · Adjust page size · Generate bleed · Delete / duplicate / rotate / move · Reverse · Insert blank pages (fixed or "until multiple of 4") · Insert / interleave another PDF |
| Stick on | Text, page numbers, Bates numbers, fields (`{page} {pages} {file} {date} {n}`) · Place a PDF page (logo, watermark, manual imposition) · Masking tape · Variable data from CSV |
| Tools | Create sample document · Undo / redo · Saved sequences (replay your steps on the next file) |

## Develop

```
npm install
npm test          # engine tests (src/core.js)
npm run build     # bundles src/ into imposer.html
```

`src/core.js` is the engine (each command is `bytes, options -> bytes`, usable from Node too); `src/app.js` is the UI.
Built on [pdf-lib](https://pdf-lib.js.org/). Stamped text uses DejaVu Sans (see `assets/`), so č š ž work.

Not included: PDF/X handling, imposing annotations and form fields (they are dropped from imposed pages), hot folders.
