// js/core/library.js + js/data/lots.js: the shipped puzzle pool, and the promise printed next
// to every one of its rows.
//
// This is the suite that makes the repo's headline claim testable from the *outside*: a row of
// `js/data/lots.js` is a string of hex plus a number, and re-running the complete enumeration
// over just those two things has to reproduce the number. Nothing here trusts the generator,
// the bake report, or the file's own comment — the state is decoded from text, the search is
// re-run from scratch, and the answer has to agree. It also pins the two route semantics the
// URL bar depends on (`#/daily` and `#/random/<tier>/<token>` must be the same puzzle for
// everyone) and the campaign order that gates unlocks.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { compileShape, decodeHex, encodeHex, legal, holds, showState, countLit } from '../js/core/board.js';
import { parOf, bestMove } from '../js/core/solve.js';
import { createGame } from '../js/core/game.js';
import { LOTS, BAKE, BAKED_AT } from '../js/data/lots.js';
import {
  pool, allLots, rejected, verifyRow, followRoute, lotById, lotIndex, campaign, campaignAt,
  campaignLength, tiers, tierLabel, lotsInTier, dateKey, dailyLot, randomLot, stats, auditProofs,
} from '../js/core/library.js';
import * as library from '../js/core/library.js';
import { hashSeed } from '../js/core/rng.js';

const TIER_KEYS = ['single', 'splay', 'setup', 'tangle', 'deep'];

test('library: the baked file is 60 rows of five even bands, no more and no less', () => {
  eq(LOTS.length, 60, 'the pool is not the size the bake reports');
  eq(BAKE.perTier, 12);
  eq(rejected(), [], 'the pool silently dropped rows: ' + JSON.stringify(rejected()));
  eq(pool().bad, []);
  eq(allLots().length, 60);
  eq(new Set(LOTS.map((r) => r.id)).size, 60, 'two rows share an id, so #/lot/<id> is ambiguous');
  for (const key of TIER_KEYS) eq(lotsInTier(key).length, 12, `band ${key} is not full`);
  eq([...new Set(allLots().map((l) => l.tier))].sort(), TIER_KEYS.slice().sort(), 'a band shipped with no label');
  ok(typeof BAKED_AT === 'string' && !Number.isNaN(Date.parse(BAKED_AT)), 'the bake timestamp is not a date');
  // Every row's id has to name its own band, or the campaign sort silently mixes them.
  for (const l of allLots()) eq(l.id.split('-')[0], l.tier, `${l.id} is filed under ${l.tier}`);
});

// THE re-proof. `par` on each printed row is a claim about a complete enumeration; this walks
// back into the hex string and does the enumeration again.
test('library: ANCHOR — re-solving every serialised row reproduces its printed par', () => {
  const mismatches = [];
  const proofs = new Set();
  let states = 0;
  let maxStates = 0;
  let ms = 0;
  for (const row of LOTS) {
    const shape = compileShape(row.spec);
    const state = decodeHex(row.state);
    // Pre-condition, or the re-proof would be proving the wrong board.
    if (state.length !== shape.n) { mismatches.push(`${row.id}: hex length ${state.length} != ${shape.n} cells`); continue; }
    if (legal(shape, state)) { mismatches.push(`${row.id}: the start board is not legal`); continue; }
    if (holds(shape, state)) { mismatches.push(`${row.id}: the start board is already true`); continue; }
    eq(encodeHex(state), row.state, `${row.id} does not re-encode to its own text`);
    eq(countLit(state), row.lit, `${row.id}'s printed match count is wrong`);
    eq(showState(shape, state).replace(/\s/g, ''), row.text.replace(/\s/g, ''), `${row.id}'s printed equation is wrong`);
    const again = parOf(shape, state);
    if (again.par !== row.par) mismatches.push(`${row.id}: re-solved par ${again.par}, printed ${row.par}`);
    if (!again.complete) mismatches.push(`${row.id}: the re-proof was not complete (${again.reason})`);
    if (again.proof !== row.proof) mismatches.push(`${row.id}: re-proof says ${again.proof}, printed ${row.proof}`);
    if (again.path.length !== row.par) mismatches.push(`${row.id}: the printed route is ${row.route.length} 搬, a fresh one is ${again.path.length}`);
    proofs.add(again.proof);
    states += again.states || 0;
    maxStates = Math.max(maxStates, again.states || 0);
    ms = Math.max(ms, (again.cost.bfs && again.cost.bfs.ms) || 0);
    // The stored route is a *second*, independent witness: it must solve the board, and it
    // must be exactly `par` steps long, so the page can re-check a puzzle in a handful of
    // moves without running the sweep again.
    const end = followRoute(shape, state, row.route);
    if (!holds(shape, end)) mismatches.push(`${row.id}: the printed route does not solve it`);
    eq(row.route.length, row.par, `${row.id} ships a ${row.route.length}-搬 route for par ${row.par}`);
  }
  eq(mismatches, [], 'serialised rows and the solver disagree');
  eq([...proofs].sort(), ['exhaustive-1', 'exhaustive-bfs'], 'a row carried a proof nobody can print');
  console.log(`  [re-proof] ${LOTS.length} rows re-measured · max component ${maxStates} states`
    + ` · worst single sweep ${ms}ms · mean component ${(states / LOTS.length).toFixed(1)}`);
  ok(ms < 200, `a single sweep took ${ms}ms; the "par 3 is exhaustible" finding is at risk`);
});

test('library: a tampered row is refused by verifyRow rather than silently shown', () => {
  const row = LOTS.find((r) => r.par === 3);
  ok(row, 'the pool has no par-3 row to tamper with');
  eq(verifyRow(row).ok, true, 'the untouched row does not even verify');
  const shape = compileShape(row.spec);
  const state = decodeHex(row.state);
  const trueEnd = followRoute(shape, state, row.route);

  // (a) the number is inflated: the route no longer matches the claim.
  eq(verifyRow({ ...row, par: row.par + 1 }).ok, false);
  ok(/route is/.test(verifyRow({ ...row, par: row.par + 1 }).reason), 'a wrong par got a vague reason');
  // (b) the number is claimed smaller than the route.
  ok(!verifyRow({ ...row, par: 1 }).ok);
  // (c) the route is truncated — the classic way a stale bake file would lie. The length check
  // fires first, and it has to: a 2-搬 route under a printed par 3 is a disagreement between
  // two fields, which is a sharper statement than "the route did not solve it".
  const short = verifyRow({ ...row, route: row.route.slice(0, row.par - 1) });
  eq(short.ok, false, 'a truncated route verified');
  eq(short.reason, `route is ${row.par - 1} 搬 but par says ${row.par}`);
  // (c2) same length, but it does not solve: only the replay can catch this one.
  const sameLengthNonsense = row.route.map((m) => ({ off: m.off, on: m.on }));
  sameLengthNonsense[sameLengthNonsense.length - 1] = { off: row.route[0].off, on: row.route[0].on };
  const noSolve = verifyRow({ ...row, route: sameLengthNonsense });
  eq(noSolve.ok, false, 'a route that does not solve verified');
  ok(/does not solve|不是|not a 搬|illegal/.test(noSolve.reason), `unhelpful reason: ${noSolve.reason}`);
  // (d) the route is replaced by another legal route of the same length that does not solve it.
  const bogus = row.route.map((m) => ({ ...m }));
  bogus[bogus.length - 1] = { off: bogus[0].off, on: bogus[0].on };
  const tampered = verifyRow({ ...row, route: bogus });
  eq(tampered.ok, false, 'a swapped route verified');
  // (e) the start board is moved to the *solution*: the puzzle would open already finished.
  const solved = { ...row, state: encodeHex(trueEnd) };
  eq(verifyRow(solved).ok, false);
  eq(verifyRow(solved).reason, 'start is already true');
  // (f) the start board is moved onto an illegal glyph (a digit cell emptied).
  const brokenCells = Uint8Array.from(state);
  brokenCells[0] = 0b1011010; // not a digit
  const broken = { ...row, state: encodeHex(brokenCells) };
  eq(verifyRow(broken).ok, false);
  ok(/start illegal/.test(verifyRow(broken).reason), `the illegal start was reported as ${verifyRow(broken).reason}`);
  // (g) the hex is one cell too long for the shape.
  eq(verifyRow({ ...row, state: row.state + '7f' }).reason, 'state length');
  // (h) an equals bar is smuggled into the route: legality refuses it, not a length check.
  const seg = shape.segments;
  const equalsBar = seg.findIndex((s) => s.locked);
  const cheat = { ...row, route: [{ off: equalsBar, on: seg.findIndex((s) => !s.locked && ((state[s.cell] >> s.bit) & 1) === 0) }] };
  eq(verifyRow(cheat).ok, false, 'a route that lifts an equals bar verified');
});

test('library: boot-time normalisation is idempotent and cache-backed', () => {
  const first = pool();
  eq(pool() === first, true, 'pool() rebuilt the array on every call — 60 re-verifications per render');
  eq(allLots() === first.lots, true);
  // A normalised lot is a superset of its row: the page reads `answerText`/`hex` off it, and
  // those have to be derived from the serialised state rather than handed over by the bake.
  const l = allLots()[0];
  for (const field of ['id', 'tier', 'spec', 'par', 'proof', 'n1', 'n2', 'text', 'answerText', 'lit', 'hex', 'route', 'shape', 'state']) {
    ok(l[field] !== undefined, `a normalised lot has no ${field}`);
  }
  eq(l.hex, l.state ? encodeHex(l.state) : '', 'the lot kept two different serialisations');
  ok(!holds(l.shape, l.state), 'the lot is solvable by being already solved');
  ok(holds(l.shape, followRoute(l.shape, l.state, l.route)), 'the lot cannot be solved by its own route');
  eq(l.segments, l.shape.segCount);
  // `lotById` and `lotIndex` agree, and the unknown-id answers are null/-1 rather than undefined.
  eq(lotById(l.id) === l, true);
  eq(lotIndex(l.id), allLots().indexOf(l), 'lotIndex and the pool array disagree');
  eq(lotById('does-not-exist'), null);
  eq(lotIndex('does-not-exist'), -1);
});

test('library: campaign order is the measurement, not the file order', () => {
  const list = campaign();
  eq(list.length, campaignLength());
  eq(campaign() === list, false, 'campaign() handed out its own array — a caller could sort it');
  for (let i = 1; i < list.length; i++) ok(list[i - 1].par <= list[i].par, `lot ${i} is easier than the one before it`);
  // Within one par, the generator band breaks the tie; within one band, the bake's own order.
  const deep3 = list.filter((l) => l.par === 3);
  ok(deep3.length >= 24, `only ${deep3.length} par-3 lots shipped`);
  const order = TIER_KEYS.reduce((acc, k) => {
    const inBand = deep3.filter((l) => l.tier === k).map((l) => lotIndex(l.id));
    return inBand.length > 1 ? acc.concat([String(inBand) === String(inBand.slice().sort((a, b) => a - b))]) : acc;
  }, []);
  eq(order, [true, true], 'a band is not sorted by the bake order inside its par');
  // A hand-built three-way tie proves the third key is `lotIndex` and not insertion accident.
  const tied = allLots().filter((l) => l.par === 1 && l.tier === 'single').map((l) => lotIndex(l.id));
  const first = campaign().filter((l) => l.par === 1 && l.tier === 'single').map((l) => lotIndex(l.id));
  eq(first, tied.slice().sort((a, b) => a - b), 'the tiebreak is not the bake order');
  // The ladder the player walks: #/c/1 is the cheapest lot in the pool.
  const cheapest = Math.min(...allLots().map((l) => l.par));
  eq(campaignAt(1).par, cheapest);
  eq(campaignAt(campaignLength()).par, Math.max(...allLots().map((l) => l.par)));
  // Out-of-range requests clamp instead of crashing or wrapping.
  eq(campaignAt(0), campaignAt(1));
  eq(campaignAt(-5), campaignAt(1));
  eq(campaignAt(1e9), campaignAt(campaignLength()));
  eq(campaignAt(3.7), campaignAt(3), 'a fractional position should clamp to the integer below');
  ok(campaignAt(2).id !== campaignAt(3).id, 'the campaign repeats a lot');
});

test('library: the daily route is the same puzzle for the whole world on a given day', () => {
  const days = ['2026-09-19', '2026-09-20', '2026-09-21', '2026-12-31', '2027-01-01'];
  for (const day of days) {
    const a = dailyLot(day);
    const b = dailyLot(day);
    ok(a && lotById(a.id), `${day} resolved to a lot that is not in the pool`);
    eq(a.id, b.id, `${day}'s daily puzzle changed between two calls`);
    // The pick is `hashSeed('daily|<day>') % 60` — spelled out here so a change to the seed
    // string or the modulus is a visible edit rather than a silent reshuffle of the calendar.
    eq(a.id, LOTS[hashSeed(`daily|${day}`) % LOTS.length].id, `${day} is not the hashed row`);
  }
  const ids = days.map((d) => dailyLot(d).id);
  ok(new Set(ids).size > 1, 'five consecutive days all picked the same puzzle');
  // Different days may legitimately repeat a lot; the same day may not.
  eq(dailyLot('2026-09-20').id, dailyLot('2026-09-20').id);
  // The date key format the save file is keyed by, and the shape of a hand-built Date.
  eq(dateKey(new Date(2026, 8, 20)), '2026-09-20', 'dateKey is not zero-padded');
  eq(dateKey(new Date(2026, 0, 5)), '2026-01-05');
  eq(dateKey().split('-').map(Number).length, 3);
  // A day key of today must resolve into the pool, because that is what the page renders.
  ok(lotById(dailyLot().id), 'the default dailyLot() is not a pool member');
});

test('library: the random route is shareable, band-scoped, and re-rollable', () => {
  const token = 'abc123';
  for (const key of TIER_KEYS.concat(['any'])) {
    const lot = randomLot(key, token);
    ok(lot, `band ${key} returned nothing`);
    eq(lot.tier, key === 'any' ? lot.tier : key, `#/random/${key} served another band`);
    eq(randomLot(key, token).id, lot.id, 'the same token gave a different puzzle');
    eq(lot.id, randomLot(key, String(token)).id);
    ok(lotById(lot.id), `${key}/${token} served a lot outside the pool`);
  }
  // A different token is a different draw — that is what "another one" means.
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(randomLot('deep', `token-${i}`).id);
  ok(seen.size > 1, `60 re-rolls produced ${seen.size} distinct lot(s)`);
  eq(randomLot('not-a-band', 'x'), null, 'an unknown band silently served the whole pool');
  // The tier vocabulary the router accepts is the vocabulary the pool ships.
  eq(tiers().map((t) => t.key), TIER_KEYS);
  eq(tierLabel('deep'), '深水');
  eq(tierLabel('nope'), 'nope', 'an unknown label should come back as itself, not as undefined');
  for (const t of tiers()) {
    eq(t.count, 12);
    ok(typeof t.label === 'string' && t.label.length > 0);
    ok(typeof t.blurb === 'string' && t.blurb.length > 0);
    // `par` in the band table is the *measured* maximum of that band, computed from rows.
    const mine = lotsInTier(t.key);
    eq(t.par, Math.max(...mine.map((l) => l.par)));
    eq(t.parMin, Math.min(...mine.map((l) => l.par)));
  }
  // The two par-3 bands must really be different puzzles, or the ladder is a lie.
  eq(tiers().find((t) => t.key === 'tangle').par, 3);
  eq(tiers().find((t) => t.key === 'deep').par, 3);
  ok(tiers().find((t) => t.key === 'deep').states > tiers().find((t) => t.key === 'tangle').states,
    'the deepest band is not the biggest sweep');
});

test('library: the printed statistics are recomputed, never stored', () => {
  const s = stats();
  eq(s.lots, 60);
  eq(s.rejected, 0);
  eq(s.parMax, Math.max(...allLots().map((l) => l.par)));
  eq(s.parMax, 3, 'this build was supposed to cap at par 3');
  eq(s.statesMax, Math.max(...allLots().map((l) => l.states || 0)));
  ok(s.statesMax >= 10 && s.statesMax <= 3645, `the biggest shipped component is ${s.statesMax} states`);
  eq(s.byPar, allLots().reduce((acc, l) => { acc[l.par] = (acc[l.par] || 0) + 1; return acc; }, {}));
  eq(Object.keys(s.byPar).map(Number).sort(), [1, 2, 3], 'a par outside the documented ladder shipped');
  eq(s.proofs, ['exhaustive-1', 'exhaustive-bfs']);
  eq(auditProofs(), [], 'a row shipped without a finished enumeration: ' + JSON.stringify(auditProofs()));
  // The bake report is a claim about the run that produced these rows; the parts of it that are
  // about *these* rows have to agree with them.
  eq(BAKE.report.length, 5);
  for (const line of BAKE.report) {
    eq(line.got, line.want, `band ${line.tier} shipped ${line.got} of ${line.want}`);
    eq(line.got, lotsInTier(line.tier).length);
    eq(line.want, BAKE.perTier);
  }
});

test('library: every shipped lot is playable from its serialised row alone', () => {
  // The page hands `createGame` a normalised lot. If any row needed the generator's in-memory
  // board to work, the pool would be a build artefact that only compiles at bake time.
  const samples = [campaignAt(1), dailyLot('2026-09-20'), lotById('deep-11'), lotsInTier('setup')[0]];
  for (const lot of samples) {
    const game = createGame(lot);
    eq(game.spec, lot.spec);
    eq(Array.from(game.state()), Array.from(lot.state), 'the game adopted the pool state instead of copying it');
    eq(game.solved(), false);
    eq(game.moves(), 0);
    const end = followRoute(game.shape, game.state(), lot.route);
    ok(holds(game.shape, end));
    // And the proof on screen is the proof in the file: `bestMove` is the same search the bake
    // ran, so the hint cannot offer a shortcut the number denies.
    const hint = bestMove(game.shape, lot.state);
    eq(hint.left, lot.par, `the hint disagrees with the printed par for ${lot.id}`);
    eq(hint.moves.length, lot.par);
    game.apply(hint.off, hint.on);
    eq(game.moves(), 1);
  }
});

test('library: the module exports nothing the shell never calls', () => {
  // A pool API with an unused entry is a second model waiting to drift — this repo already
  // deleted `resetCache` and `tierByKey` for exactly that reason, so the check is kept alive by
  // naming the exports the tests and the shell actually read.
  const exported = Object.keys(library).sort();
  eq(exported, ['allLots', 'auditProofs', 'campaign', 'campaignAt', 'campaignLength', 'dailyLot',
    'dateKey', 'followRoute', 'lotById', 'lotIndex', 'lotsInTier', 'pool', 'randomLot', 'rejected',
    'stats', 'tierLabel', 'tiers', 'verifyRow'].sort(), JSON.stringify(exported));
});

run();
