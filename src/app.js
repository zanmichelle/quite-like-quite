import { COMMANDS, defaults, run, describe } from './core.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
};
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// history[at] is the current document. Each entry: { bytes, step } where step = {cmd, opts} that produced it.
const state = { name: 'document.pdf', history: [], at: -1, cmd: 'booklet', opts: {}, busy: false, url: null };
const current = () => state.history[state.at]?.bytes ?? null;

let fontBytes;
const ctx = () => ({
  fileName: state.name,
  loadFont: async () => (fontBytes ??= Uint8Array.from(atob(window.IMPOSER_FONT), (c) => c.charCodeAt(0))),
});

// ---------- document ----------

async function setDoc(bytes, step, name) {
  if (name) { state.name = name; state.history = []; state.at = -1; }
  state.history = state.history.slice(0, state.at + 1);
  state.history.push({ bytes, step });
  if (state.history.length > 30) state.history.shift();
  state.at = state.history.length - 1;
  await refresh();
}

async function refresh() {
  const bytes = current();
  document.body.classList.toggle('empty', !bytes);
  $('#undo').disabled = state.at <= 0;
  $('#redo').disabled = state.at >= state.history.length - 1;
  $('#download').disabled = !bytes;
  renderSteps();
  if (!bytes) return;
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  $('#preview').src = state.url + '#view=Fit';
  const d = await describe(bytes);
  const [w, h] = d.sizes[0] ?? [0, 0];
  const same = d.sizes.every(([a, b]) => Math.abs(a - w) < 0.5 && Math.abs(b - h) < 0.5);
  $('#info').textContent = `${state.name} · ${d.pages} page${d.pages === 1 ? '' : 's'} · ${Math.round(w)} × ${Math.round(h)} mm${same ? '' : ' (mixed sizes)'}`;
}

async function openFile(file) {
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await describe(bytes); // throws if it is not a readable PDF
    await setDoc(bytes, null, file.name);
    say(`Opened ${file.name}. Pick a tool on the left.`);
  } catch (e) { say(`Couldn't open that file: ${e.message}`, true); }
}

function download() {
  const a = el('a', { href: state.url, download: state.name.replace(/\.pdf$/i, '') + '-imposed.pdf' });
  document.body.append(a); a.click(); a.remove();
}

function say(msg, bad = false) {
  const s = $('#status');
  s.textContent = msg;
  s.className = bad ? 'bad' : 'ok';
}

// ---------- tools list ----------

function renderTools() {
  const nav = $('#tools');
  nav.replaceChildren();
  const groups = {};
  for (const [id, c] of Object.entries(COMMANDS)) (groups[c.group] ??= []).push([id, c]);
  for (const [g, list] of Object.entries(groups)) {
    nav.append(el('h2', { textContent: g }));
    for (const [id, c] of list) {
      nav.append(el('button', {
        textContent: c.title, className: id === state.cmd ? 'tool on' : 'tool',
        onclick: () => { state.cmd = id; renderTools(); renderForm(); say(''); },
      }));
    }
  }
}

// ---------- settings form ----------

function optsFor(cmd) {
  return (state.opts[cmd] ??= { ...defaults(cmd), ...store.get('opts:' + cmd, {}) });
}

function renderForm() {
  const c = COMMANDS[state.cmd], o = optsFor(state.cmd);
  const form = $('#form');
  form.replaceChildren(el('h1', { textContent: c.title }), el('p', { className: 'help', textContent: c.help }));
  const rows = [];
  const sync = () => {
    rows.forEach(([f, row]) => { row.hidden = f.showIf ? !f.showIf(o) : false; });
    store.set('opts:' + state.cmd, Object.fromEntries(Object.entries(o).filter(([, v]) => !(v instanceof Uint8Array))));
  };
  for (const f of c.fields) {
    let input;
    const set = (v) => { o[f.key] = v; sync(); };
    if (f.type === 'select') {
      input = el('select', { onchange: (e) => set(e.target.value) }, ...f.options.map((x) => el('option', { textContent: x, selected: o[f.key] === x })));
    } else if (f.type === 'checkbox') {
      input = el('input', { type: 'checkbox', checked: !!o[f.key], onchange: (e) => set(e.target.checked) });
    } else if (f.type === 'textarea') {
      input = el('textarea', { value: o[f.key] ?? '', rows: 5, oninput: (e) => set(e.target.value) });
    } else if (f.type === 'file') {
      const label = el('span', { className: 'filename', textContent: o[f.key] ? o[f.key + 'Name'] : 'No file chosen' });
      const pick = el('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true, onchange: async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        o[f.key] = new Uint8Array(await file.arrayBuffer()); o[f.key + 'Name'] = file.name;
        label.textContent = file.name;
      } });
      input = el('span', { className: 'filepick' }, el('button', { type: 'button', textContent: 'Choose PDF…', onclick: () => pick.click() }), label, pick);
    } else {
      input = el('input', {
        type: f.type === 'number' ? 'number' : f.type === 'color' ? 'color' : 'text', value: o[f.key] ?? '', step: 'any',
        oninput: (e) => set(f.type === 'number' ? (e.target.value === '' ? 0 : Number(e.target.value)) : e.target.value),
      });
    }
    const row = el('label', { className: 'row ' + f.type },
      el('span', { className: 'name', textContent: f.label }),
      el('span', { className: 'ctl' }, input, f.unit ? el('span', { className: 'unit', textContent: f.unit }) : null),
      f.hint ? el('small', { textContent: f.hint }) : null);
    rows.push([f, row]);
    form.append(row);
  }
  sync();
  form.append(el('button', { id: 'apply', type: 'button', className: 'primary', textContent: `Apply ${c.title}`, onclick: () => apply(state.cmd, { ...o }) }));
  if (!c.needsNoDoc) form.append(el('p', { className: 'needdoc', textContent: 'Open a PDF first (or create a sample document under Tools).' }));
}

async function apply(cmd, opts, quiet = false) {
  if (state.busy) return false;
  const c = COMMANDS[cmd];
  if (!current() && !c.needsNoDoc) { say('Open a PDF first.', true); return false; }
  state.busy = true; document.body.classList.add('busy');
  if (!quiet) say(`Working on ${c.title}…`);
  try {
    const out = await run(cmd, current(), opts, ctx());
    await setDoc(out, { cmd, opts }, c.needsNoDoc ? 'sample.pdf' : null);
    if (!quiet) say(`Done: ${c.title}. Not right? Press Undo.`);
    return true;
  } catch (e) {
    say(`${c.title} didn't work: ${e.message}`, true);
    return false;
  } finally { state.busy = false; document.body.classList.remove('busy'); }
}

// ---------- steps + saved sequences ----------

const stepsDone = () => state.history.slice(1, state.at + 1).map((h) => h.step).filter(Boolean);
const reusable = (s) => !Object.values(s.opts).some((v) => v instanceof Uint8Array) && !COMMANDS[s.cmd].needsNoDoc;

function renderSteps() {
  const box = $('#steps');
  const steps = stepsDone();
  box.replaceChildren(el('h2', { textContent: 'Steps so far' }));
  if (!steps.length) box.append(el('p', { className: 'muted', textContent: 'Nothing yet.' }));
  else {
    box.append(el('ol', {}, ...steps.map((s) => el('li', { textContent: COMMANDS[s.cmd].title }))));
    box.append(el('button', { type: 'button', textContent: 'Save steps as a sequence…', onclick: saveSequence }));
  }
  const seqs = store.get('sequences', {});
  box.append(el('h2', { textContent: 'Saved sequences' }));
  if (!Object.keys(seqs).length) box.append(el('p', { className: 'muted', textContent: 'Save your steps once, replay them on the next file with one click.' }));
  for (const [name, list] of Object.entries(seqs)) {
    box.append(el('div', { className: 'seq' },
      el('button', { type: 'button', textContent: `▶ ${name}`, title: list.map((s) => COMMANDS[s.cmd]?.title).join(' → '), onclick: () => runSequence(name, list) }),
      el('button', { type: 'button', className: 'x', textContent: '✕', title: 'Delete sequence', onclick: () => {
        if (!confirm(`Delete the sequence "${name}"?`)) return;
        const all = store.get('sequences', {}); delete all[name]; store.set('sequences', all); renderSteps();
      } })));
  }
}

function saveSequence() {
  const steps = stepsDone();
  const ok = steps.filter(reusable);
  const name = prompt(ok.length < steps.length
    ? 'Steps that used another PDF or created a sample can\'t be replayed and will be left out.\n\nName for this sequence:'
    : 'Name for this sequence:');
  if (!name || !ok.length) return;
  store.set('sequences', { ...store.get('sequences', {}), [name.trim()]: ok });
  renderSteps();
  say(`Saved sequence "${name.trim()}".`);
}

async function runSequence(name, list) {
  if (!current()) return say('Open a PDF first.', true);
  for (const s of list) {
    if (!COMMANDS[s.cmd]) return say(`Sequence "${name}" has a step this version doesn't know.`, true);
    if (!(await apply(s.cmd, s.opts, true))) return;
  }
  say(`Ran "${name}" (${list.length} step${list.length === 1 ? '' : 's'}).`);
}

// ---------- wiring ----------

$('#open').onclick = () => $('#file').click();
$('#file').onchange = (e) => { openFile(e.target.files[0]); e.target.value = ''; };
$('#undo').onclick = () => { if (state.at > 0) { state.at--; refresh(); say('Undone.'); } };
$('#redo').onclick = () => { if (state.at < state.history.length - 1) { state.at++; refresh(); say('Redone.'); } };
$('#download').onclick = download;
$('#drop').onclick = () => $('#file').click();
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
addEventListener('dragleave', () => document.body.classList.remove('drag'));
addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drag'); openFile(e.dataTransfer.files[0]); });
addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === 'z') { e.preventDefault(); (e.shiftKey ? $('#redo') : $('#undo')).click(); }
});

renderTools(); renderForm(); refresh();
window.imposer = { state, apply }; // handy for automated checks
