// js/core/game.js: the *session*. Every other core module is a pure function of its inputs,
// so the one place a rule can be applied twice, or applied from the wrong board, or read with
// its polarity flipped is here — and that is exactly what this suite is built to catch.
//
// The expectations are hand-derived from test/fixture.mjs (the boards and routes were painted
// off the glyph table with pencil and paper, see its header) plus the printed par of the baked
// pool. Nothing is asserted against what the implementation currently emits: the route checks
// below replay a walk from the lot's start board and compare against the equation a human read
// off the fixture comment.

import { test, ok, eq, run } from '../tools/harness.mjs';
import {
  compileShape, decodeHex, encodeHex, clone, isLit, legal, holds, showState, countLit, planMove,
} from '../js/core/board.js';
import { createGame } from '../js/core/game.js';
import { parOf } from '../js/core/solve.js';
import { campaign, campaignAt, campaignLength, followRoute } from '../js/core/library.js';
import { paint, ONE_MOVE, TWO_MOVE, THREE_MOVE, LEADING_ZERO, CHEAT } from './fixture.mjs';

// A lot as the shell hands one to createGame: normalised library rows have the shape compiled
// and the route decoded, so the fixtures get the same treatment by hand here.
function lotFrom(spec, boardText, par, route) {
  const shape = compileShape(spec);
  const state = typeof boardText === 'string' ? paint(spec, boardText) : boardText;
  return {
    id: 'fixture-' + spec, spec, state, par, proof: 'exhaustive-bfs',
    text: showState(shape, state), shape, route: route || [],
  };
}

const one = () => lotFrom(ONE_MOVE.spec, ONE_MOVE.from, 1, [{ off: ONE_MOVE.offIdx, on: ONE_MOVE.onIdx }]);
const two = () => lotFrom(TWO_MOVE.spec, TWO_MOVE.from, 2, TWO_MOVE.route);
const three = () => lotFrom(THREE_MOVE.spec, THREE_MOVE.from, 3, THREE_MOVE.route);

test('game: a fresh session is false, unplayed, holding nothing', () => {
  const g = createGame(two());
  eq(g.moves(), 0, 'a session starts with spent 搬');
  eq(g.solved(), false, 'a lot may not start on a true equation');
  eq(g.picked(), null, 'nothing is in the hand before a press');
  eq(g.refusal(), null, 'a fresh board has not refused anything yet');
  eq(g.text(), '0 + 0 = 1', 'the printed start board is not the fixture board');
  eq(g.hints(), 0);
  eq(g.stats(), { drags: 0, hints: 0, moves: 0 });
});

test('game: createGame copies the lot state instead of adopting it', () => {
  const lot = two();
  const before = encodeHex(lot.state);
  const a = createGame(lot);
  const b = createGame(lot);
  a.apply(4, 6);
  eq(encodeHex(lot.state), before, 'playing a session rewrote the pool row it came from');
  eq(b.moves(), 0, 'a second game from the same lot inherited the first one walk');
  eq(b.text(), '0 + 0 = 1');
});

test('game: a lot that is already true is refused at construction', () => {
  // `3 + 5 = 8` has nothing to find; shipping it as a puzzle would print a par of 0.
  let threw = false;
  try { createGame(lotFrom('doded', '3 + 5 = 8', 0, [])); } catch (e) { threw = /already solved/.test(String(e.message)); }
  ok(threw, 'an already-true board must not become a session');
});

test('game: a lot starting on an illegal board is refused at construction', () => {
  const [spec, text] = LEADING_ZERO[1]; // '05 + 3 = 8' — legal glyphs, illegal number
  let threw = false;
  try { createGame(lotFrom(spec, text, 1, [])); } catch (e) { threw = /illegal board/.test(String(e.message)); }
  ok(threw, 'a leading-zero start board must not become a session');
});

test('game: the hand-checked par-1 route solves in one 搬 and grades perfect', () => {
  const g = createGame(one());
  const res = g.apply(ONE_MOVE.offIdx, ONE_MOVE.onIdx);
  eq(res, { ok: true, solved: true, moves: 1 });
  eq(g.text(), ONE_MOVE.to);
  eq(g.grade(), { solved: true, moves: 1, hints: 0, par: 1, optimal: true, perfect: true });
});

// ---------------------------------------------------------------------------
// The victory gate. js/main.js calls `verifyRoute(history())` before it records anything, so
// a wrong answer here is a game that cannot be won. Two independent mistakes were live at once
// (replaying from `current` instead of `start`, and reading `legal()`'s string-or-null return
// as "truthy means legal"), and neither was visible without driving a *finished* session.
// ---------------------------------------------------------------------------
test('game: verifyRoute replays the walk from the start board, not the current one', () => {
  const g = createGame(two());
  eq(g.verifyRoute([]), false, 'the empty route is the start board, and the start board is false');
  g.apply(4, 6);
  eq(g.verifyRoute(g.history()), false, 'one 搬 lands on 9 + 0 = 1, which is still not true');
  g.apply(7, 17);
  eq(g.solved(), true);
  eq(g.verifyRoute(g.history()), true, 'a genuinely correct two-搬 run was rejected by the shell');
  eq(g.verifyRoute([{ off: 4, on: 6 }, { off: 7, on: 17 }]), true, 'the same route spelled out must verify the same');
});

test('game: verifyRoute keeps verifying after the board has moved on', () => {
  const g = createGame(three());
  for (let i = 0; i < THREE_MOVE.route.length; i++) {
    g.apply(THREE_MOVE.route[i].off, THREE_MOVE.route[i].on);
    const taken = g.history();
    eq(g.verifyRoute(taken), i === THREE_MOVE.route.length - 1,
      `prefix of ${i + 1} should ${i === 2 ? '' : 'not '}verify`);
    // Undo back to the start and re-ask: the same route has to give the same answer from
    // *either* end of the session, which is what a replay off `current` could not do.
    while (g.moves() > 0) g.undo();
    eq(g.verifyRoute(taken), i === THREE_MOVE.route.length - 1, 'the same route changed its answer after undo');
    for (let k = 0; k <= i; k++) g.apply(THREE_MOVE.route[k].off, THREE_MOVE.route[k].on);
  }
  eq(g.text(), THREE_MOVE.wayPoints[2]);
});

test('game: verifyRoute rejects a step that is not a 搬 at all', () => {
  const g = createGame(two());
  // The two steps of this route touch disjoint segments (cell 0 internally, then the '+' bar
  // into cell 2's middle), so *swapping* them is a second, equally correct 2-搬 solution — the
  // reversed order really does reach `9 − 8 = 1`, and `verifyRoute` has to say true to it. That
  // is not a loophole: it is the same walk, and par counts steps, not the order they were tried.
  eq(g.verifyRoute([{ off: 7, on: 17 }, { off: 4, on: 6 }]), true, 'a second correct route was denied');
  // What must be denied: a step that lifts a segment that is not there, and a step that is not
  // a move at all.
  eq(g.verifyRoute([{ off: 4, on: 6 }, { off: 4, on: 6 }]), false, 'the same 搬 twice was accepted');
  eq(g.verifyRoute([{ off: 6, on: 4 }]), false, 'the reverse of the first step is not a solution');
  eq(g.verifyRoute([{ off: 0, on: 1 }, { off: 4, on: 6 }, { off: 7, on: 17 }]), false,
    'a route with a stray step in front still verified');
  // The equals-bar cheat: 3 + 5 = 9 -> 3 + 5 = 8 paid for with a locked bar.
  const c = createGame(lotFrom(CHEAT.spec, CHEAT.puzzle, 1, []));
  eq(c.verifyRoute([{ off: CHEAT.offIdx, on: CHEAT.onIdx }]), false, 'stealing a locked bar must never verify');
  eq(c.apply(CHEAT.offIdx, CHEAT.onIdx).ok, false, 'and it must not be playable either');
  eq(c.moves(), 0, 'a refused move is not a step');
});

test('game: every legal 搬 keeps the total match count', () => {
  const g = createGame(two());
  const total = TWO_MOVE.totalMatches;
  eq(g.lit(), total, 'the fixture and the board disagree about the starting count');
  for (const m of TWO_MOVE.route) {
    g.apply(m.off, m.on);
    eq(g.lit(), total, `after ${m.off}->${m.on}`);
  }
  const h = createGame(three());
  eq(h.lit(), THREE_MOVE.totalMatches);
  for (const m of THREE_MOVE.route) { h.apply(m.off, m.on); eq(h.lit(), THREE_MOVE.totalMatches); }
});

test('game: the route waypoints are the equations the fixture claims', () => {
  const g = createGame(two());
  g.apply(4, 6);
  eq(g.text(), TWO_MOVE.wayPoints[0]);
  g.apply(7, 17);
  eq(g.text(), TWO_MOVE.wayPoints[1]);
  const h = createGame(three());
  THREE_MOVE.route.forEach((m, i) => { h.apply(m.off, m.on); eq(h.text(), THREE_MOVE.wayPoints[i]); });
});

test('game: undo rewinds one board at a time and says so when there is nothing left', () => {
  const g = createGame(two());
  eq(g.undo(), false, 'undo on a virgin board');
  eq(g.refusal(), '已经是最初的摆法了');
  g.apply(4, 6);
  g.apply(7, 17);
  eq(g.moves(), 2);
  ok(g.undo(), 'undo of the winning step');
  eq(g.text(), TWO_MOVE.wayPoints[0], 'undo jumped more than one step');
  eq(g.solved(), false, 'the board stayed solved after being un-done');
  ok(g.undo());
  eq(g.text(), '0 + 0 = 1');
  eq(g.moves(), 0);
});

test('game: restart rewinds the board but not the hints it would be unfair to erase', () => {
  const g = createGame(three());
  const h = g.hint();
  ok(h && Number.isInteger(h.off) && Number.isInteger(h.on), 'a par-3 lot must offer a proved first step');
  g.apply(h.off, h.on);
  eq(g.restart(), true);
  eq(g.moves(), 0, 'restart left the walk in place');
  eq(g.text(), THREE_MOVE.from);
  eq(g.hints(), 1, 'restart lied about a hint having been taken');
});

test('game: pick and drop are one gesture and cannot double-charge', () => {
  const g = createGame(two());
  eq(g.pick(999), false, 'a segment index off the end');
  eq(g.refusal(), '没有这一段');
  eq(g.drop(6, 4), false, 'a drop without a pick is not a move');
  eq(g.refusal(), '先拿起一根，再放到空位上');
  const dark = [0, 1, 2, 3, 4, 5, 6].find((i) => !isLit(g.state(), g.shape.segments[i]) && !g.shape.segments[i].locked);
  eq(g.pick(dark), false, 'pressing an empty slot lifts nothing');
  eq(g.refusal(), '那一格现在是空的，手里没有东西');
  eq(g.pick(CHEAT.equalsIdxs[0]), false, 'the two bars of = are not pressable');
  ok(/等号/.test(g.refusal()), 'the lock must say what it locked: ' + g.refusal());
  eq(g.pick(4), true, 'the lower-left bar of the first 0 is lit and unlocked');
  eq(g.picked(), 4);
  eq(g.cancel(), true);
  eq(g.picked(), null, 'cancel left something in the hand');
  eq(g.pick(4), true);
  // `drop` forwards to `apply`, and `apply` answers refusals with `{ ok: false, reason }` so the
  // shell can print which rule blocked the finger; only the "nothing in the hand" case above is
  // a bare false, because there was no move attempted at all.
  eq(g.drop(4), { ok: false, reason: '原地不动不算一手' });
  eq(g.moves(), 0, 'a same-slot drop was charged as a 搬');
  eq(g.pick(4), true);
  ok(g.drop(6), 'the certified first step dropped');
  eq(g.moves(), 1, 'pick+drop charged more than one 搬');
  eq(g.text(), '9 + 0 = 1');
  eq(g.picked(), null, 'the hand stayed full after the drop');
});

test('game: a drop onto an occupied slot is refused without spending the match', () => {
  const g = createGame(two());
  const litA = g.shape.segments.findIndex((s) => !s.locked && isLit(g.state(), s));
  const litB = g.shape.segments.findIndex((s, i) => i !== litA && !s.locked && isLit(g.state(), s));
  eq(g.apply(litA, litB).ok, false);
  eq(g.refusal(), '那个位置已经有一根了');
  eq(g.moves(), 0);
  eq(g.lit(), TWO_MOVE.totalMatches, 'a refused drop still changed the count');
  // Dropping from a dark source is refused by apply() even when nothing was picked.
  const dark = g.shape.segments.findIndex((s) => !s.locked && !isLit(g.state(), s));
  eq(g.apply(dark, litB).ok, false);
  eq(g.refusal(), '那根火柴本来就不在');
});

test('game: a hint is a real step of a proved shortest route, and it costs a counter', () => {
  for (const par of [1, 2, 3]) {
    const make = [one, two, three][par - 1];
    const g = createGame(make());
    const b = g.hint();
    ok(b, `no hint on a par-${par} lot`);
    // `left` counts the step being revealed: js/main.js prints `还差 ${h.left - 1} 搬`, so a hint
    // on a board needing par 搬 must report par, not par-1.
    eq(b.left, par, `hint on a par-${par} lot miscounted what is left`);
    // `moves` is the whole shortest route the hint came out of (the sweep returns the walk, not
    // its length), so it has to be exactly par steps long — that is what makes a hint honest on
    // a par-3 board instead of a guess.
    eq(b.moves.length, par, 'the hint claimed a route shorter than the proved par');
    eq(g.hints(), 1);
    const res = g.apply(b.off, b.on);
    ok(res.ok, `the hint of a par-${par} lot is not playable`);
    const after = parOf(g.shape, g.state());
    eq(after.par, par - 1, `the hint did not shorten a par-${par} lot by one`);
    eq(after.complete, true, `the re-check of a hinted lot is not exhaustive`);
    // Playing the rest through the same commit path still grades as optimal, but never perfect.
    while (!g.solved()) {
      const n = g.hint();
      ok(n, 'ran out of hints on a lot with a proved route');
      ok(g.apply(n.off, n.on).ok, 'a hint became unplayable mid-route');
    }
    const gr = g.grade();
    eq(gr.moves, par, `a hint-only run took ${gr.moves} 搬 on a par-${par} lot`);
    eq(gr.optimal, true);
    eq(gr.perfect, false, 'a run built from hints cannot be flagged perfect');
    eq(g.verifyRoute(g.history()), true, 'a hint-completed run does not verify');
  }
});

test('game: oneMoveFixes is the complete count, matching the fixture', () => {
  eq(createGame(one()).oneMoveFixes(), 1, 'the hand-checked par-1 board has exactly one fix');
  eq(createGame(two()).oneMoveFixes(), 0, 'a par-2 board must have no one-搬 fix at all');
  eq(createGame(three()).oneMoveFixes(), 0, 'a par-3 board neither');
});

test('game: serialize stores the moves only, and they replay to the same board', () => {
  const lot = three();
  const g = createGame(lot);
  g.apply(1, 6);
  g.apply(24, 22);
  const s = g.serialize();
  eq(Object.keys(s).sort(), ['hints', 'id', 'moves']);
  eq(s.id, lot.id);
  eq(s.moves, [{ off: 1, on: 6 }, { off: 24, on: 22 }], 'serialize lost or invented a step');
  eq(s.hints, 0);
  const back = createGame(lot);
  for (const m of s.moves) ok(back.apply(m.off, m.on).ok, 'a stored move does not replay');
  eq(back.text(), g.text(), 'the restored session is a different board');
  eq(back.moves(), 2);
  ok(!('state' in s) && !('hex' in s), 'serialize started storing boards');
});

test('game: grade compares against the printed par and never invents one', () => {
  const lot = two();
  const g = createGame(lot);
  eq(g.grade(), { solved: false, moves: 0, hints: 0, par: 2, optimal: false, perfect: false });
  g.apply(4, 6);
  g.apply(7, 17);
  eq(g.grade().perfect, true);

  // Undo *removes* a step from the count, so re-doing a move is not a detour — worth pinning,
  // because "how many 搬 did that take" is the number the whole difficulty claim rests on.
  const r = createGame(two());
  r.apply(4, 6);
  r.undo();
  r.apply(4, 6);
  r.apply(7, 17);
  eq(r.moves(), 2, 'an undone step still counted toward the grade');
  eq(r.grade().optimal, true);

  // A real detour: a legal first 搬 that leaves the board still two 搬 short (checked by an
  // independent complete enumeration, not by the session's own bookkeeping). Finishing it with
  // hints — which always take a shortest route from wherever the board stands — lands on a true
  // equation in 3 搬 on a par-2 lot: solved, but not optimal and not perfect.
  const d = createGame(two());
  const n = d.shape.segments.length;
  let detour = null;
  let probed = 0;
  for (let a = 0; a < n && !detour; a++) {
    for (let b = 0; b < n && !detour; b++) {
      if (a === b) continue;
      probed++;
      ok(probed < 4096, 'the detour search ran away');
      const plan = planMove(d.shape, d.state(), a, b);
      if (!plan || legal(d.shape, plan.next) !== null) continue;
      const p = parOf(d.shape, plan.next);
      if (p.complete && p.par === 2) detour = { off: a, on: b };
    }
  }
  ok(detour, 'the par-2 fixture has no legal first step that leaves it two 搬 short');
  ok(d.apply(detour.off, detour.on).ok, 'the detour step was refused');
  for (let guard = 0; guard < 10 && !d.solved(); guard++) {
    const h = d.hint();
    ok(h, 'a detour left the lot with no proved route at all');
    ok(d.apply(h.off, h.on).ok, 'a hint step became unplayable after a detour');
  }
  const gr = d.grade();
  eq([gr.solved, gr.moves, gr.par], [true, 3, 2], 'the detour did not land where the enumeration said');
  eq(gr.optimal, false, 'a 3-搬 run on a par-2 lot was called optimal');
  eq(gr.perfect, false);
  eq(d.verifyRoute(d.history()), true, 'a longer-than-par correct run failed verification');
});

test('game: segmentEnds hands the view the geometry it scales to pixels', () => {
  const g = createGame(two());
  const ends = g.shape.segments.map((s, i) => g.segmentEnds(i));
  eq(ends.length, g.shape.segments.length);
  ok(g.segmentEnds(-1) === null && g.segmentEnds(9999) === null, 'an index off the board drew a stick anyway');
  for (const e of ends) {
    for (const key of ['from', 'to']) {
      ok(Array.isArray(e[key]) && e[key].length === 2, `${key} is not a [x, y] pair`);
      ok(e[key].every((v) => Number.isFinite(v)), `${key} is not a point`);
    }
    ok(e.from[0] !== e.to[0] || e.from[1] !== e.to[1], 'a stick of zero length');
    ok(e.cell >= 0 && e.bit >= 0 && e.bit <= 6, 'a segment that does not belong to a cell bit');
  }
  // The equals cell is the only locked one and its two bars are the two horizontals it owns.
  const locked = ends.filter((e) => e.locked);
  eq(locked.length, 2, 'the equals cell is two bars and they are the only locked ones');
  eq([...new Set(locked.map((e) => e.cell))], [3]);
  for (const e of locked) eq(e.from[1], e.to[1], 'a locked bar is not horizontal');
  // Every lit stick of the board has an entry, and the count matches the rules exactly: the
  // view cannot be drawing a different number of matches than the session is holding.
  const lit = g.shape.segments.filter((s) => isLit(g.state(), s)).length;
  eq(ends.filter((e) => e.lit === undefined).length, ends.length, 'core grew a lit flag the view owns');
  ok(lit === countLit(g.state()) && lit > 0, 'the board has no sticks to draw');
  // The sticks of the two digit cells the first step touches are the ones the fixture names.
  eq(ends[4].cell, 0);
  eq(ends[4].bit, 4);
  eq(ends[6].cell, 0);
  eq(ends[6].bit, 6);
  eq(ends[17].cell, 2);
});

test('game: every shipped lot plays its own baked route to a true board', () => {
  // The whole reason this suite exists: the printed par is a claim about a walk off the start
  // board, and the shell only records a solve if verifyRoute agrees with it.
  eq(campaignLength(), 60);
  let worst = 0;
  for (const lot of campaign()) {
    const g = createGame(lot);
    eq(g.solved(), false, `${lot.id} starts solved`);
    const route = lot.route.map((m) => ({ off: m.off, on: m.on }));
    eq(route.length, lot.par, `${lot.id} carries ${route.length} steps but prints par ${lot.par}`);
    for (const m of route) {
      const res = g.apply(m.off, m.on);
      ok(res.ok, `${lot.id}: baked step ${m.off}->${m.on} was refused (${res.reason})`);
    }
    eq(g.solved(), true, `${lot.id} does not end on a true equation`);
    eq(g.verifyRoute(g.history()), true, `${lot.id}: a correct run was rejected by the victory gate`);
    eq(g.grade(), { solved: true, moves: lot.par, hints: 0, par: lot.par, optimal: true, perfect: true });
    eq(g.lit(), lot.lit, `${lot.id} changed the match count`);
    eq(showState(g.shape, g.state()).replace(/\s/g, ''), lot.answerText.replace(/\s/g, ''), `${lot.id} solved to a different equation than it printed`);
    worst = Math.max(worst, lot.par);
  }
  ok(worst <= 3, `a lot above the advertised 3-搬 ceiling slipped in: ${worst}`);
  // The same walk, but from a session that has already finished and been rewound: the route is
  // a property of the start board, so the answer must not depend on when it is asked.
  const last = campaignAt(campaignLength());
  const g = createGame(last);
  g.apply(last.route[0].off, last.route[0].on);
  eq(g.verifyRoute([]), false);
  eq(holds(last.shape, followRoute(last.shape, clone(last.state), last.route)), true,
    `${last.id}: the library route does not walk to a true equation`);
  eq(g.verifyRoute(last.route), true, `${last.id}: the library route does not verify from the start board`);
});

test('game: the session exposes exactly the surface the shell uses', () => {
  const g = createGame(one());
  const keys = Object.keys(g).sort();
  for (const k of ['lot', 'shape', 'spec', 'state', 'text', 'lit', 'moves', 'history', 'hints', 'picked',
    'refusal', 'solved', 'segmentEnds', 'pick', 'drop', 'apply', 'cancel', 'undo', 'restart', 'hint',
    'oneMoveFixes', 'grade', 'stats', 'serialize', 'verifyRoute']) {
    ok(keys.includes(k), `the shell calls ${k}, which the session does not have`);
  }
  eq(g.lot.id, one().id);
  eq(g.spec, ONE_MOVE.spec);
  ok(Array.isArray(g.history()), 'history is not an array');
  eq(decodeHex(encodeHex(g.state())).length, 5, 'the round trip changed the number of cells');
  ok(g.state() instanceof Uint8Array, 'the board leaked as a plain array');
});

run();
