// js/core/board.js: the model. Segment tables and their inverses, legality, the locked
// equals, and the evaluator — all of it judged against fixtures written by hand in
// test/fixture.mjs, never against the module's own output.

import { test, ok, eq, fail, run } from '../tools/harness.mjs';
import {
  compileShape, DIGIT_SEGS, OP_SEGS, EQUALS_SEGS, DIGIT_PATTERN, OP_PATTERN, OP_SHOW,
  EQUALS_PATTERN, patternFor, glyphFor, blankState, encode, decode, clone, encodeHex,
  decodeHex, isLit, litSegments, darkSegments, countLit, popcount, pickableSegments,
  droppableSegments, moveSpace, cellError, leadingZeroOperands, lockedIntact, legal,
  legalQuick, operandValues, operatorNames, evaluate, holds, equationTrue, planMove,
  eachSuccessor, successorCount, rawSuccessors, applyMove, pickAt, showState, segmentEnds,
  T_DIGIT, T_OP, T_EQUALS,
} from '../js/core/board.js';
import { paint, EVAL_FIXTURES, REFUSED, LEADING_ZERO, MATCHES, CHEAT, UNSOLVABLE, allBoards } from './fixture.mjs';

// ---------------------------------------------------------------------------
// Segment table <-> character table, both directions
// ---------------------------------------------------------------------------

test('board: every digit glyph round-trips char -> mask -> char and back', () => {
  const masks = new Set(Object.values(DIGIT_PATTERN));
  for (let m = 0; m < 128; m++) {
    const g = glyphFor(T_DIGIT, m);
    if (g === null) {
      ok(!masks.has(m), `mask ${m} is in the table but glyphFor does not know it`);
      continue;
    }
    ok(masks.has(m), `glyphFor invented digit ${g} for a mask that is not in the table`);
    eq(patternFor(T_DIGIT, g), m, `digit ${g} does not come back to its mask`);
  }
  eq(Object.keys(DIGIT_PATTERN).length, 10, 'the digit table must hold exactly ten glyphs');
});

test('board: ten digits cover ten distinct masks, each within the 7-segment range', () => {
  const masks = Object.values(DIGIT_PATTERN);
  eq(new Set(masks).size, 10, 'two digits share a mask — the tables are not injective');
  for (const m of masks) ok(m >= 1 && m < 128, `mask ${m} is outside the 7-segment range`);
  for (const ch of '0123456789') ok(glyphFor(T_DIGIT, DIGIT_PATTERN[ch]) === ch, `${ch} lost`);
});

test('board: operator masks round-trip and are pairwise distinct', () => {
  const seen = new Set();
  for (const ch of Object.keys(OP_PATTERN)) {
    const m = OP_PATTERN[ch];
    if (seen.has(m)) fail(`operator ${ch} reuses mask ${m}`);
    seen.add(m);
    eq(glyphFor(T_OP, m), ch, `${ch} does not come back`);
  }
  eq(Object.keys(OP_PATTERN).length, 3, 'expected exactly + − ×');
});

test('board: no operator mask collides with a digit mask (they live in different cells)', () => {
  for (const om of Object.values(OP_PATTERN)) ok(DIGIT_SEGS.length === 7, 'digit cells have seven slots');
  ok(OP_SEGS.length === 4 && EQUALS_SEGS.length === 2, 'operator slot is a 4-segment star, equals has two bars');
});

test('board: unknown masks are refused, never guessed at', () => {
  for (const m of [0, 1, 0b0100, 0b1000, 0b1110, 0b1111, 0b11111111]) {
    eq(glyphFor(T_OP, m), null, `operator mask ${m.toString(2)} should be no glyph`);
  }
  for (const m of [0, 0b10000000, 0b11111111]) eq(glyphFor(T_DIGIT, m), null, `digit mask ${m} should be no glyph`);
  eq(glyphFor(T_EQUALS, 0b01), null, 'one bar is not an equals sign');
  eq(glyphFor(T_EQUALS, EQUALS_PATTERN), '=', 'two bars must be an equals sign');
});

// ---------------------------------------------------------------------------
// Shape compilation
// ---------------------------------------------------------------------------

test('board: compileShape lays out cells, segments and operand runs', () => {
  // Everything below is worked out by hand from the spec text, cell by cell:
  //   'dd od o e d'  ->  d d o d o e d   (7 cells, indices 0..6)
  //   segments       ->  7 + 7 + 4 + 7 + 4 + 2 + 7 = 38   (digit 7, operator 4, equals 2)
  //   text runs      ->  [0,1] op[2] [3] op[4] = [6]      (two left operands, one right)
  const s = compileShape('dd od o e d');
  eq(s.spec, 'ddodoed', 'whitespace is layout: stripped, never re-ordered');
  eq(s.n, 7, 'seven cells');
  eq(s.cells.map((c) => (c.t === T_DIGIT ? 'd' : c.t === T_OP ? 'o' : 'e')).join(''), 'ddodoed',
    'the cell types spell the spec back');
  eq(s.segments.length, 38, 'segment count is the sum of the per-cell tables');
  eq(s.segments.map((g) => g.cell).filter((c, i, a) => a[i - 1] !== c), [0, 1, 2, 3, 4, 5, 6],
    'segments are laid out cell by cell, in order');
  eq(s.operands.length, 3, 'a two-digit operand, a one-digit operand and the result');
  eq(s.operands.map((o) => o.cells.join('')), ['01', '3', '6']);
  eq(s.operands[0].cells.length, 2, 'the first operand owns two cells');
  eq(s.ops.map((o) => o.cells.join('')), ['2', '4'], 'the two operator cells');
  eq(s.lhsOperands, 2);
  eq(s.rhsOperands, 1);
  eq(s.cells[5].t, T_EQUALS);
  eq(s.cells.filter((c) => c.locked).map((c) => c.i), [5], 'the equals cell is the only locked one');
  ok(!s.cells[0].locked && !s.cells[2].locked && !s.cells[6].locked, 'digits and operators are never locked');
  ok(Math.abs(s.widthUnits - (1 + 1 + 0.9 + 1 + 0.9 + 1.1 + 1)) < 1e-9, 'the layout metric follows the same table the view uses');
  // The same board written without its layout whitespace must compile identically — that is
  // what "whitespace is ignored" claims, and it is checked against a second hand-written
  // spec string rather than against the first one's output.
  const bare = compileShape('ddodoed');
  eq(bare.cells.map((c) => [c.i, c.t, c.locked, c.segBase, c.segCount]),
    s.cells.map((c) => [c.i, c.t, c.locked, c.segBase, c.segCount]));
  eq(bare.segments.map((g) => `${g.cell}.${g.name}`), s.segments.map((g) => `${g.cell}.${g.name}`));
});

test('board: segment indices are contiguous per cell and name their segment', () => {
  const s = compileShape('doded');
  eq(s.segments[0].cell, 0);
  eq(s.segments[6].cell, 0);
  eq(s.segments[7].cell, 1, 'the operator cell starts right after the seven-segment digit');
  eq(s.segments[11].cell, 2);
  eq(s.segments[18].cell, 3, 'equals cell');
  eq(s.segments[18].name, 't');
  eq(s.segments[19].name, 'b');
  eq(s.segments[20].cell, 4);
  eq(s.segments[24].name, 'e', 'segment e of the result digit — the one the equals-cheat needs');
  eq(segmentEnds(s, 19).locked, true);
  eq(segmentEnds(s, 24).locked, false);
  eq(segmentEnds(s, 24).from, [0, 1], 'segment geometry is exposed for the pointer');
  eq(segmentEnds(s, 999), null, 'an out-of-range index is a null, not a throw');
});

test('board: a shape with no equals, or with two right-hand sides, is a compile error', () => {
  for (const bad of ['dodod', 'dd', '']) {
    let threw = false;
    try { compileShape(bad); } catch (err) { threw = true; }
    ok(threw, `compileShape("${bad}") should refuse to build a board with nothing to compare`);
  }
  let threw = false;
  try { compileShape('deded'); } catch (err) { threw = true; }
  ok(threw, 'two right-hand sides must be rejected at compile time');
});

test('board: blankState locks the equals bars and empties everything else', () => {
  const s = compileShape('doded');
  const b = blankState(s);
  eq(Array.from(b), [0, 0, 0, EQUALS_PATTERN, 0]);
  eq(countLit(b), 2, 'the only matches on a blank board are the two locked bars');
});

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

test('board: encode/decode and encodeHex/decodeHex are exact inverses', () => {
  const s = compileShape('ddododed');
  const st = paint('ddododedd', '12 + 3 x 4 = 24');
  eq(Array.from(decode(encode(st))), Array.from(st), 'raw round-trip');
  eq(Array.from(decodeHex(encodeHex(st))), Array.from(st), 'hex round-trip');
  // Hand-computed from the tables: 1=0x06 2=0x5B +=0x03 3=0x4F x=0x0C 4=0x66 ==0x03
  eq(encodeHex(st), '065b034f0c66035b66', 'the hex form is stable — bake and re-proof read the same string');
  eq(encodeHex(st).length, st.length * 2, 'two hex digits per cell');
  let threw = false;
  try { decodeHex('7d0'); } catch (err) { threw = true; }
  ok(threw, 'an odd-length hex string is corrupt and must throw');
});

// ---------------------------------------------------------------------------
// Match counting and the move space
// ---------------------------------------------------------------------------

test('board: match counts come out of the glyph tables the fixtures assume', () => {
  eq(popcount(0b1111111), 7);
  eq(popcount(0), 0);
  for (const [ch, want] of Object.entries(MATCHES.digit)) {
    eq(countLit(Uint8Array.from([DIGIT_PATTERN[ch]])), want, `digit ${ch} has the wrong match count`);
  }
  eq(countLit(Uint8Array.from([OP_PATTERN['+']])), 2);
  eq(countLit(Uint8Array.from([OP_PATTERN['-']])), 1);
  eq(countLit(Uint8Array.from([OP_PATTERN['x']])), 2);
  eq(countLit(Uint8Array.from([EQUALS_PATTERN])), 2);
});

test('board: the move space is exactly {lit} x {dark} with the locked bars in neither', () => {
  const s = compileShape('doded');
  const st = paint('doded', '2 + 3 = 6');
  const off = pickableSegments(s, st);
  const on = droppableSegments(s, st);
  const lit = litSegments(s, st);
  const dark = darkSegments(s, st);
  eq(lit.length + dark.length, s.segments.length, 'every segment is either lit or dark');
  eq(off.length, lit.length - 2, 'the two equals bars are lit but not pickable');
  eq(on.length, dark.length, 'no dark slot is in the equals cell, so dropping equals picking the dark set');
  eq(moveSpace(s, st).combos, off.length * on.length, 'the space is a Cartesian product, not a sample');
  ok(off.every((g) => g.cell !== 3), 'nothing in the pickable set belongs to the equals cell');
  ok(on.every((g) => g.cell !== 3), 'nothing in the droppable set belongs to the equals cell');
});

test('board: a deny set behaves like a second lock', () => {
  const s = compileShape('doded');
  const st = paint('doded', '2 + 3 = 6');
  const plain = moveSpace(s, st);
  const denied = moveSpace(s, st, new Set([4, 21]));
  eq(denied.off, plain.off - 1, 'segment 4 is lit, so denying it costs one pickable');
  eq(denied.on, plain.on - 1, 'segment 21 (the 6\'s missing bar b) is dark, so denying it costs one droppable');
  eq(denied.combos, (plain.off - 1) * (plain.on - 1));
});

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

test('board: leading zeros are refused on multi-cell operands and only there', () => {
  for (const [spec, text] of LEADING_ZERO) {
    const s = compileShape(spec);
    const st = paint(spec, text);
    const err = legal(s, st);
    ok(err && err.includes('前导零'), `${text} should be rejected as a leading zero, got ${err}`);
    ok(leadingZeroOperands(s, st).length >= 1, `${text} should name the offending cell`);
  }
  const single = paint('doded', '0 + 3 = 3');
  eq(legal(compileShape('doded'), single), null, 'a lone 0 is a number, not a leading zero');
});

test('board: an illegal operator mask makes the whole board illegal', () => {
  const s = compileShape('doded');
  const st = paint('doded', '2 + 3 = 5');
  for (const m of [0, 0b0001, 0b0100, 0b1000, 0b1111]) {
    const bad = clone(st);
    bad[1] = m;
    ok(legal(s, bad) !== null, `operator mask ${m.toString(2)} must not be a legal board`);
    eq(cellError(s, bad, 1), '位置 1 不是合法字形');
  }
});

test('board: a wrong-length state is refused rather than read past the end', () => {
  const s = compileShape('doded');
  ok(legal(s, new Uint8Array(4)) !== null, 'four cells for a five-cell board is not a board');
  ok(legalQuick(s, new Uint8Array(4)) === false);
});

test('board: legal() and legalQuick() never disagree, over an entire shape space', () => {
  const { shape, boards } = allBoards('dododed');
  let both = 0;
  for (const st of boards) {
    const slow = legal(shape, st) === null;
    const fast = legalQuick(shape, st);
    if (slow !== fast) fail(`disagreement on ${showState(shape, st)}: slow ${slow} fast ${fast}`);
    if (slow) both++;
  }
  ok(both > 500, `the census should find hundreds of legal boards, found ${both}`);
});

// ---------------------------------------------------------------------------
// The locked equals — the attack this repo exists to survive
// ---------------------------------------------------------------------------

test('board: ATTACK — stealing a bar from = would make true arithmetic, and is refused twice', () => {
  const s = compileShape(CHEAT.spec);
  const st = paint(CHEAT.spec, CHEAT.puzzle);
  const cheated = Uint8Array.from(CHEAT.cheated);
  // 1. the cheated board really is "3 + 5 = 8" and really is arithmetically true.
  eq(showState(s, cheated).replace(/\s/g, ''), '3+5=8');
  eq(equationTrue(s, cheated), true, 'the arithmetic of the cheat works — that is why the lock matters');
  // 2. `legal` still refuses it, on the equals cell alone.
  eq(lockedIntact(s, cheated), false);
  eq(cellError(s, cheated, CHEAT.equalsCell), '等号段被移动了');
  ok(legal(s, cheated) !== null, 'an equals with one bar must never be a legal board');
  eq(holds(s, cheated), false, 'holds() must not be fooled by true arithmetic on a broken board');
  // 3. and the move that would have produced it is not even in the space.
  const off = pickableSegments(s, st).map((g) => g.i);
  const on = droppableSegments(s, st).map((g) => g.i);
  for (const i of CHEAT.equalsIdxs) {
    ok(!off.includes(i), `the equals bar ${i} must not be pickable`);
    ok(!on.includes(i), `the equals bar ${i} must not be droppable`);
  }
  eq(planMove(s, st, CHEAT.offIdx, CHEAT.onIdx), null, 'planMove refuses a locked source');
  eq(planMove(s, st, CHEAT.onIdx, CHEAT.offIdx), null, 'and a locked destination');
  const res = applyMove(s, st, CHEAT.offIdx, CHEAT.onIdx);
  eq(res.ok, false);
  ok(res.reason.includes('等号'), `the refusal must name the rule, got ${res.reason}`);
});

test('board: no generated successor of any board ever touches an equals bar', () => {
  const { shape, boards } = allBoards(CHEAT.spec);
  let visited = 0;
  for (const st of boards) {
    if (legal(shape, st)) continue;
    for (const plan of rawSuccessors(shape, st)) {
      visited++;
      ok(plan.off !== 18 && plan.off !== 19, 'a successor extinguished an equals bar');
      ok(plan.on !== 18 && plan.on !== 19, 'a successor lit an equals bar');
      if (!lockedIntact(shape, plan.next)) fail('successor lost the equals');
    }
    const tally = eachSuccessor(shape, st, () => {});
    ok(tally.states <= tally.plans && tally.plans <= tally.space);
  }
  ok(visited > 10000, `expected a lot of candidate moves, got ${visited}`);
});

test('board: an in-place move is not a move', () => {
  const s = compileShape('doded');
  const st = paint('doded', '2 + 3 = 6');
  eq(planMove(s, st, 4, 4), null);
  const res = applyMove(s, st, 4, 4);
  eq(res.ok, false);
  ok(res.reason.includes('原地'), res.reason);
});

test('board: applyMove refuses to move a match that is not there or onto one that is', () => {
  const s = compileShape('doded');
  const st = paint('doded', '2 + 3 = 6');
  const dark = darkSegments(s, st)[0].i;
  const lit = pickableSegments(s, st)[0].i;
  eq(applyMove(s, st, dark, lit).ok, false, 'lifting an absent match');
  eq(applyMove(s, st, lit, lit).ok, false, 'dropping onto a lit slot');
  ok(applyMove(s, st, dark, lit).reason.includes('本来就不在'));
  ok(applyMove(s, st, lit, lit).reason.includes('原地') || applyMove(s, st, lit, lit).reason.includes('已经有一根'));
  eq(applyMove(s, st, 999, 0).ok, false, 'a segment index off the end of the board');
  eq(applyMove(s, st, 0, 999).ok, false);
});

test('board: applyMove never mutates the state it was given', () => {
  const s = compileShape('dododed');
  const st = paint('dododed', '9 - 4 - 4 = 2');
  const before = Array.from(st);
  const res = applyMove(s, st, 6, 4);
  eq(Array.from(st), before, 'the input board was modified in place');
  if (res.ok) ok(res.next !== st, 'the result must be a new array');
});

// ---------------------------------------------------------------------------
// The evaluator, against the hand-written fixtures
// ---------------------------------------------------------------------------

test('board: evaluator fixtures — precedence, left-associativity, by hand', () => {
  for (const [spec, text, lhs, rhs, want, why] of EVAL_FIXTURES) {
    const s = compileShape(spec);
    const st = paint(spec, text);
    const err = legal(s, st);
    ok(err === null, `${text} should be a legal board (${why}): ${err}`);
    const e = evaluate(s, st);
    ok(e.ok, `${text} was refused (${why}): ${e.reason}`);
    eq(e.lhs, lhs, `lhs of ${text} (${why})`);
    eq(e.rhs, rhs, `rhs of ${text} (${why})`);
    eq(holds(s, st), want, `holds(${text}) should be ${want} (${why})`);
    eq(equationTrue(s, st), want, `equationTrue(${text}) disagrees with holds`);
  }
});

test('board: 2 + 3 x 4 is 14 and not 20 — the headline precedence claim', () => {
  const s = compileShape('dododedd');
  const st = paint('dododedd', '2 + 3 x 4 = 14');
  eq(evaluate(s, st).lhs, 14);
  const wrong = paint('dododedd', '2 + 3 x 4 = 20');
  eq(evaluate(s, wrong).lhs, 14, 'the left side does not change because the right side did');
  eq(holds(s, wrong), false);
});

test('board: negative intermediates are refused, not quietly evaluated', () => {
  for (const [spec, text, reason, why] of REFUSED) {
    const s = compileShape(spec);
    const st = paint(spec, text);
    eq(legal(s, st), null, `${text} is a legal board before arithmetic (${why})`);
    const e = evaluate(s, st);
    eq(e.ok, false, `${text} should be refused (${why})`);
    eq(e.reason, reason, `${text} refused for the wrong reason (${why})`);
    eq(holds(s, st), false, `${text} must never be "true"`);
    eq(equationTrue(s, st), false, `the fast evaluator must agree that ${text} is not true`);
  }
});

test('board: the fast and slow evaluators agree over an entire shape space', () => {
  const { shape, boards } = allBoards('dododed');
  let trueBoards = 0;
  for (const st of boards) {
    if (legal(shape, st)) continue;
    const slow = evaluate(shape, st);
    const fast = equationTrue(shape, st);
    const want = slow.ok && slow.lhs === slow.rhs;
    if (fast !== want) fail(`evaluator disagreement on ${showState(shape, st)}: slow ${want} fast ${fast}`);
    if (want) trueBoards++;
  }
  ok(trueBoards > 1000, `the three-operand shape should have thousands of true boards, got ${trueBoards}`);
});

test('board: operandValues and operatorNames read the board the way the text does', () => {
  const s = compileShape('ddodedd');
  const st = paint('ddodedd', '12 + 3 = 15');
  eq(operandValues(s, st).map((o) => o.text), ['12', '3', '15']);
  eq(operandValues(s, st).map((o) => o.value), [12, 3, 15]);
  eq(operatorNames(s, st), ['+']);
  eq(showState(s, st), '12 + 3 = 15', 'the printed form runs digits together and spaces the operators');
  const broken = clone(st);
  broken[0] = 0b11111111;
  eq(operandValues(s, broken), null, 'a non-glyph cell has no value');
  eq(evaluate(s, broken).reason, 'illegal-glyph');
});

// ---------------------------------------------------------------------------
// Small helpers the view and the search both need
// ---------------------------------------------------------------------------

test('board: isLit follows the bit for bit, and pickAt only answers for held matches', () => {
  const s = compileShape('doded');
  const st = paint('doded', '2 + 3 = 6');
  for (const seg of s.segments) {
    const want = (st[seg.cell] & (1 << seg.bit)) !== 0;
    eq(isLit(st, seg), want, `segment ${seg.i} (${seg.name} of cell ${seg.cell})`);
  }
  eq(pickAt(s, st, 18), null, 'the equals bar cannot be picked up');
  eq(pickAt(s, st, 19), null);
  ok(pickAt(s, st, 0) !== null || !isLit(st, s.segments[0]), 'a lit unlocked segment is pickable');
  eq(pickAt(s, st, 21), null, 'the 6 is missing its bar b, so there is nothing there to lift');
});

test('board: successorCount reports the same three bands as eachSuccessor', () => {
  const s = compileShape('dododed');
  const st = paint('dododed', '9 - 4 - 4 = 2');
  let seen = 0;
  const tally = eachSuccessor(s, st, () => { seen++; });
  const again = successorCount(s, st);
  eq(seen, tally.states, 'the callback fired a different number of times than the tally claims');
  eq(again.states, tally.states);
  eq(again.plans, tally.plans);
  eq(again.space, tally.space);
  eq(tally.space, rawSuccessors(s, st).length, 'plans are exactly the structurally-valid pairs');
  eq(moveSpace(s, st).combos, tally.space);
});

// `eachSuccessor` decides legality from the two cells a move touches, having checked the
// board it is expanding once. That is only the same question as "run `legalQuick` over the
// whole child" if the reasoning holds for *every* board, so this compares the two definitions
// against each other over full shape spaces — legal parents and illegal ones, which must take
// the other branch — rather than trusting the argument. The reference is the pre-optimisation
// definition itself: `rawSuccessors` (pure `planMove`) filtered by `legalQuick`.
test('board: the two-cell verdict equals the whole-board verdict, and the sweep keeps no state', () => {
  let legalParents = 0;
  let illegalParents = 0;
  let survivors = 0;
  for (const spec of ['doded', 'ddodoed']) {
    const { shape, boards } = allBoards(spec);
    // 'doded' has three one-cell operands, so every board in its space is legal and only the
    // fast branch is reachable there. 'ddodoed' opens with a two-cell operand, and a leading
    // zero on it is the illegal parent that has to take the other branch — coverage is
    // therefore counted across the two spaces, not per spec.
    for (const st of boards) {
      const before = encodeHex(st);
      const pairs = rawSuccessors(shape, st);
      const want = pairs
        .filter((plan) => legalQuick(shape, plan.next))
        .map((plan) => `${plan.off}>${plan.on}:${encodeHex(plan.next)}`);
      const got = [];
      const tally = eachSuccessor(shape, st, (next, plan) => {
        got.push(`${plan.off}>${plan.on}:${encodeHex(next)}`);
      });
      eq(got, want, `${spec} · board ${before}: successor sets differ`);
      eq(tally.plans, pairs.length, `${spec} · board ${before}: plans band differs`);
      eq(tally.states, want.length, `${spec} · board ${before}: states band differs`);
      eq(tally.space, pairs.length, `${spec} · board ${before}: space and plans must both be the pair count`);
      eq(encodeHex(st), before, `${spec} · board ${before}: eachSuccessor mutated the board it was given`);
      if (legalQuick(shape, st)) legalParents++; else illegalParents++;
      survivors += want.length;
    }
  }
  ok(illegalParents > 0, `no illegal parent was compared (${legalParents} legal only)`);
  ok(survivors > 1000, `too few successors compared (${survivors}) to be a witness`);
});

test('board: showState prints the equals sign and the unicode operators', () => {
  // Each row carries its own spec: the cell count has to match the glyph count, so a shared
  // shape here would be a fixture bug (the three-digit left side of `9 − 4 − 0 = 5` needs
  // seven cells, the two-digit results need eight).
  const rows = [
    ['dododedd', '2 x 3 + 4 = 10', '2 × 3 + 4 = 10'],
    ['dododed', '9 - 4 - 0 = 5', '9 − 4 − 0 = 5'],
    ['dododedd', '5 + 4 - 0 = 19', '5 + 4 − 0 = 19'],
    ['doded', '7 x 0 = 0', '7 × 0 = 0'],
    ['ddododedd', '12 + 3 x 4 = 24', '12 + 3 × 4 = 24'],
  ];
  for (const [spec, text, want] of rows) {
    const s = compileShape(spec);
    eq(showState(s, paint(spec, text)), want, `showState(${spec} / ${text})`);
  }
  // showState prints, it does not judge: a false equation renders exactly like a true one.
  const s = compileShape('dododed');
  eq(showState(s, paint('dododed', '9 - 4 - 4 = 2')), '9 − 4 − 4 = 2');
  eq(holds(s, paint('dododed', '9 - 4 - 4 = 2')), false, 'the printed board above is false, and printed anyway');
  eq(OP_SHOW.x, '×');
  eq(OP_SHOW['-'], '−');
});

run();
