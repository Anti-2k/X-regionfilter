/* Drives the real settings page: ticking a box must not collapse the tree. */
import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import vm from 'node:vm';
import fs from 'fs';

const SRC = ['src/regions.js', 'src/settings.js', 'src/matcher.js', 'ui/options.js']
  .map((f) => fs.readFileSync(f, 'utf8'));

const BODY = fs.readFileSync('ui/options.html', 'utf8')
  .replace(/[\s\S]*<body[^>]*>/, '')
  .replace(/<\/body>[\s\S]*/, '')
  .replace(/<script[\s\S]*?<\/script>/g, '');

async function openOptions(settings = {}) {
  const w = new Window({ url: 'moz-extension://test/ui/options.html' });
  w.console = console;
  for (const k of ['Object', 'Array', 'JSON', 'Promise', 'Set', 'Map', 'WeakMap',
    'String', 'Number', 'Boolean', 'Math', 'Date', 'RegExp', 'Error', 'TypeError',
    'Symbol', 'Function', 'parseInt', 'parseFloat', 'isNaN', 'Blob', 'URL']) {
    if (w[k] === undefined) w[k] = globalThis[k];
  }

  const store = { settings: { enabled: true, blocked: [], ...settings } };
  w.browser = {
    storage: {
      local: {
        get: (k) => Promise.resolve(k ? { [k]: store[k] } : store),
        set: (o) => { Object.assign(store, o); return Promise.resolve(); }
      },
      onChanged: { addListener() {} }
    },
    runtime: {
      sendMessage: (m) => Promise.resolve(m.type === 'cacheStats' ? { size: 0, byTarget: {} } : {}),
      openOptionsPage() {}
    },
    tabs: { query: () => Promise.resolve([]) }
  };

  w.document.body.innerHTML = BODY;
  const ctx = vm.createContext(w);
  for (const code of SRC) vm.runInContext(code, ctx);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 60));

  const d = w.document;
  return {
    w, store, d,
    label: (t) => d.querySelector(`label[data-target="${CSS_ESC(t)}"]`),
    box: (t) => d.querySelector(`label[data-target="${CSS_ESC(t)}"] input`),
    details: (t) => d.querySelector(`label[data-target="${CSS_ESC(t)}"]`).closest('details'),
    click(t) {
      const cb = this.box(t);
      cb.checked = !cb.checked;
      cb.dispatchEvent(new w.Event('change'));
    },
    close: () => w.happyDOM.close()
  };
}
const CSS_ESC = (s) => s;

test('ticking a country leaves the subregion expanded', async () => {
  const o = await openOptions();
  const details = o.details('RU');
  details.open = true;
  const parent = details.parentElement.closest('details');
  parent.open = true;

  o.click('RU');
  await new Promise((r) => setTimeout(r, 30));

  expect(details.open).toBe(true);
  expect(parent.open).toBe(true);
  // and the same DOM node is still there, not a rebuilt copy
  expect(o.details('RU')).toBe(details);
  expect(o.box('RU').checked).toBe(true);
  o.close();
});

test('the selection actually persists', async () => {
  const o = await openOptions();
  o.click('RU');
  await new Promise((r) => setTimeout(r, 250));
  expect(o.store.settings.blocked).toContain('RU');
  o.close();
});

test('ticking a subregion greys out the countries it covers', async () => {
  const o = await openOptions();
  o.click('sub:europe/eastern');
  await new Promise((r) => setTimeout(r, 30));

  const ru = o.box('RU');
  expect(ru.checked).toBe(true);
  expect(ru.disabled).toBe(true);
  expect(o.label('RU').classList.contains('implied')).toBe(true);
  expect(o.label('RU').querySelector('.lock').textContent).toContain('Eastern Europe');

  // a country outside it is untouched
  expect(o.box('DE').checked).toBe(false);
  expect(o.box('DE').disabled).toBe(false);
  o.close();
});

test('unticking the subregion restores the countries', async () => {
  const o = await openOptions();
  o.click('sub:europe/eastern');
  await new Promise((r) => setTimeout(r, 20));
  o.click('sub:europe/eastern');
  await new Promise((r) => setTimeout(r, 20));
  expect(o.box('RU').checked).toBe(false);
  expect(o.box('RU').disabled).toBe(false);
  expect(o.label('RU').querySelector('.lock').textContent).toBe('');
  o.close();
});

test('chips track the selection', async () => {
  const o = await openOptions();
  o.click('RU');
  o.click('grp:eu');
  await new Promise((r) => setTimeout(r, 30));
  const chips = o.d.querySelectorAll('#chips .chip');
  expect(chips.length).toBe(2);
  expect(o.d.getElementById('selCount').textContent).toBe('2');
  o.close();
});

test('clearing the search restores what was expanded before it', async () => {
  const o = await openOptions();
  const open = o.details('RU');
  open.open = true;
  const shut = o.details('JP');
  shut.open = false;

  const search = o.d.getElementById('search');
  search.value = 'japan';
  search.dispatchEvent(new o.w.Event('input'));
  await new Promise((r) => setTimeout(r, 20));
  expect(shut.open).toBe(true);          // search opens what matches

  search.value = '';
  search.dispatchEvent(new o.w.Event('input'));
  await new Promise((r) => setTimeout(r, 20));
  expect(open.open).toBe(true);          // and puts it all back
  expect(shut.open).toBe(false);
  o.close();
});
