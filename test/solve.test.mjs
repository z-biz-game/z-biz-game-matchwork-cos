// js/core/solve.js: the proof layer. The claim under test is not "the search finds good
// answers" but "the search cannot miss one", so the assertions are about coverage:
// hand-written route lists, complete-product re-counts, a refutation by removing the clue,
// and a census that classifies every single board of the smallest shape.

import { test, ok, eq, fail, run } from '../tools/harness.mjs';
import {
  compileShape, decode, encode, holds, legal, planMove, applyMove, equationTrue,
  countLit, showState, eachSuccessor, rawSuccessors, pickableSegments, lockedIntact,
  EQUALS_PATTERN, DIGIT_PATTERN, OP_PATTERN,
} from '../js/core/board.js';
import {
  exhaustive1, search, exhaustive2, bfs, parOf, bestMove, oneMoveSolutions,
} from '../js/core/solve.js';
import { paint, CHEAT, ONE_MOVE, TWO_MOVE, THREE_MOVE, UNSOLVABLE, allBoards, MATCHES } from './fixture.mjs';

const now = () => Date.now();

test('solve: exhaustive1 lists every one-move fix of a hand-built board', () => {
  const s = compileShape(ONE_MOVE.spec);
  const st = paint(ONE_MOVE.spec, ONE_MOVE.from);
  const e = exhaustive1(s, st);
  eq(e.depth, 1);
  eq(e.complete, true, 'a depth-1 product has no budget to run out of');
  eq(e.truncatedBy, null);
  eq(e.n, 1, 'the fixture claims exactly one fix');
  eq(e.solutions[0].off, ONE_MOVE.offIdx);
  eq(e.solutions[0].on, ONE_MOVE.onIdx);
  eq(showState(s, e.solutions[0].next).replace(/\s/g, ''), ONE_MOVE.to.replace(/\s/g, ''));
  eq(e.space, e.off * e.on, 'the printed product is the product it actually walked');
  eq(e.plans, e.space, 'every pair of distinct segments is structurally a move');
  ok(e.legalStates >= e.n && e.legalStates <= e.plans);
  ok(e.ms >= 0);
});

test('solve: exhaustive1 is the whole product, not a queue that stopped early', () => {
  const s = compileShape('doded');
  const st = paint('doded', '2 + 3 = 6');
  const off = pickableSegments(s, st);
  const e = exhaustive1(s, st);
  eq(e.off, off.length);
  eq(e.on, 27 - countLit(st) - 0, 'dark unlocked segments: 27 slots minus the lit ones');
  eq(e.plans, e.off * e.on);
  // Re-count the same thing with a hand-written double loop over raw indices.
  let hand = 0;
  let handLegal = 0;
  for (const a of off) {
    for (const b of rawSuccessors(s, st).filter((p) => p.off === a.i)) {
      hand++;
      if (!legal(s, b.next)) handLegal++;
    }
  }
  eq(hand, e.plans, 'the hand-written loop sees the same number of pairs');
  eq(handLegal, e.legalStates, 'and the same number of legal boards');
  // Every solution it reports must survive an independent replay.
  for (const sol of e.solutions) {
    const res = applyMove(s, st, sol.off, sol.on);
    ok(res.ok, 'a reported solution is not a legal move');
    eq(Array.from(res.next), Array.from(sol.next));
    ok(holds(s, res.next), 'a reported solution does not actually solve anything');
  }
});

test('solve: a board that is already true has no moves to find (and par 0 is impossible)', () => {
  const s = compileShape('doded');
  const st = paint('doded', '2 + 3 = 5');
  ok(holds(s, st));
  // A true board is not a puzzle, so nothing here is allowed to hand it a number: parOf
  // reports the empty enumeration and the sweep reports "already true".
  const one = exhaustive1(s, st);
  eq(one.n, 0, 'no 搬 can be the fix of a board that is already right');
  const b = bfs(s, st);
  eq(b.par, 0);
  eq(b.found, true);
  eq(b.solutions.length, 0);
  eq(bestMove(s, st), null, 'there is nothing to hint about');
  eq(holds(s, st), true);
});

test('solve: REFINEMENT — removing the one clue makes a complete enumeration go silent', () => {
  const s = compileShape(ONE_MOVE.spec);
  const st = paint(ONE_MOVE.spec, ONE_MOVE.from);
  eq(exhaustive1(s, st).n, 1, 'precondition: exactly one one-move fix exists');
  const deny = new Set([ONE_MOVE.offIdx]);
  const e = exhaustive1(s, st, { deny });
  eq(e.n, 0, 'forbidding the only segment the fix lifted must kill every solution');
  eq(e.complete, true, 'and it must still be a complete enumeration, not a timeout');
  eq(e.off, e.space / e.on, 'the space really did shrink by one pickable segment');
  const p = parOf(s, st, { deny });
  ok(p.par > 1 || p.par === null, `with the clue removed the par must leave 1, got ${p.par}`);
  // Putting the lock somewhere harmless must change nothing: the denial is a real filter,
  // not a global "search less".
  const equalsBar = CHEAT.equalsIdxs[0];
  const noise = new Set([equalsBar]);
  eq(exhaustive1(s, st, { deny: noise }).n, 1, 'denying an already-locked bar costs nothing');
  // And the two runs must disagree about *which* moves exist, not merely about counts.
  const without = exhaustive1(s, st).solutions.map((x) => `${x.off}>${x.on}`).join(',');
  const withD = exhaustive1(s, st, { deny }).solutions.map((x) => `${x.off}>${x.on}`).join(',');
  ok(without !== withD, 'the denial set had no observable effect');
  ok(!withD.includes(String(ONE_MOVE.offIdx)), 'the forbidden segment still appears');
});

test('solve: parOf on the hand-built par-1 fixture reports exhaustive-1', () => {
  const s = compileShape(ONE_MOVE.spec);
  const st = paint(ONE_MOVE.spec, ONE_MOVE.from);
  const r = parOf(s, st);
  eq(r.par, 1);
  eq(r.complete, true);
  eq(r.proof, 'exhaustive-1');
  eq(r.n1, 1);
  eq(r.path.length, 1);
  ok(r.cost.depth1.space > 0 && r.cost.depth1.ms >= 0, 'the price of the proof is printed');
});

test('solve: the hand-built par-2 fixture is proved by two layers, not one', () => {
  const s = compileShape(TWO_MOVE.spec);
  const st = paint(TWO_MOVE.spec, TWO_MOVE.from);
  eq(countLit(st), TWO_MOVE.totalMatches, 'the fixture match count is what the comment says');
  const one = exhaustive1(s, st);
  eq(one.n, 0, 'depth 1 must be empty for a par-2 board');
  eq(one.complete, true);
  const two = exhaustive2(s, st);
  eq(two.found, true, 'depth 2 must find a route');
  eq(two.depth, 2);
  eq(two.complete, true, 'a truncated depth-2 sweep proves nothing');
  ok(two.solutions.length >= 1);
  eq(two.pairs >= two.combos && two.combos >= two.solutions.length, true, 'cost accounting must be monotone');
  const r = parOf(s, st);
  eq(r.par, 2);
  eq(r.proof, 'exhaustive-bfs');
  eq(r.n1, 0);
  eq(r.n2, two.solutions.length, 'the two independent depth-2 sweeps must count the same routes');
  ok(r.states > 0, 'the size of the reachable component is part of the printed evidence');
  eq(r.path.length, 2);
  // The hand-checked waypoints: the route solve found is *a* route, and every step of it
  // must land on a legal board, ending on a true one.
  let cur = st;
  for (const m of r.path) {
    const p = planMove(s, cur, m.off, m.on);
    ok(p, 'a route step is not a move at all');
    ok(!lockedIntact(s, p.next) === false, 'a route step touched the equals sign');
    eq(legal(s, p.next), null, `a route step landed on an illegal board: ${legal(s, p.next)}`);
    eq(countLit(p.next), countLit(cur), 'a route step changed the match count');
    cur = p.next;
  }
  ok(holds(s, cur), 'the route does not end on a true equation');
  // The fixture's own hand-written waypoint, glyph for glyph: `showState` prints the
  // operator as U+2212 (board.js OP_SHOW), so the comparison is made in the same alphabet
  // the fixture is written in — not in whatever the printer happens to emit.
  eq(showState(s, cur).replace(/\s/g, ''), TWO_MOVE.wayPoints[1].replace(/\s/g, ''),
    `the fixture hand-check expects ${TWO_MOVE.wayPoints[1]}, got ${showState(s, cur)}`);
});

test('solve: the fixture route is found by the search too (hand list vs enumeration)', () => {
  const s = compileShape(TWO_MOVE.spec);
  const st = paint(TWO_MOVE.spec, TWO_MOVE.from);
  const two = exhaustive2(s, st, { all: true });
  const asText = two.solutions.map((x) => x.moves.map((m) => `${m.off}>${m.on}`).join(','));
  const want = TWO_MOVE.route.map((m) => `${m.off}>${m.on}`).join(',');
  ok(asText.includes(want), `the hand-checked route ${want} is missing from ${asText.join(' | ')}`);
  let cur = st;
  for (const step of TWO_MOVE.route) {
    cur = planMove(s, cur, step.off, step.on).next;
  }
  eq(showState(s, cur).replace(/\s/g, ''), TWO_MOVE.wayPoints[1].replace(/\s/g, ''));
});

test('solve: the locked equals is invisible to the search as well as to the model', () => {
  const s = compileShape(CHEAT.spec);
  const st = paint(CHEAT.spec, CHEAT.puzzle);
  const e = exhaustive1(s, st);
  // Hand census of `3 + 5 = 9`, lift by lift (counts from the fixture's MATCHES table):
  //   lift from the 3 (a,b,c,d,g) or the 5 (a,c,d,f,g) — no single bit off leaves a glyph;
  //   lift the '+' vertical — the operator becomes '−', and 3 − 5 is refused as negative;
  //   lift the 9's f (→ 3) or its b (→ 5) — then the drop can only make an LHS digit a 9 or
  //     a 6, and none of 9+5=3, 3+9=3, 3+6=3, 9+5=5, 3+9=5, 3+6=5, 3+5=… holds.
  // So the one and only arithmetically true neighbour is the cheat itself: the 9 gains its
  // e segment from the lower bar of the equals sign and becomes an 8 (3 + 5 = 8).
  eq(e.n, 0, 'the honest one-move population of this board is empty — the cheat is the only fix');
  const all = [].concat(e.solutions.map((x) => [x.off, x.on]));
  for (const [off, on] of all) {
    ok(!CHEAT.equalsIdxs.includes(off) && !CHEAT.equalsIdxs.includes(on), 'a solution moved an equals bar');
  }
  // Not a broken board, an empty *search*: there was a real product to walk, and a
  // second, independent path over it (raw plans + `holds`) agrees that nothing is true.
  const raw = rawSuccessors(s, st);
  ok(raw.length > 100, `expected a crowded candidate space, got ${raw.length}`);
  let legalSuccessors = 0;
  let trueSuccessors = 0;
  for (const plan of raw) {
    if (legal(s, plan.next)) continue;
    legalSuccessors++;
    if (holds(s, plan.next)) trueSuccessors++;
  }
  eq(legalSuccessors, e.legalStates, 'the two paths disagree about how many legal neighbours exist');
  eq(trueSuccessors, 0, 'and about whether any of them is true');
  // The cheat is arithmetically true, so the only thing keeping it out is the lock. If the
  // lock were removed from the model, this exact pair *would* be a one-move solution.
  eq(equationOfCheatWouldBeTrue(s, st), true, 'fixture rotted: the cheat is no longer a real temptation');
});

function equationOfCheatWouldBeTrue(s, st) {
  const next = Uint8Array.from(CHEAT.cheated);
  return s.cells.length === next.length && legal(s, next) !== null
    && !lockedIntact(s, next) && !holds(s, next)
    && equationTrueIgnoreLock(s, next);
}

function equationTrueIgnoreLock(s, st) {
  let total = 0;
  const operands = s.operands;
  const g = (ci) => glyphOf(st[ci]);
  for (let i = 0; i < s.lhsOperands; i++) {
    let v = 0;
    for (const ci of operands[i].cells) v = v * 10 + Number(g(ci));
    total += v;
  }
  let rhs = 0;
  for (const ci of operands[s.lhsOperands].cells) rhs = rhs * 10 + Number(g(ci));
  return total === rhs;
}

function glyphOf(mask) {
  for (const [ch, m] of Object.entries(DIGIT_PATTERN)) if (m === mask) return ch;
  return null;
}

test('solve: search() honours its budgets and says so instead of guessing', () => {
  const s = compileShape(TWO_MOVE.spec);
  const st = paint(TWO_MOVE.spec, TWO_MOVE.from);
  const zero = search(s, st, { depth: 2, maxPairs: 0 });
  eq(zero.found, false);
  eq(zero.complete, false);
  eq(zero.truncatedBy, 'pairs');
  const slow = search(s, st, { depth: 2, deadlineMs: -1 });
  eq(slow.complete, false);
  eq(slow.truncatedBy, 'time');
  const tight = search(s, st, { depth: 2, maxCombos: 0 });
  eq(tight.complete, false);
  eq(tight.truncatedBy, 'combos');
  const room = search(s, st, { depth: 2, maxPairs: 1e9, maxCombos: 1e9, deadlineMs: 5000 });
  eq(room.complete, true);
  eq(room.found, true);
  ok(zero.pairs <= room.pairs, 'the truncated run cannot have looked at more than the finished one');
});

test('solve: a truncated depth-2 sweep may not be used to claim par 2', () => {
  const s = compileShape(TWO_MOVE.spec);
  const st = paint(TWO_MOVE.spec, TWO_MOVE.from);
  const cut = search(s, st, { depth: 2, maxPairs: 1 });
  eq(cut.found, false);
  eq(cut.complete, false);
  // The same board with unlimited budget does find a route: "found nothing" and "found
  // nothing and ran out of budget" are different statements and must not be conflated.
  const full = search(s, st, { depth: 2 });
  eq(full.found, true);
  eq(full.complete, true);
  // parOf rides on the same sweeps, so a one-state budget has to make it *silent* rather than
  // confident: no number, no proof label, and a reason that says which budget ran out.
  const p = parOf(s, st, { maxStates: 1, deadlineMs: 1e9 });
  eq(p.par, null, 'a starved sweep printed a number');
  eq(p.complete, false);
  eq(p.proof, null, `parOf invented the proof label ${p.proof} from a truncated sweep`);
  ok(String(p.reason).startsWith('sweep-'), `the refusal should name its budget, got ${p.reason}`);
});

test('solve: bfs over the whole component classifies the hand-proved dead end', () => {
  const s = compileShape(UNSOLVABLE.spec);
  const st = paint(UNSOLVABLE.spec, UNSOLVABLE.from);
  eq(countLit(st), UNSOLVABLE.matches, 'the fixture comment and the board must agree');
  const tally = eachSuccessor(s, st, () => {});
  eq(tally.states, 0, 'the hand proof says this board has no legal successor at all');
  ok(tally.space > 0, 'there were candidate pairs to look at, so the emptiness is a finding');
  const b = bfs(s, st);
  eq(b.found, false);
  eq(b.unsolvable, true);
  eq(b.complete, true, 'exhausting the component is a proof, not a timeout');
  eq(b.par, null);
  eq(b.states, 1);
  const p = parOf(s, st);
  eq(p.par, null);
  eq(p.reason, 'unsolvable');
  eq(p.complete, true);
  // Independent half of the proof: no true board anywhere in the shape has this match count.
  const { shape, boards } = allBoards(UNSOLVABLE.spec);
  eq(shape.spec, s.spec);
  const sameCountTrue = boards.filter((x) => countLit(x) === UNSOLVABLE.matches
    && !legal(shape, x) && holds(shape, x));
  eq(sameCountTrue.length, 0, 'the counting argument in the fixture no longer holds up');
});

test('solve: parOf labels an unsolvable board instead of inventing a number', () => {
  const s = compileShape(UNSOLVABLE.spec);
  const st = paint(UNSOLVABLE.spec, UNSOLVABLE.from);
  const p = parOf(s, st);
  eq(p.par, null);
  eq(p.n1, 0);
  ok(p.cost.depth1.space > 0, 'the cost of the refusal is still printed');
  eq(bestMove(s, st), null, 'there is no next move of no route');
});

// THE load-bearing test of this whole repo. `js/data/lots.js` prints a `par` next to every
// puzzle, and the promise behind it is: that number is *measured* by sweeping the component of
// legal boards, not stored in a config field somewhere. So the sweep must be breakable — push
// its state budget down and the printed answer has to disappear (never shrink, never change),
// and only a budget that fits the whole component may produce a number. `THREE_MOVE` is the
// fixture for it because par 3 is the depth the spec used to call unprovable.
test('solve: ANCHOR — par comes out of the sweep, so truncating the sweep removes the number', () => {
  const s = compileShape(THREE_MOVE.spec);
  const st = paint(THREE_MOVE.spec, THREE_MOVE.from);
  eq(countLit(st), THREE_MOVE.totalMatches, 'the fixture match count is not what its comment says');
  eq(MATCHES.digit[0] + MATCHES.op['+'] + MATCHES.digit[4] + MATCHES.equals + MATCHES.digit[2], 19,
    'the hand count of 0 + 4 = 2');

  // Two *independent complete* enumerations rule out the shallow answers, by hand-crafted
  // route length: nothing of length 1 or 2 exists.
  const one = exhaustive1(s, st);
  eq(one.complete, true);
  eq(one.n, 0, 'depth 1 is claimed empty — the depth-1 product must be walked whole');
  const two = search(s, st, { depth: 2 });
  eq(two.complete, true, 'a truncated depth-2 sweep would prove nothing here');
  eq(two.found, false, 'depth 2 must really be empty for a par-3 board');

  // The hand-written route must replay, board by board, exactly as its comment claims.
  let cur = st;
  THREE_MOVE.route.forEach((step, i) => {
    const plan = planMove(s, cur, step.off, step.on);
    ok(plan, `hand route step ${i + 1} is not a move at all`);
    cur = plan.next;
    eq(legal(s, cur), null, `hand route step ${i + 1} landed on an illegal board`);
    eq(showState(s, cur).replace(/\s/g, ''), THREE_MOVE.wayPoints[i].replace(/\s/g, ''),
      `hand route step ${i + 1} printed ${showState(s, cur)}`);
  });
  ok(holds(s, cur), 'the hand route does not end on a true equation');

  const sure = parOf(s, st);
  eq(sure.par, 3, `the sweep says ${sure.par} for a route proven to be 3 搬 long`);
  eq(sure.complete, true);
  eq(sure.proof, 'exhaustive-bfs', 'par 3 must be certified by the full sweep');
  eq(sure.path.length, 3);
  ok(sure.n1 === 0, 'a par-3 board has no one-move fix to count');
  eq(sure.n2, 0, 'and no two-move route, which is the independent depth-2 cross-check agreeing');
  const whole = sure.cost.bfs;
  ok(whole.complete === true && whole.truncatedBy === null, 'the certified run cannot be truncated');
  ok(whole.states > 1 && whole.states < 400, `the component should be tiny, got ${whole.states}`);

  // Now break it, cap by cap from 1 up past the whole component. Three things must all hold:
  // a starved sweep is silent, a sweep with room answers, the sequence never flips back, and
  // the *only* number it ever answers with is the proved 3. One false in the middle of the
  // trues, or a value that moves with the config, and par would be a knob rather than a
  // measurement.
  ok(sure.cost.bfs.layerFinished === true, 'the certified run must have finished its answer layer');
  const sureExpansions = sure.cost.bfs.expansions;
  let answered = false;
  let partialLayers = 0;
  let firstCap = null;
  for (let cap = 1; cap <= whole.states + 2; cap++) {
    const cut = parOf(s, st, { maxStates: cap, deadlineMs: 1e9 });
    ok(cut.par === null || cut.par === 3, `cap ${cap} printed ${cut.par}: only silence or the proved 3 is honest`);
    if (cut.par !== null && !answered) { answered = true; firstCap = cap; }
    eq(cut.par, answered ? 3 : null, `cap ${cap} broke monotonicity: it answered after cap ${firstCap} went silent`);
    eq(cut.complete, answered, `cap ${cap} disagrees with itself about finishing`);
    eq(cut.proof, answered ? 'exhaustive-bfs' : null, `cap ${cap} invented proof label ${cut.proof}`);
    eq(cut.path.length, answered ? 3 : 0, `cap ${cap} handed back a ${cut.path.length}-step route`);
    eq(String(cut.reason).startsWith('sweep-'), !answered, `cap ${cap} gave reason ${cut.reason}`);
    // A sweep that answers did so because a layer yielded a true board, so it was never cut
    // short *before* that layer; a silent one was.
    eq(cut.cost.bfs.truncatedBy, answered ? null : 'states', `cap ${cap} reports ${cut.cost.bfs.truncatedBy}`);
    ok(cut.nAtPar <= sure.nAtPar, `cap ${cap} counted ${cut.nAtPar} shortest routes, the full sweep only ${sure.nAtPar}`);
    if (answered && !cut.cost.bfs.layerFinished) {
      // Answering mid-layer is legal and keeps `par` exact, but the route *count* below it is
      // only a lower bound. Count how often that happens, so DESIGN.md can say how tight the
      // "just fits" cap really is; the honest invariant is 1 <= count <= the finished count.
      partialLayers++;
      ok(cut.nAtPar >= 1, 'a sweep that found the answer must still name a route');
    }
    // `maxStates` bounds *expansions*, not the length of the state list: the successors of the
    // last board the sweep agreed to expand may overshoot it (see the budget note in solve.js).
    ok(cut.cost.bfs.expansions < cap, `cap ${cap} expanded ${cut.cost.bfs.expansions} boards`);
    if (!answered) ok(cut.cost.bfs.expansions < sureExpansions, `cap ${cap} did as much work as the certified run`);
  }
  ok(answered, `no cap up to ${whole.states + 2} finished the sweep — the component is bigger than reported`);
  ok(firstCap > 1 && firstCap <= whole.states + 1, `the answer appeared at cap ${firstCap} of a ${whole.states}-state component`);
  // The cap that only just fits must be *tighter* than the default: that is the whole evidence
  // that the shipped numbers were reached by search rather than by a generous always-fits knob.
  const tight = parOf(s, st, { maxStates: firstCap, deadlineMs: 1e9 });
  eq(tight.par, 3);
  eq(tight.cost.bfs.expansions < sure.cost.bfs.expansions || tight.cost.bfs.states <= sure.cost.bfs.states, true,
    'the minimum fitting cap cannot do more work than the unbounded one');
  const roomy = parOf(s, st, { maxStates: whole.states + 2, deadlineMs: 1e9 });
  eq(roomy.cost.bfs.layerFinished, true, 'a cap past the component size must finish the answer layer');
  eq(roomy.nAtPar, sure.nAtPar, 'and then count the shortest routes exactly like the default run');
  console.log(`  [cap-sweep] par 3 first answered at cap ${firstCap} of a ${whole.states}-state component,`
    + ` ${partialLayers} cap(s) answered mid-layer · ${sure.nAtPar} shortest routes · default ${sureExpansions} expansions in ${whole.ms}ms`);
  // Time is a second, orthogonal budget on the same sweep, and the deadline is read before
  // every expansion — so a deadline that has already expired cannot certify anything either.
  const stalled = parOf(s, st, { deadlineMs: -1 });
  eq(stalled.par, null);
  eq(stalled.complete, false);
  eq(stalled.proof, null);
  eq(stalled.cost.bfs.truncatedBy, 'time');
  eq(stalled.cost.bfs.expansions, 0, 'an expired deadline must not expand a single board');
});

test('solve: the same truncation rule protects the par-2 fixture', () => {
  const s = compileShape(TWO_MOVE.spec);
  const st = paint(TWO_MOVE.spec, TWO_MOVE.from);
  const starved = parOf(s, st, { maxStates: 2, deadlineMs: 1e9 });
  eq(starved.complete, false, 'a two-state budget cannot certify a two-搬 route');
  eq(starved.par, null, 'and so must not print one');
  eq(starved.proof, null, `parOf claimed ${starved.proof} from a truncated sweep`);
  eq(starved.path.length, 0, 'a refused sweep has no route to hand back');
  ok(String(starved.reason).startsWith('sweep-'), starved.reason);
  const c = starved.cost.bfs;
  eq(c.complete, false);
  eq(c.truncatedBy, 'states');
  // The very same board with room to breathe is certified, and the two outcomes differ only
  // because of the budget — which is the whole point of refusing to print a number.
  const sure = parOf(s, st);
  eq(sure.complete, true);
  eq(sure.proof, 'exhaustive-bfs');
  eq(sure.par, 2);
});

test('solve: bestMove returns a first step of a shortest route, by par band', () => {
  const cases = [[ONE_MOVE.spec, ONE_MOVE.from, 1], [TWO_MOVE.spec, TWO_MOVE.from, 2]];
  for (const [spec, text, want] of cases) {
    const s = compileShape(spec);
    const st = paint(spec, text);
    const b = bestMove(s, st);
    ok(b, `no hint for a board with par ${want}`);
    eq(b.left, want, 'the hint must state how many 搬 remain');
    eq(b.moves.length, want);
    const p = parOf(s, st);
    eq(p.par, b.left);
    eq(p.path[0].off, b.off);
    eq(p.path[0].on, b.on);
    // `off`/`on` are *segment* indices, so they are checked against the segment table — and
    // a hint may neither lift a locked bar nor land a match on one.
    eq(s.segments[b.off].locked, false, 'a hint lifts the equals sign');
    eq(s.segments[b.on].locked, false, 'a hint drops a match onto the equals sign');
    eq(s.cells[s.segments[b.off].cell].locked, false, 'the hinted source cell is locked');
    ok(holds(s, applyMove(s, st, b.off, b.on).next) === (want === 1), 'playing the hint ends the puzzle only at depth 1');
  }
});

test('solve: bestMove follows the player into the middle of a route', () => {
  const s = compileShape(TWO_MOVE.spec);
  let st = paint(TWO_MOVE.spec, TWO_MOVE.from);
  eq(parOf(s, st).par, 2);
  const first = bestMove(s, st);
  st = applyMove(s, st, first.off, first.on).next;
  eq(holds(s, st), false, 'the first step of a two-move route should not finish it');
  eq(parOf(s, st).par, 1, 'after one step of a shortest route exactly one should remain');
  const second = bestMove(s, st);
  const done = applyMove(s, st, second.off, second.on).next;
  ok(holds(s, done), 'playing the hint route must actually solve the puzzle');
  eq(oneMoveSolutions(s, st).length >= 1, true);
});

test('solve: every search function is pure — no board is ever mutated', () => {
  const s = compileShape('dododed');
  const st = paint('dododed', '9 - 4 - 4 = 2');
  const before = Array.from(st);
  const shapeBefore = JSON.stringify({ spec: s.spec, cells: s.cells, segments: s.segments });
  exhaustive1(s, st);
  exhaustive2(s, st);
  search(s, st, { depth: 3 });
  bfs(s, st);
  parOf(s, st);
  bestMove(s, st);
  oneMoveSolutions(s, st);
  eachSuccessor(s, st, () => {});
  eq(Array.from(st), before, 'a search touched the caller board');
  eq(JSON.stringify({ spec: s.spec, cells: s.cells, segments: s.segments }), shapeBefore,
    'a search touched the caller shape');
  // The route objects handed back must be copies too: two calls on the same board may not
  // share a board the caller can walk into.
  const a = parOf(s, st);
  const bState = a.path[0] ? applyMove(s, st, a.path[0].off, a.path[0].on).next : st;
  const b = parOf(s, bState);
  eq(Array.from(st), before, 'a route replayed from a returned path wrote through to the root board');
  ok(b.par === null || b.par + 1 === a.par, `optimal substructure on the returned route: ${a.par} then ${b.par}`);
  eq(Array.from(decode(encode(st))), before, 'encode/decode round-trip is lossless');
});

test('solve: the search never visits an illegal board, over a whole shape space', () => {
  const { shape, boards } = allBoards('doded');
  let checked = 0;
  for (const st of boards) {
    if (legal(shape, st)) continue;
    const b = bfs(shape, st, { deadlineMs: 2000 });
    if (!b.found || !b.complete || b.par === 0) continue;
    const route = b.solutions[0].moves;
    eq(route.length, b.par);
    let cur = st;
    for (const m of route) {
      const p = planMove(shape, cur, m.off, m.on);
      ok(p, 'the route used a non-move');
      eq(legal(shape, p.next), null, `the search routed through an illegal board: ${legal(shape, p.next)}`);
      ok(!CHEAT.equalsIdxs.includes(m.off) && !CHEAT.equalsIdxs.includes(m.on), 'the route used an equals bar');
      cur = p.next;
    }
    ok(holds(shape, cur), 'the route did not end true');
    checked++;
    if (checked > 60) break;
  }
  ok(checked > 40, `only replayed ${checked} routes — the fixture space is too thin`);
});

test('solve: CENSUS — all 2848 legal non-true boards of a op b = R get a complete verdict', () => {
  const { shape, boards } = allBoards('doded');
  const t0 = now();
  const hist = {};
  let total = 0;
  let maxSpace = 0;
  let maxComponent = 0;
  let worstMs = 0;
  for (const st of boards) {
    if (legal(shape, st) || holds(shape, st)) continue;
    total++;
    const r = parOf(shape, st);
    ok(r.complete, `${showState(shape, st)} was not settled: ${r.reason}`);
    ok(r.proof === 'exhaustive-1' || r.proof === 'exhaustive-bfs' || r.proof === null,
      `${showState(shape, st)} carries ${r.proof} into the census`);
    const key = r.par === null ? 'unsolvable' : `par${r.par}`;
    hist[key] = (hist[key] || 0) + 1;
    maxSpace = Math.max(maxSpace, r.cost.depth1.space);
    if (r.cost.bfs) {
      maxComponent = Math.max(maxComponent, r.cost.bfs.states);
      worstMs = Math.max(worstMs, r.cost.bfs.ms);
    }
  }
  const ms = now() - t0;
  eq(total, 2848, 'the legal non-true population of this shape is a fixed, hand-countable number');
  eq(Object.values(hist).reduce((a, b) => a + b, 0), total, 'every board landed in exactly one bucket');
  ok(hist.par1 > 500 && hist.par2 > 500, `the shallow buckets should be crowded: ${JSON.stringify(hist)}`);
  ok(hist.par3 > 100 && hist.par4 > 10 && hist.par5 > 0, `par 3+ must exist in this shape: ${JSON.stringify(hist)}`);
  ok(hist.unsolvable > 500, `a third of this shape has no answer at all: ${JSON.stringify(hist)}`);
  ok(maxSpace < 1000, `depth-1 space stayed small: ${maxSpace}`);
  ok(maxComponent < 400, `the biggest component is ${maxComponent} boards — that is why par 3 is provable`);
  // The whole census is a build-time luxury, not a tap-time one; printed for DESIGN.md.
  console.log(`  [census] ${total} boards in ${ms}ms · ${JSON.stringify(hist)} · max space ${maxSpace}`
    + ` · max component ${maxComponent} · worst sweep ${worstMs}ms`);
  ok(ms < 8000, `the census took ${ms}ms and should stay inside a test budget`);
});

test('solve: the census satisfies optimal substructure, checked independently of the search', () => {
  const { shape, boards } = allBoards('doded');
  const memo = new Map();
  const keyOf = (x) => encode(x);
  const par = (x) => {
    const k = keyOf(x);
    if (memo.has(k)) return memo.get(k);
    const r = parOf(shape, x);
    const v = r.par === null ? Infinity : r.par;
    memo.set(k, v);
    return v;
  };
  let checked = 0;
  for (const st of boards) {
    if (legal(shape, st) || holds(shape, st)) continue;
    const p = par(st);
    if (p === Infinity) continue;
    // Bellman: par(x) must be 1 + min over legal successors. A search that ever believes a
    // route it did not actually look at, or misses one it should have, breaks here.
    let best = Infinity;
    eachSuccessor(shape, st, (next) => { best = Math.min(best, par(next) + 1); });
    eq(best, p, `optimal substructure broken on ${showState(shape, st)}`);
    if (++checked > 400) break;
  }
  ok(checked > 300, `only checked ${checked} boards`);
});

run();
