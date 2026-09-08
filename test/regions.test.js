import { test, expect } from 'bun:test';
import vm from 'node:vm';
import fs from 'fs';

const ctx = vm.createContext({ globalThis: {}, Object, Set, JSON, String, Array });
vm.runInContext(fs.readFileSync('src/regions.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('src/matcher.js', 'utf8'), ctx);
const R = ctx.TBR.regions;
const M = ctx.TBR.matcher;

const settings = (blocked, policy = {}) => ({
  blocked,
  policy: { ambiguous: 'allow', unmapped: 'allow', unknown: 'allow', ...policy }
});
const rec = (raw) => ({ target: R.parseLocation(raw), raw });
const act = (raw, s) => M.evaluate(rec(raw), s).action;

test('parses the plain country cases', () => {
  expect(R.parseLocation('Germany')).toBe('DE');
  expect(R.parseLocation('Based in Germany')).toBe('DE');
  expect(R.parseLocation('  united states of america ')).toBe('US');
  expect(R.parseLocation('Türkiye')).toBe('TR');
  expect(R.parseLocation('Côte d’Ivoire')).toBe('CI');
  expect(R.parseLocation('Berlin, Germany')).toBe('DE');
  expect(R.parseLocation('US')).toBe('US');
});

test('parses subregions and blocs, which is what X usually gives', () => {
  expect(R.parseLocation('Eastern Europe')).toBe('sub:europe/eastern');
  expect(R.parseLocation('Southeast Asia')).toBe('sub:asia/south-eastern');
  expect(R.parseLocation('the European Union')).toBe('grp:eu');
  expect(R.parseLocation('Middle East')).toBe('grp:middle-east');
  expect(R.parseLocation('Sub-Saharan Africa')).toBe('grp:sub-saharan-africa');
  expect(R.parseLocation('Europe')).toBe('cont:europe');
});

test('keeps a location it cannot map instead of dropping it', () => {
  expect(R.parseLocation('Some Future Bloc')).toBe('label:some future bloc');
  expect(R.parseLocation('Location unavailable')).toBe('unavailable');
  expect(R.parseLocation('')).toBe(null);
});

test('a country inside a blocked region is blocked', () => {
  expect(act('Russia', settings(['sub:europe/eastern']))).toBe('block');
  expect(act('Germany', settings(['cont:europe']))).toBe('block');
  expect(act('France', settings(['grp:eu']))).toBe('block');
});

test('a region fully covered by the blocklist is blocked', () => {
  const all = R.SUB_CODES['europe/eastern'];
  expect(act('Eastern Europe', settings(all))).toBe('block');
  expect(act('European Union', settings(['cont:europe']))).toBe('block');
});

test('a region that only overlaps the blocklist is the ambiguous case', () => {
  const s = settings(['RU']);
  expect(act('Eastern Europe', s)).toBe('allow');
  expect(act('Eastern Europe', settings(['RU'], { ambiguous: 'block' }))).toBe('block');
  expect(act('Eastern Europe', settings(['RU'], { ambiguous: 'flag' }))).toBe('flag');
  expect(M.evaluate(rec('Eastern Europe'), s).why).toContain('1 of 10');
});

test('a disjoint region is simply allowed', () => {
  expect(act('Western Europe', settings(['RU'], { ambiguous: 'block' }))).toBe('allow');
  expect(act('Japan', settings(['cont:europe'], { ambiguous: 'block' }))).toBe('allow');
});

test('unmapped and undisclosed locations have their own policies', () => {
  expect(act('Narnia', settings(['RU']))).toBe('allow');
  expect(act('Narnia', settings(['RU'], { unmapped: 'block' }))).toBe('block');
  expect(act('Narnia', settings(['label:narnia']))).toBe('block');
  expect(act('Location unavailable', settings(['RU'], { unknown: 'block' }))).toBe('block');
  expect(M.evaluate(null, settings(['RU'], { unknown: 'flag' })).action).toBe('flag');
});

test('every country belongs to exactly one subregion', () => {
  const codes = R.countryCodes();
  expect(codes.length).toBeGreaterThan(240);
  for (const c of codes) {
    expect(typeof R.COUNTRY_SUB[c]).toBe('string');
    expect(R.SUB_CODES[R.COUNTRY_SUB[c]]).toContain(c);
  }
});

test('every group and subregion resolves to real countries', () => {
  for (const k of Object.keys(R.GROUPS)) {
    const codes = R.codesFor('grp:' + k);
    expect(codes.length).toBeGreaterThan(1);
    for (const c of codes) expect(R.COUNTRY_NAME[c]).toBeTruthy();
  }
  for (const k of Object.keys(R.SUBREGIONS)) {
    expect(R.codesFor('sub:' + k).length).toBeGreaterThan(0);
  }
});

test('every label round-trips back to the same target', () => {
  for (const k of Object.keys(R.GROUPS)) {
    expect(R.parseLocation(R.labelFor('grp:' + k))).toBe('grp:' + k);
  }
  for (const c of R.countryCodes()) {
    expect(R.parseLocation(R.labelFor(c))).toBe(c);
  }
  // A handful of names are both a country and a region ("Antarctica",
  // "Micronesia"). Those read back as the country, which the region still
  // contains, so a block on the region keeps covering them.
  for (const k of Object.keys(R.SUBREGIONS)) {
    const back = R.parseLocation(R.labelFor('sub:' + k));
    const inside = R.codesFor('sub:' + k);
    const got = R.codesFor(back);
    expect(got.length).toBeGreaterThan(0);
    for (const c of got) expect(inside).toContain(c);
  }
});
