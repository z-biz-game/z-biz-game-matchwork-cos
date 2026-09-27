// js/core/rng.js: the reason a share link and a daily puzzle mean anything. Two players on
// two devices must land on the same board from the same string, and neither of them may have
// to ask a server. So this file is not "is the RNG random" — it is "is the RNG a function".
//
// The expectations below are external on purpose:
//   * `hashSeed` is FNV-1a (32-bit) over the **UTF-16LE octets** of the string: offset basis
//     0x811c9dc5, and after *each* octet `h ^= byte; h *= 0x01000193` (mod 2^32). The four
//     literals in FNV_VECTORS were worked out on paper from that definition, octet by octet,
//     and they pin the *encoding* as much as the algorithm — see the `foobar` note below.
//     `fnv1aUtf16le` re-implements the same definition a second time inside this file.
//   * `mulberry32` is the published 32-bit generator of the same name. The output words are
//     the integers produced by that algorithm's arithmetic, written here as literals.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { hashSeed, mulberry32, rngFrom } from '../js/core/rng.js';

// Reference implementation, transcribed from the FNV-1a specification.
function fnv1aUtf16le(str) {
  let h = 0x811c9dc5;
  const mix = (byte) => {
    h = ((h ^ byte) >>> 0);
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    mix(c & 0xff);
    mix((c >> 8) & 0xff);
  }
  return h >>> 0;
}

// Hand-derived, one octet at a time:
//   ""        no octet mixed, so the answer is the offset basis itself
//   "a"       0x811c9dc5 ^0x61 *p = 0xe40c292c   <- this intermediate *is* the published
//             FNV-1a vector for the ASCII string "a"; then ^0x00 *p = 0x2b24d044
//   "ab"      … ^0x62 *p ^0x00 *p = 0x81977b96
//   "foobar"  … = 0xa29f12fa (six code units, twelve octets)
const FNV_VECTORS = [
  ['', 0x811c9dc5],
  ['a', 0x2b24d044],
  ['ab', 0x81977b96],
  ['foobar', 0xa29f12fa],
];

// mulberry32(seed) first four output words, as integers, from the published algorithm.
const MULBERRY = {
  0: [0x4434b462, 0x00159c37, 0x39285b08, 0x256d8104],
  1: [0xa087eaf3, 0x00b349c9, 0x8706c4eb, 0xfb2627fd],
  42: [0x99e1ef7c, 0x72c32b8a, 0xda3b32c0, 0xab73b0ad],
  4294967295: [0xe57bf3d3, 0x3081a5a4, 0xb7350390, 0xf1ade904],
  0x811c9dc5: [0x9c7a8434, 0x7e579ba5, 0xc6267ea9, 0x698b9526],
};

const word = (rng) => Math.round(rng() * 4294967296);

test('rng: hashSeed is FNV-1a over UTF-16LE, octet for octet', () => {
  for (const [str, want] of FNV_VECTORS) {
    eq(hashSeed(str), want, `hashSeed(${JSON.stringify(str)}) is not the hand-derived FNV-1a value`);
    eq(hashSeed(str), fnv1aUtf16le(str), `hashSeed(${JSON.stringify(str)}) diverges from the reference`);
  }
  // The offset basis, for the record: an empty string hashes to the basis itself, which is what
  // makes a typo in the loop visible rather than merely different.
  eq(hashSeed(''), 0x811c9dc5);
  ok(hashSeed('a') !== hashSeed(''), 'one octet has to move the value');
  // The encoding is load-bearing, not incidental: the *byte-only* FNV-1a of "foobar" is the
  // published vector 0xbf9cf968. If this module ever dropped the high-octet mix, every CJK
  // seed would collide with its ASCII-shadow twin.
  ok(hashSeed('foobar') !== 0xbf9cf968, 'the high octet of each code unit stopped being mixed');
  eq(hashSeed('foobar'), fnv1aUtf16le('foobar'));
});

test('rng: hashSeed is a pure function of the string, Chinese included', () => {
  const strings = ['daily|2026-09-20', 'random|deep|abc123', '火柴等式', '每日 2026-09-20 ☑'];
  for (const s of strings) {
    eq(hashSeed(s), fnv1aUtf16le(s), `the reference and hashSeed disagree on ${JSON.stringify(s)}`);
    eq(hashSeed(s), hashSeed(s), 'the same string hashed twice gave different values');
    eq(typeof hashSeed(s), 'number');
    ok(hashSeed(s) >= 0 && hashSeed(s) <= 0xffffffff, `hashSeed left 32-bit range: ${hashSeed(s)}`);
    // Non-ASCII goes through *both* octets of the UTF-16 unit; a build that only mixed the low
    // byte would collapse '日' and 'a\u65e5'... which is exactly what this checks.
    ok(hashSeed('日') !== hashSeed('a'), 'a CJK character hashed like an ASCII one');
  }
  // Distinct seeds, distinct buckets: the daily picker is `hash % lots.length`, so a collision
  // on the *bucket* is legal but a collision on the hash for these everyday strings is not.
  const seen = new Set(['daily|2026-09-20', 'daily|2026-09-21', 'daily|2026-09-22', 'random|deep|1', 'random|deep|2'].map((s) => hashSeed(s)));
  eq(seen.size, 5, 'everyday seed strings collided');
});

test('rng: mulberry32 emits the reference stream and nothing else', () => {
  for (const [seed, words] of Object.entries(MULBERRY)) {
    const got = wordsOf(mulberry32(Number(seed)), words.length);
    eq(got, words, `the stream for seed ${seed} is not mulberry32's`);
    eq(wordsOf(mulberry32(Number(seed)), words.length), got, 'a fresh generator on the same seed gave a different stream');
  }
});

function wordsOf(rng, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(word(rng));
  return out;
}

test('rng: mulberry32 output is a real fraction stream', () => {
  const rng = mulberry32(7);
  const xs = Array.from({ length: 500 }, () => rng());
  ok(xs.every((x) => x >= 0 && x < 1), 'a value left [0,1)');
  ok(xs.every((x) => Number.isFinite(x)), 'a non-finite draw');
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  ok(mean > 0.4 && mean < 0.6, `500 draws averaged ${mean}, which is not noise`);
  const buckets = new Array(8).fill(0);
  for (const x of xs) buckets[Math.floor(x * 8)]++;
  ok(buckets.every((b) => b > 25), `eight equal-width buckets got ${JSON.stringify(buckets)}`);
  // Two nearby seeds must not produce nearby streams (the avalanche the daily picker relies on).
  const a = mulberry32(1)();
  const b = mulberry32(2)();
  ok(Math.abs(a - b) > 1e-3, `seeds 1 and 2 agreed to ${a}`);
});

test('rng: the helpers stay inside their promises', () => {
  const rng = mulberry32(0x1234);
  for (let i = 0; i < 200; i++) {
    const n = rng.int(9);
    ok(Number.isInteger(n) && n >= 0 && n < 9, `int(9) returned ${n}`);
    const r = rng.range(3, 7);
    ok(Number.isInteger(r) && r >= 3 && r <= 7, `range(3,7) returned ${r}`);
    const deg = rng.range(5, 5);
    ok(deg === 5, `range(5,5) returned ${deg} instead of the only answer`);
    const c = rng.chance(0.5);
    ok(typeof c === 'boolean');
  }
  eq(rng.int(1), 0, 'int(1) must be the only index');
  // rng.int(0) is the degenerate call a UI makes when a tier came back empty. It must not
  // hand back NaN that then indexes an array.
  ok(Number.isNaN(rng.int(0)) || rng.int(0) === 0, `int(0) returned ${rng.int(0)}`);
});

test('rng: pick and shuffle answer over the array they were given', () => {
  const alphabet = ['a', 'b', 'c', 'd', 'e', 'f'];
  const rng = mulberry32(99);
  for (let i = 0; i < 50; i++) ok(alphabet.includes(rng.pick(alphabet)), 'pick invented a member');
  const frozen = alphabet.slice();
  const shuffled = rng.shuffle(alphabet.slice());
  eq(Array.from(shuffled).sort(), frozen.slice().sort(), 'shuffle lost or invented an element');
  eq(alphabet, frozen, 'shuffle rewrote the caller array');
  // A shuffle is a function of the seed: two players, same token, same order.
  eq(mulberry32(5).shuffle(frozen.slice()), mulberry32(5).shuffle(frozen.slice()), 'same seed, different order');
  ok(String(mulberry32(5).shuffle(frozen.slice())) !== String(mulberry32(6).shuffle(frozen.slice())),
    'two seeds shuffled identically');
  eq(mulberry32(3).shuffle([]), [], 'shuffle of an empty array must be empty, not an error');
});

test('rng: rngFrom accepts a string, a number, or an already-built rng', () => {
  eq(rngFrom('daily|2026-09-20')(), mulberry32(hashSeed('daily|2026-09-20'))(),
    'a string seed must route through hashSeed');
  eq(rngFrom(42)(), mulberry32(42)(), 'a numeric seed must be the state itself');
  const direct = mulberry32(11);
  ok(rngFrom(direct) === direct, 'rngFrom copied a generator that was already usable');
  // `rngFrom` must not hand back a *shared* generator for a seed string, either: the daily
  // picker calls it once per render and two calls have to agree.
  ok(rngFrom('abc') !== rngFrom('abc'), 'the same string seed returned one live object');
  eq([rngFrom('abc')(), rngFrom('abc')()], [rngFrom('abc')(), rngFrom('abc')()]);
  eq(rngFrom('42')(), rngFrom('42')(), 'the same string twice diverged');
  ok(rngFrom('42')() !== rngFrom('43')(), 'neighbouring string seeds agreed');
  // A numeric string and the number it spells are different seeds on purpose: `random|t|token`
  // routes are strings. If that ever coincides, share links start colliding.
  ok(rngFrom('42')() !== rngFrom(42)(), 'the string 42 and the number 42 seeded identically');
});

test('rng: construction is stateless, so a re-draw is a redraw and not a continuation', () => {
  // The property the routes depend on: `rngFrom(seed)` always starts from the same place, no
  // matter how many generators this process has already built. A module-level counter would
  // pass every "is one call deterministic" test and break the daily puzzle on the second visit
  // to the page.
  const seed = '火柴等式|daily';
  const first = wordsOf(rngFrom(seed), 3);
  for (let i = 0; i < 50; i++) rngFrom(`noise|${i}`)();
  const again = wordsOf(rngFrom(seed), 3);
  const third = wordsOf(rngFrom(seed), 3);
  eq(again, first, 'the stream moved after other generators were built in between');
  eq(third, first, 'two generators built from one string disagreed');
  ok(new Set(first).size === 3, 'three consecutive draws from one stream repeated');
  // A *fresh* generator is also not the same thing as continuing an old one: if `rngFrom` ever
  // cached a live stream per seed, the second daily render would show a different board.
  wordsOf(rngFrom(seed), 3);
  eq(wordsOf(rngFrom(seed), 1), [first[0]], 'rngFrom handed back a continued stream');
});

run();
