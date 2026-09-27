// js/core/storage.js: the save file. There is no account and no server in this game, so this
// little JSON blob *is* the player's progress, and the two rules that make it trustworthy are
// monotonic ones: a replay must never erase a better result, and finishing a puzzle must never
// lock something away. Both are asserted here against a fake `window.localStorage`, and both
// are asserted again with `window` absent, because the node test process — and a private
// browser window — is exactly the case where the module has to keep working without a disk.
//
// The store is a module-level cache, so every case starts by calling `_forget()`. That call is
// also what keeps `_forget` from being a ghost export: without it this file would be testing a
// stale cache and would pass for the wrong reason.

import { test, ok, eq, run } from '../tools/harness.mjs';
import * as save from '../js/core/storage.js';

// A localStorage stand-in with the same throwing behaviour the real one has in private mode.
function fakeStore(fail = null) {
  const map = new Map();
  return {
    map,
    getItem: (k) => (fail && fail.get ? (() => { throw new Error('denied'); })() : (map.has(k) ? map.get(k) : null)),
    setItem: (k, v) => {
      if (fail && fail.set) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
  };
}

function withWindow(store) {
  if (store) globalThis.window = { localStorage: store };
  else delete globalThis.window;
  save._forget();
}

function raw(store) {
  return store.map.get(save.key());
}

test('storage: without a window nothing is thrown and nothing is claimed', () => {
  withWindow(null);
  eq(typeof save.load(), 'object');
  eq(save.snapshot().records, {}, 'a machine with no storage should start empty');
  eq(save.unlocked(), 1);
  eq(save.stats().solves, 0);
  eq(save.recordFor('nope'), null);
  eq(save.solvedIds().size, 0);
  // Writes still work for the session — the game must remain playable — but the module has to
  // admit afterwards that it is not reaching a disk.
  const r = save.solve('lot-1', { moves: 2, hints: 0, par: 2 });
  eq(r.ok, true, 'a session with no storage refused to record a solve');
  eq(save.recordFor('lot-1').best.moves, 2, 'the in-memory record disappeared');
  eq(save.isVolatile(), true, 'a write with no window must be reported as volatile');
  save.markDaily('2026-09-20', 'lot-1');
  eq(save.dailyOf('2026-09-20'), 'lot-1');
  eq(save.dailyOf('2026-09-21'), null, 'a day nobody played came back as someone else\'s puzzle');
});

test('storage: a throwing localStorage degrades the same way', () => {
  const hostile = fakeStore({ set: true });
  withWindow(hostile);
  eq(save.isVolatile(), false, 'a store that has never been written to is not yet known-broken');
  const r = save.solve('lot-2', { moves: 3, hints: 1, par: 3 });
  eq(r.ok, true, 'the shell may not lose a solve just because the browser said no');
  eq(save.isVolatile(), true, 'a rejected write has to be visible to the UI');
  eq(hostile.map.has(save.key()), false, 'a rejected write still landed on the store');
  eq(save.recordFor('lot-2').best.moves, 3);
});

test('storage: a real window round-trips through one key of plain JSON', () => {
  const store = fakeStore();
  withWindow(store);
  save.solve('lot-3', { moves: 1, hints: 0, par: 1 });
  save.unlockTo(4);
  const text = raw(store);
  ok(typeof text === 'string' && text.length > 0, 'nothing was written to the store');
  eq(text.startsWith('{'), true, 'the save is not plain JSON');
  const parsed = JSON.parse(text);
  eq(parsed.version, 1);
  eq(parsed.records['lot-3'].best, { moves: 1, hints: 0 });
  eq(parsed.unlocked, 4);
  eq(Object.keys(parsed).sort(), ['daily', 'records', 'stats', 'unlocked', 'version'],
    'the save grew a field nobody asked for');
  // The module cache and the disk are two different things: forget the cache and the data has
  // to come back out of the store, byte for byte.
  save._forget();
  eq(save.recordFor('lot-3').best.moves, 1, '_forget did not reload from the store');
  eq(save.unlocked(), 4);
  // `snapshot` is a copy, so a UI bug cannot write through it.
  const snap = save.snapshot();
  snap.records['lot-3'].best.moves = 99;
  snap.unlocked = 99;
  eq(save.recordFor('lot-3').best.moves, 1, 'snapshot handed out the live object');
  eq(save.unlocked(), 4);
});

test('storage: best only ever goes down, and a tie is broken by hints', () => {
  const store = fakeStore();
  withWindow(store);
  const one = save.solve('lot-4', { moves: 5, hints: 2, par: 3 });
  eq(one.ok, true);
  eq(one.improved, true, 'the first record must count as an improvement');
  eq(save.recordFor('lot-4').best, { moves: 5, hints: 2 });

  // Worse replay: the *latest* attempt is what the panel shows, the *best* is what is kept.
  const worse = save.solve('lot-4', { moves: 7, hints: 4, par: 3 });
  eq(worse.improved, false, 'a worse replay was called an improvement');
  eq(save.recordFor('lot-4').best, { moves: 5, hints: 2 }, 'a worse replay overwrote a better best');
  eq(save.recordFor('lot-4').moves, 7, 'the latest attempt was not recorded');

  // Same moves, fewer hints: better. Same moves, same hints: not an improvement, and the
  // stored hint count must not drift upward.
  eq(save.solve('lot-4', { moves: 5, hints: 0, par: 3 }).improved, true, 'fewer hints at par was not an improvement');
  eq(save.recordFor('lot-4').best, { moves: 5, hints: 0 });
  eq(save.solve('lot-4', { moves: 5, hints: 0, par: 3 }).improved, false);
  eq(save.recordFor('lot-4').best, { moves: 5, hints: 0 });

  // Better moves: improves, and can never be undone by the worse runs that follow.
  eq(save.solve('lot-4', { moves: 3, hints: 1, par: 3 }).improved, true);
  save.solve('lot-4', { moves: 9, hints: 9, par: 3 });
  eq(save.recordFor('lot-4').best, { moves: 3, hints: 1 }, 'best moved backwards');
  eq(JSON.parse(raw(store)).records['lot-4'].best, { moves: 3, hints: 1 }, 'the disk disagrees with the cache');
});

test('storage: unlock only ever goes up', () => {
  withWindow(fakeStore());
  eq(save.unlocked(), 1);
  eq(save.unlockTo(3), 3);
  eq(save.unlocked(), 3);
  eq(save.unlockTo(2), 3, 'unlockTo went backwards');
  eq(save.unlockTo(1), 3, 'replaying the first lot locked the later ones away');
  eq(save.unlockTo(3), 3);
  eq(save.unlockTo(10), 10);
  eq(save.unlockTo(0), 10, 'a zero unlocked count would empty the campaign');
  eq(save.unlockTo(-5), 10, 'a negative unlocked count would empty the campaign');
  eq(save.unlockTo(NaN), 10, 'NaN leaked into the unlock counter');
  eq(save.unlockTo(undefined), 10, 'an omitted argument reset the campaign');
  eq(save.unlockTo('7'), 10, 'a non-numeric argument changed the state');
  eq(save.unlockTo(10.9), 10, 'a fractional unlock should floor, not raise past it');
  eq(save.unlockTo(11), 11, 'a whole-number increase did not take');
});

test('storage: wipe really wipes', () => {
  const store = fakeStore();
  withWindow(store);
  save.solve('lot-5', { moves: 1, hints: 0, par: 1 });
  save.solve('lot-6', { moves: 2, hints: 3, par: 2 });
  save.unlockTo(9);
  save.markDaily('2026-09-20', 'lot-6');
  save.bump('drags', 4);
  const before = save.snapshot();
  ok(Object.keys(before.records).length === 2, 'precondition: there is something to wipe');
  eq(before.unlocked, 9);
  eq(before.stats.drags, 4);
  eq(before.daily['2026-09-20'], 'lot-6');

  const after = save.reset();
  eq(after.records, {}, 'reset left records behind');
  eq(after.daily, {}, 'reset left the daily marks behind');
  eq(after.unlocked, 1, 'reset did not reopen the campaign at lot 1');
  eq(after.stats, { solves: 0, perfect: 0, moves: 0, drags: 0, refused: 0, hints: 0 }, 'reset left counters');
  eq(save.recordFor('lot-5'), null);
  eq(save.solvedIds().size, 0);
  eq(save.unlocked(), 1);
  eq(save.dailyOf('2026-09-20'), null);
  // Wiped means wiped *on disk*: a reload of the cache must not resurrect the old blob.
  eq(JSON.parse(raw(store)).records, {}, 'reset only cleared the cache');
  save._forget();
  eq(save.snapshot().records, {}, 'the old save came back from the store after a wipe');
});

test('storage: solvedIds is the set the panel counts on', () => {
  withWindow(fakeStore());
  eq(save.solvedIds() instanceof Set, true);
  save.solve('a1', { moves: 1, hints: 0, par: 1 });
  save.solve('a2', { moves: 2, hints: 0, par: 2 });
  save.solve('a2', { moves: 3, hints: 0, par: 2 });
  eq([...save.solvedIds()].sort(), ['a1', 'a2'], 'a replayed lot was counted twice');
  // A solve attempt that was refused must not appear either.
  save.solve('a3', { moves: 0, hints: 0, par: 1 });
  eq(save.solvedIds().has('a3'), false, 'a refused record still marked the lot solved');
  // `solves` counts completions, replays included — it is the "完成次数" line, not the number of
  // distinct lots finished, which is what `solvedIds` above answers.
  eq(save.stats().solves, 3, 'the solve counter accepted a refused record');
});

test('storage: bad records are refused, not stored as zeroes', () => {
  withWindow(fakeStore());
  const before = save.stats();
  for (const args of [{ moves: 0 }, { moves: -3 }, { moves: NaN }, { moves: 'two' }, {}]) {
    const r = save.solve('x', args);
    eq(r.ok, false, `solve('x', ${JSON.stringify(args)}) claimed to record something`);
    eq(r.reason, 'bad-record');
  }
  const noid = save.solve(undefined, { moves: 2 });
  eq(noid.ok, false);
  eq(noid.reason, 'bad-record');
  eq(save.recordFor('x'), null, 'a refused record was stored anyway');
  eq(save.stats(), before, 'a refused record moved the counters');
  // A fractional move count is not something a player can earn. It is kept (the field is a
  // number, and refusing it would lose the solve), but the read-back shape check floors it, so
  // the panel can never print a fractional score.
  eq(save.solve('x', { moves: 2.7, hints: 0.2, par: 3 }).ok, true);
  eq(save.recordFor('x').best.moves, 2.7, 'the live cache rewrote the record it was handed');
  save._forget();
  eq(save.recordFor('x').best, { moves: 2, hints: 0 }, 'the shape check did not floor the fractional counters');
});

test('storage: the perfect counter is the strict one', () => {
  withWindow(fakeStore());
  const perfect = () => save.stats().perfect;
  save.solve('p1', { moves: 2, hints: 0, par: 2 });
  eq(perfect(), 1, 'a par run with no hints is not perfect');
  save.solve('p2', { moves: 2, hints: 1, par: 2 });
  eq(perfect(), 1, 'a hinted run was called perfect');
  save.solve('p3', { moves: 3, hints: 0, par: 2 });
  eq(perfect(), 1, 'a longer-than-par run was called perfect');
  save.solve('p4', { moves: 1, hints: 0, par: 2 });
  eq(perfect(), 2, 'under par with no hints has to count as perfect');
  // An unsolvable lot has no par to beat, so it must never add to the perfect tally.
  save.solve('p5', { moves: 4, hints: 0, par: null, solvable: false });
  eq(perfect(), 2, 'an unsolvable lot was scored perfect');
  save.solve('p6', { moves: 4, hints: 0 });
  eq(perfect(), 2, 'a record with no par at all was scored perfect');
  eq(save.stats().moves, 2 + 2 + 3 + 1 + 4 + 4, 'the total move counter is not the sum of attempts');
});

test('storage: bump adds, and a poisoned delta cannot survive a reload', () => {
  withWindow(fakeStore());
  eq(save.bump('refused'), 1);
  eq(save.bump('refused', 4), 5);
  eq(save.stats().refused, 5);
  eq(save.bump('unknown-counter'), 1, 'an unknown counter name was dropped on the floor');
  eq(save.stats().unknownCounter === undefined, true, 'the stats object was read through a camelCase alias');
  save.bump('solves', NaN);
  save.bump('hints', -5);
  const live = save.stats();
  ok(!Number.isFinite(live.solves) || live.solves === 0, `NaN reached a printed counter: ${live.solves}`);
  ok(live.hints <= 0, `a negative bump raised the hint counter to ${live.hints}`);
  // The poisoned values are in the live cache; what matters is that a reload cannot keep them,
  // because `sanitize` zeroes every non-finite counter — otherwise one bad `bump` would put a
  // `NaN` on the panel for the rest of the install's life.
  save._forget();
  const reloaded = save.stats();
  eq(Number.isFinite(reloaded.solves), true, 'NaN survived the reload');
  eq(Number.isFinite(reloaded.hints), true, 'a broken hint counter survived the reload');
});

test('storage: a corrupt, edited or future save comes back as defaults', () => {
  const store = fakeStore();
  withWindow(store);
  const readAs = (text) => {
    store.map.set(save.key(), text);
    save._forget();
    return save.snapshot();
  };
  for (const junk of ['', 'null', 'undefined', '[]', '{}', '"a string"', '42', '{not json']) {
    const s = readAs(junk);
    eq(s.version, 1, `${junk} was not rebuilt at version 1`);
    eq(s.unlocked, 1, `${junk} unlocked something`);
    eq(s.records, {}, `${junk} carried records`);
    eq(s.stats.solves, 0, `${junk} carried a solve counter`);
  }
  // Half-shaped but plausible: the sanitizer keeps what it can read and drops the rest, so a
  // player with one hand-edited field does not lose the whole file.
  const edited = readAs(JSON.stringify({
    version: 99,
    unlocked: 'lots',
    records: { good: { moves: 3, hints: 1, best: { moves: 3, hints: 1 } }, broken: null, alsoBroken: 7 },
    daily: { '2026-09-20': 'good', '20-09-2026': 'good', 'nope': 'good' },
    stats: { solves: 'many', drags: -4, perfect: 2 },
  }));
  eq(edited.version, 1, 'a future version was passed through as if it were understood');
  eq(edited.unlocked, 1, 'a non-numeric unlock count was trusted');
  eq(Object.keys(edited.records), ['good'], 'junk records survived the shape check');
  eq(edited.records.good.best, { moves: 3, hints: 1 });
  eq(edited.daily, { '2026-09-20': 'good' }, 'a malformed day key survived');
  eq(edited.stats.solves, 0, 'a non-numeric counter survived');
  eq(edited.stats.drags, 0, 'a negative counter survived');
  eq(edited.stats.perfect, 2, 'a readable counter was thrown away with the unreadable ones');
  // And the rebuilt file is what gets written next, so a corrupt save cannot linger.
  save.bump('refused');
  const rewritten = JSON.parse(raw(store));
  eq(rewritten.version, 1);
  eq(rewritten.daily, { '2026-09-20': 'good' });
  eq(rewritten.unlocked, 1);
});

test('storage: the daily ledger is per day and per lot id', () => {
  withWindow(fakeStore());
  eq(save.dailyOf('2026-09-20'), null);
  eq(save.markDaily('2026-09-20', 'lot-7'), 'lot-7');
  eq(save.dailyOf('2026-09-20'), 'lot-7');
  save.markDaily('2026-09-21', 'lot-8');
  eq(save.dailyOf('2026-09-20'), 'lot-7', 'yesterday\'s puzzle was overwritten by today\'s');
  eq(Object.keys(save.snapshot().daily).length, 2);
  // Re-marking the same day replaces it: the day rolls over at midnight and the new board wins.
  save.markDaily('2026-09-20', 'lot-9');
  eq(save.dailyOf('2026-09-20'), 'lot-9');
  const store = fakeStore();
  withWindow(store);
  save.markDaily('2026-09-20', 'lot-7');
  eq(JSON.parse(raw(store)).daily['2026-09-20'], 'lot-7', 'the daily mark never reached disk');
});

test('storage: one key, one version, no second store anywhere', () => {
  const store = fakeStore();
  withWindow(store);
  save.solve('lot-1', { moves: 1, hints: 0, par: 1 });
  save.unlockTo(2);
  save.markDaily('2026-09-20', 'lot-1');
  save.bump('drags', 3);
  eq([...store.map.keys()], [save.key()], 'the save spread over more than one key');
  eq(save.key(), 'matchwork.save.v1', 'the key changed name without a version bump');
  // The record timestamp is wall-clock, so it is the one field this suite does not pin — but it
  // must be a sane number, because the panel prints "最近完成" from it.
  const at = save.recordFor('lot-1').at;
  ok(Number.isFinite(at) && at > 1e12 && at <= Date.now(), `the record timestamp is ${new Date(at).toISOString()}`);
});

test('storage: the module exposes nothing the shell does not call', () => {
  const exported = Object.keys(save).sort();
  eq(exported, ['_forget', 'bump', 'dailyOf', 'isVolatile', 'key', 'load', 'markDaily', 'recordFor',
    'reset', 'solve', 'solvedIds', 'snapshot', 'stats', 'unlockTo', 'unlocked'].sort(),
    `the save module exports ${JSON.stringify(exported)}`);
});

run();
