/* Drives the real background cache: source ranking decides what sticks. */
import { test, expect } from 'bun:test';
import vm from 'node:vm';
import fs from 'fs';

const SRC = ['src/regions.js', 'src/settings.js', 'src/background.js']
  .map((f) => fs.readFileSync(f, 'utf8'));

function background(settings = {}) {
  const store = { settings: { ...settings } };
  let onMessage = null;
  const ctx = vm.createContext({
    console,
    setTimeout, clearTimeout,
    browser: {
      storage: {
        local: {
          get: (k) => Promise.resolve(k ? { [k]: store[k] } : store),
          set: (o) => { Object.assign(store, o); return Promise.resolve(); }
        },
        onChanged: { addListener() {} }
      },
      runtime: {
        onMessage: { addListener: (f) => { onMessage = f; } },
        onInstalled: { addListener() {} }
      },
      tabs: {
        query: () => Promise.resolve([]),
        sendMessage: () => Promise.resolve(),
        onRemoved: { addListener() {} }
      },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} }
    }
  });
  for (const code of SRC) vm.runInContext(code, ctx);

  const send = (msg) => onMessage(msg, {});
  return {
    put: (items) => send({ type: 'put', items }),
    dump: () => send({ type: 'cacheDump' }).then((r) => r.cache),
    rec: (h) => send({ type: 'cacheDump' }).then((r) => r.cache[h])
  };
}

const ABOUT = (handle, raw, kind = 'country') =>
  [{ handle, raw, kind, source: 'dom-about' }];
const STORE = (handle, raw) =>
  [{ handle, raw, kind: 'country', source: 'dom-appstore' }];
const PASSIVE = (handle, raw, kind = 'country') =>
  [{ handle, raw, kind, source: 'api-passive' }];

test('the App Store fallback is cached when nothing better exists', async () => {
  const bg = background();
  await bg.put(STORE('a', 'United States'));
  expect(await bg.rec('a')).toMatchObject({ target: 'US', source: 'dom-appstore', rank: 35 });
});

test('a disclosed country displaces an App Store record', async () => {
  const bg = background();
  await bg.put(STORE('a', 'United States'));
  await bg.put(ABOUT('a', 'India'));
  expect(await bg.rec('a')).toMatchObject({ target: 'IN', source: 'dom-about' });
});

test('an App Store record never displaces a disclosed country', async () => {
  const bg = background();
  await bg.put(ABOUT('a', 'India'));
  await bg.put(STORE('a', 'United States'));
  expect(await bg.rec('a')).toMatchObject({ target: 'IN', source: 'dom-about' });
});

test('an App Store record never displaces a passive API sighting', async () => {
  const bg = background();
  await bg.put(PASSIVE('a', 'India'));
  await bg.put(STORE('a', 'United States'));
  expect(await bg.rec('a')).toMatchObject({ target: 'IN', source: 'api-passive' });
});

test('an App Store record never displaces a disclosed region', async () => {
  const bg = background();
  await bg.put(ABOUT('a', 'Southeast Asia', 'region'));
  await bg.put(STORE('a', 'United States'));
  expect(await bg.rec('a')).toMatchObject({ target: 'sub:asia/south-eastern', source: 'dom-about' });
});

test('but it does outrank a self-reported location', async () => {
  const bg = background({ sources: { selfReported: true } });
  await bg.put([{ handle: 'a', raw: 'Berlin, Germany', kind: 'self', source: 'api-passive' }]);
  expect(await bg.rec('a')).toMatchObject({ target: 'DE', kind: 'self' });
  await bg.put(STORE('a', 'United States'));
  expect(await bg.rec('a')).toMatchObject({ target: 'US', source: 'dom-appstore' });
});

test('a user override beats everything, including a disclosed country', async () => {
  const bg = background();
  await bg.put(ABOUT('a', 'India'));
  await bg.put([{ handle: 'a', raw: 'Germany', kind: 'country', source: 'override' }]);
  expect(await bg.rec('a')).toMatchObject({ target: 'DE', source: 'override' });
});

/* The bug this whole area exists to prevent: a junk string scraped out of the
 * panel becomes a label: target and then squats on the handle for the TTL. */
test('a junk scrape does not outrank a later clean sighting', async () => {
  const bg = background();
  await bg.put(ABOUT('a', 'United StatesVerifiedSince April 20241 username changeLast o'));
  expect((await bg.rec('a')).target).toMatch(/^label:/);
  await bg.put(PASSIVE('a', 'United States'));
  expect(await bg.rec('a')).toMatchObject({ target: 'US' });
});

test('self-reported locations are dropped unless enabled', async () => {
  const bg = background();
  await bg.put([{ handle: 'a', raw: 'Berlin, Germany', kind: 'self', source: 'api-passive' }]);
  expect(await bg.rec('a')).toBeUndefined();
});

test('an unmappable label never outranks a recognised place', async () => {
  const bg = background();
  await bg.put(ABOUT('a', 'The Levant Bloc'));
  expect((await bg.rec('a')).target).toBe('label:the levant bloc');
  await bg.put(PASSIVE('a', 'Serbia'));
  expect(await bg.rec('a')).toMatchObject({ target: 'RS' });
});

test('a recognised place is not displaced by a later unmappable label', async () => {
  const bg = background();
  await bg.put(ABOUT('a', 'Serbia'));
  await bg.put(PASSIVE('a', 'The Levant Bloc'));
  expect(await bg.rec('a')).toMatchObject({ target: 'RS' });
});

test('a label: override still wins, since the user chose it', async () => {
  const bg = background();
  await bg.put(ABOUT('a', 'India'));
  await bg.put([{ handle: 'a', raw: 'The Levant Bloc', kind: 'region', source: 'override' }]);
  expect((await bg.rec('a')).target).toBe('label:the levant bloc');
});
