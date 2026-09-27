// Save file. One localStorage key, plain JSON, a versioned shape so an old save is
// recognised rather than mistaken for a new one, and no network anywhere.
//
// What is worth recording in a game whose puzzles are *proved*: which lots you finished,
// in how many moves, with how many hints, and how far the campaign opened up. Nothing else
// — no streaks, no scores to compare with anyone.
//
// Two monotonic rules, both asserted in test/storage.test.mjs:
//   * `best.moves` only ever goes **down** (a worse replay must not overwrite a better one);
//   * `unlocked` only ever goes **up** (finishing lot 3 again must not lock lot 9 away).
//
// Everything degrades to a module-local object when there is no `window` (node --test) or
// when localStorage throws (private windows, sandboxed origins). The game then still works
// for the session; it just forgets afterwards, and says so.

const KEY = 'matchwork.save.v1';

function blank() {
  return {
    version: 1,
    records: {},
    daily: {},
    unlocked: 1,
    stats: { solves: 0, perfect: 0, moves: 0, drags: 0, refused: 0, hints: 0 },
  };
}

let cache = null;
let volatile = false; // true when nothing can be written to disk

function readRaw() {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch (err) {
    return null;
  }
}

function writeRaw(text) {
  if (typeof window === 'undefined' || !window.localStorage) { volatile = true; return false; }
  try {
    window.localStorage.setItem(KEY, text);
    return true;
  } catch (err) {
    volatile = true;
    return false;
  }
}

// Shape-check, not trust: a save from a future build, a hand-edited one, or a half-written
// one all come back as defaults instead of crashing the shell.
function sanitize(parsed) {
  const base = blank();
  if (!parsed || typeof parsed !== 'object') return base;
  const num = (x, d) => (Number.isFinite(x) && x >= 0 ? Math.floor(x) : d);
  const out = {
    version: 1,
    records: {},
    daily: {},
    unlocked: num(parsed.unlocked, base.unlocked) || 1,
    stats: { ...base.stats, ...(parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : {}) },
  };
  if (parsed.records && typeof parsed.records === 'object') {
    for (const [id, rec] of Object.entries(parsed.records)) {
      if (!rec || typeof rec !== 'object') continue;
      out.records[id] = {
        moves: num(rec.moves, 0),
        hints: num(rec.hints, 0),
        best: { moves: num(rec.best?.moves, 0), hints: num(rec.best?.hints, 0) },
        at: num(rec.at, 0),
      };
    }
  }
  if (parsed.daily && typeof parsed.daily === 'object') {
    for (const [day, id] of Object.entries(parsed.daily)) {
      if (typeof id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) out.daily[day] = id;
    }
  }
  // Same rule `num()` applies to every other field: a counter has to be a finite, non-negative
  // number or it is not a counter. Without the sign check a hand-edited `drags: -4` came back
  // as `-4` and was printed as-is, which is the one thing a shape check exists to prevent.
  for (const k of Object.keys(out.stats)) {
    const v = out.stats[k];
    out.stats[k] = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  }
  return out;
}

export function load() {
  if (cache) return cache;
  const raw = readRaw();
  if (raw) {
    try {
      cache = sanitize(JSON.parse(raw));
      return cache;
    } catch (err) {
      // A corrupt save is not worth keeping.
    }
  }
  cache = blank();
  return cache;
}

function persist() {
  return writeRaw(JSON.stringify(cache));
}

export function key() {
  return KEY;
}

// True when saves cannot reach disk, so the shell can say "本次会话记分不落盘".
export function isVolatile() {
  load();
  return volatile;
}

export function snapshot() {
  return JSON.parse(JSON.stringify(load()));
}

export function recordFor(id) {
  return load().records[id] || null;
}

// One finished lot. `best` only improves, so this is safe to call on every replay.
export function solve(id, { moves, hints = 0, par = null, solvable = true } = {}) {
  const s = load();
  if (!id || !Number.isFinite(moves) || moves < 1) return { ok: false, reason: 'bad-record' };
  const prev = s.records[id];
  const rec = prev || { moves, hints, best: { moves, hints }, at: 0 };
  rec.moves = moves;
  rec.hints = hints;
  rec.at = Date.now();
  if (!Number.isFinite(rec.best?.moves) || rec.best.moves === 0) rec.best = { moves, hints };
  const better = moves < rec.best.moves || (moves === rec.best.moves && hints < rec.best.hints);
  // `improved` answers the question the victory line asks ("这是这一题的最好成绩?"), which is
  // "is the stored best now this run" — and a *first* completion establishes the best, so it
  // has to count. Reading this as `better` alone made the panel silent on the one occasion the
  // sentence is most true, because `rec.best` had just been seeded with these very numbers.
  const improved = !prev || better;
  if (better) rec.best = { moves, hints };
  s.records[id] = rec;
  s.stats.solves += 1;
  s.stats.moves += moves;
  s.stats.hints += hints;
  if (solvable && par !== null && moves <= par && hints === 0) s.stats.perfect += 1;
  persist();
  return { ok: true, improved, record: rec };
}

export function unlockTo(n) {
  const s = load();
  const target = Number.isFinite(n) ? Math.floor(n) : s.unlocked;
  if (target <= s.unlocked) return s.unlocked;
  s.unlocked = target;
  persist();
  return s.unlocked;
}

export function unlocked() {
  return load().unlocked;
}

export function markDaily(day, id) {
  const s = load();
  s.daily[day] = id;
  persist();
  return id;
}

export function dailyOf(day) {
  return load().daily[day] || null;
}

export function bump(kind, by = 1) {
  const s = load();
  if (!(kind in s.stats)) s.stats[kind] = 0;
  s.stats[kind] += by;
  persist();
  return s.stats[kind];
}

export function stats() {
  return { ...load().stats };
}

export function solvedIds() {
  return new Set(Object.keys(load().records));
}

export function reset() {
  cache = blank();
  volatile = false;
  persist();
  return snapshot();
}

// Test hook: forget the module cache so a case can pretend the disk is empty.
export function _forget() {
  cache = null;
  volatile = false;
}
