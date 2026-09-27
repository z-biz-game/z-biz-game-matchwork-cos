// Hand-written fixtures. Nothing here is computed by the code under test: the boards are
// painted by reading an intended equation off a string, and every *expectation* (14, 1,
// "refused", the stolen-bar board) was worked out with pencil and paper before any solver
// existed. That is the point — a precedence bug in js/core/board.js cannot hide by
// re-deriving these numbers from itself.
//
// If you change a number in this file, you are changing the rules of the game, not the test.
//
// Exported fixtures: paint / MATCHES / EVAL_FIXTURES / REFUSED / LEADING_ZERO / CHEAT /
// ONE_MOVE / TWO_MOVE / THREE_MOVE / UNSOLVABLE / allBoards.

import { compileShape, DIGIT_PATTERN, OP_PATTERN, EQUALS_PATTERN } from '../js/core/board.js';

// paint('3 + 5 = 9') over spec 'doded' -> Uint8Array of per-cell segment masks.
//
// Cell letters and glyphs are matched positionally: `d` takes the next digit character,
// `o` the next operator (`x`/× for multiply, `-`/− for minus), `e` the equals. A mismatch
// throws — a fixture that silently paints a different board than its comment claims is
// worse than no fixture at all.
export function paint(spec, text) {
  const shape = compileShape(spec);
  const glyphs = String(text).replace(/\s+/g, '').replace(/=/g, '=').split('');
  if (shape.cells.length !== glyphs.length) {
    throw new Error(`fixture ${spec} / "${text}": ${shape.cells.length} cells but ${glyphs.length} glyphs`);
  }
  const out = new Uint8Array(shape.cells.length);
  shape.cells.forEach((cell, i) => {
    const ch = glyphs[i];
    if (cell.t === 'digit') {
      if (DIGIT_PATTERN[ch] === undefined) throw new Error(`fixture digit "${ch}" is not in the table`);
      out[i] = DIGIT_PATTERN[ch];
    } else if (cell.t === 'op') {
      const key = ch === '×' ? 'x' : ch === '−' ? '-' : ch;
      if (OP_PATTERN[key] === undefined) throw new Error(`fixture operator "${ch}" is not in the table`);
      out[i] = OP_PATTERN[key];
    } else {
      if (ch !== '=') throw new Error('the equals cell only ever holds =');
      out[i] = EQUALS_PATTERN;
    }
  });
  return out;
}

// The match-count of a glyph table, written out so the arithmetic in the comments below can
// be checked without opening board.js: 0:6 1:2 2:5 3:5 4:4 5:5 6:6 7:3 8:7 9:6, +:2 −:1 ×:2, =:2.
export const MATCHES = {
  digit: {
    0: 6, 1: 2, 2: 5, 3: 5, 4: 4, 5: 5, 6: 6, 7: 3, 8: 7, 9: 6,
  },
  op: { '+': 2, '-': 1, x: 2 },
  equals: 2,
};

// ---------------------------------------------------------------------------
// Evaluator fixtures. Expected values are arithmetic done by hand.
//   spec, board, expected lhs, expected rhs, holds?, why this one is here
// ---------------------------------------------------------------------------

export const EVAL_FIXTURES = [
  ['doded', '2 + 3 = 5', 5, 5, true, 'the smallest additive case'],
  ['dododedd', '2 + 3 x 4 = 14', 14, 14, true, '× binds tighter: 2 + (3*4) = 14, never (2+3)*4 = 20'],
  ['dododedd', '2 x 3 + 4 = 10', 10, 10, true, 'product on the left of a sum: (2*3) + 4'],
  ['dododed', '9 - 4 - 4 = 1', 1, 1, true, 'left-to-right chain: (9-4)-4 = 1'],
  ['dododed', '9 - 4 + 4 = 9', 9, 9, true, 'chain that turns back up: (9-4)+4 = 9'],
  ['dododed', '8 - 2 x 3 = 2', 2, 2, true, '8 - (2*3) = 2, not (8-2)*3 = 18'],
  ['dododed', '2 + 3 x 2 = 8', 8, 8, true, 'left-to-right would say 10'],
  ['dododedd', '2 x 3 x 4 = 24', 24, 24, true, 'a pure product chain'],
  ['dododed', '6 x 2 - 3 = 9', 9, 9, true, 'product flushed by a later minus'],
  ['dododed', '1 + 1 + 1 = 3', 3, 3, true, 'three terms, no reassociation'],
  ['dododed', '9 - 4 - 4 = 2', 1, 2, false, 'the same chain, wrong answer'],
  ['dododedd', '3 + 5 x 6 = 33', 33, 33, true, 'two-digit right side'],
  ['ddododedd', '12 + 3 x 4 = 24', 24, 24, true, 'two-digit left operand with precedence'],
  ['dodododedd', '1 + 2 + 3 x 4 = 15', 15, 15, true, 'four operands: 1+2+(3*4)'],
  ['doded', '7 x 0 = 0', 0, 0, true, 'zero is a legal single-digit operand'],
  ['doded', '2 + 3 = 6', 5, 6, false, 'the arithmetic has to be able to say no'],
];

// Boards the evaluator must refuse outright, with the reason it must give.
export const REFUSED = [
  ['dododed', '3 - 5 + 4 = 2', 'negative', '3-5 goes below zero before the +4 arrives'],
  ['dododed', '1 - 9 + 9 = 1', 'negative', 'the same trap with different digits'],
  ['dododed', '5 - 9 x 1 = 4', 'negative', 'the minus is flushed before the product is read'],
];

// Multi-digit operands may not start with 0. `05 = 5` is a board of legal *glyphs* and an
// illegal *number*, which is exactly why the rule needs its own test.
export const LEADING_ZERO = [
  ['dded', '05 = 5'],
  ['ddoded', '05 + 3 = 8'],
  ['dodded', '0 + 05 = 5'],
];

// ---------------------------------------------------------------------------
// The equals-sign attack, worked out by hand.
//
//   3 + 5 = 9   the puzzle (false)
//   3 + 5 = 8   the cheat: the 9 gains segment e (bit 4) and becomes an 8, paid for by
//               extinguishing the *lower bar of the equals sign*.
//
// Hand check of the glyphs: 9 = 0b1101111 is missing exactly bit 4; bit 4 set gives
// 0b1111111 = 8. And 3 + 5 = 8 is true arithmetic. `equationTrue` only reads operand cells,
// so it will happily call the cheated board true — which is precisely why the lock lives in
// the move generator *and* in `legal`. Two independent layers, both asserted.
//
// Segment index arithmetic for 'doded', counted off the cell table by hand: cell0 digit
// owns 0..6, cell1 operator owns 7..10, cell2 digit owns 11..17, cell3 equals owns 18..19,
// cell4 digit owns 20..26. So the lower bar is index 19 and the 9's e segment is 20+4 = 24.
// ---------------------------------------------------------------------------

export const CHEAT = {
  spec: 'doded',
  puzzle: '3 + 5 = 9',
  cheated: [
    DIGIT_PATTERN[3],
    OP_PATTERN['+'],
    DIGIT_PATTERN[5],
    EQUALS_PATTERN & ~0b10, // 0b01: one bar left
    DIGIT_PATTERN[9] | 0b10000, // 0b1111111: an 8
  ],
  offIdx: 19,
  onIdx: 24,
  equalsCell: 3,
  equalsIdxs: [18, 19],
};

// ---------------------------------------------------------------------------
// A par-1 puzzle for the "remove the clue" refutation, hand-checked.
//
//   0 + 3 = 9   false (0 + 3 = 3)
//   6 + 3 = 9   true, and reached by exactly one 搬: cell 0's upper-right bar (segment b,
//               bit 1) is lifted and laid across the middle (segment g, bit 6), turning the
//               0 (0b0111111) into a 6 (0b1111101). Those are the only two bits that differ,
//               so it is one move, and 6 + 3 = 9 is arithmetic.
//
// The exhaustive depth-1 product finds exactly this one and no other (`n1 === 1`), so
// denying segment 1 makes a *complete* enumeration go silent — see test/solve.test.mjs.
// ---------------------------------------------------------------------------

export const ONE_MOVE = {
  spec: 'doded',
  from: '0 + 3 = 9',
  to: '6 + 3 = 9',
  offIdx: 1,
  onIdx: 6,
};

// A par-2 puzzle, hand-checked move by move.
//
//   0 + 0 = 1   eighteen matches (6+2+6+2+2). The depth-1 product finds no fix — the test
//               re-counts all 320 pairs itself — but this two-step route works, and every
//               step was verified against the glyph table by hand:
//                 step 1, segment 4 -> 6:  the 0's lower-left bar (e) moves across the
//                   middle (g), turning 0b0111111 into 0b1101111 = 9. Board: 9 + 0 = 1.
//                 step 2, segment 7 -> 17: the '+' loses its vertical bar (bit 0 of the
//                   operator cell) and becomes '−'; the second 0 (cell 2 starts at segment
//                   11, so 17 is its g) gains a middle bar and becomes 8. Board: 9 − 8 = 1.
//               9 − 8 = 1 is arithmetic. Two 搬, no shorter way: par = 2.
export const TWO_MOVE = {
  spec: 'doded',
  from: '0 + 0 = 1',
  route: [{ off: 4, on: 6 }, { off: 7, on: 17 }],
  wayPoints: ['9 + 0 = 1', '9 − 8 = 1'],
  totalMatches: MATCHES.digit[0] + MATCHES.op['+'] + MATCHES.digit[0] + MATCHES.equals + MATCHES.digit[1],
};

// A par-3 puzzle, hand-checked move by move — this is the fixture that makes "the number is
// searched, not configured" testable, because a 3-搬 route is far too long for any plausible
// heuristic to guess and its component is tiny (19 boards), so the full sweep is exhaustive.
//
//   0 + 4 = 2   nineteen matches (6+2+4+2+5). Neither of the two shallow layers holds a fix:
//               depth 1 is empty (the test re-counts the whole product) and depth 2 is empty
//               and *complete* (the independent nested-product sweep), which together prove
//               there is no route of length 1 or 2. This three-step route works, each step
//               read off the glyph table by hand against 'doded' segment bases
//               (cell0 digit 0..6, cell1 operator 7..10, cell2 digit 11..17, cell3 equals
//               18..19, cell4 digit 20..26):
//                 step 1, 1 -> 6:   cell 0 loses b and gains g, so 0b0111111 -> 0b1111101,
//                   i.e. 0 becomes 6. Board: 6 + 4 = 2.
//                 step 2, 24 -> 22: the answer digit loses e (bit 4) and gains c (bit 2), so
//                   0b1011011 -> 0b1001111, i.e. 2 becomes 3 — 2 and 3 differ in exactly
//                   those two bits. Board: 6 + 4 = 3.
//                 step 3, 4 -> 25:  cell 0 loses e (125 -> 109, that is 6 becomes 5) and the
//                   answer digit gains f (79 -> 111, that is 3 becomes 9).
//                   Board: 5 + 4 = 9, which is arithmetic.
//               Match count along the way: 19 -> 19 -> 19, as any 搬 requires.
export const THREE_MOVE = {
  spec: 'doded',
  from: '0 + 4 = 2',
  route: [{ off: 1, on: 6 }, { off: 24, on: 22 }, { off: 4, on: 25 }],
  wayPoints: ['6 + 4 = 2', '6 + 4 = 3', '5 + 4 = 9'],
  totalMatches: MATCHES.digit[0] + MATCHES.op['+'] + MATCHES.digit[4] + MATCHES.equals + MATCHES.digit[2],
};

// A board with no solution at all, with a proof you can do on the back of an envelope.
//
//   1 − 1 = 1   nine matches (2+1+2+2+2). A 搬 never changes the total, so every board
//               reachable from here also has nine, i.e. the three digits and the operator
//               share seven (the two locked bars always take the other two). The cheapest
//               legal digit is 1 with two matches, so three digits cost at least six:
//                 * operator = '−' (1 match) → digits total exactly 6 → all three are 1 →
//                   the board is `1 − 1 = 1`, which is false;
//                 * operator = '+' or '×' (2 matches) → digits total 5 < 6 → impossible.
//               So `1 − 1 = 1` is the *only* legal board with nine matches, and it has no
//               legal successor: the reachable component is one board and it is not true.
//               The BFS is expected to report exactly this (`unsolvable`, `states: 1`), and
//               the test re-runs the counting argument over the whole glyph space.
export const UNSOLVABLE = {
  spec: 'doded',
  from: '1 - 1 = 1',
  matches: MATCHES.digit[1] + MATCHES.op['-'] + MATCHES.digit[1] + MATCHES.equals + MATCHES.digit[1],
};

// Every board of a shape, as encoded states — the fixture-side enumerator used by the
// census assertions. Deliberately dumb: nested loops over glyph tables.
export function allBoards(spec) {
  const shape = compileShape(spec);
  const opts = shape.cells.map((c) => {
    if (c.t === 'digit') return Object.keys(DIGIT_PATTERN).map((d) => DIGIT_PATTERN[d]);
    if (c.t === 'op') return Object.values(OP_PATTERN);
    return [EQUALS_PATTERN];
  });
  const out = [];
  const cur = new Uint8Array(shape.cells.length);
  const rec = (i) => {
    if (i === shape.cells.length) { out.push(Uint8Array.from(cur)); return; }
    for (const v of opts[i]) { cur[i] = v; rec(i + 1); }
  };
  rec(0);
  return { shape, boards: out };
}

export default { paint, MATCHES, EVAL_FIXTURES, REFUSED, LEADING_ZERO, CHEAT, ONE_MOVE, TWO_MOVE, THREE_MOVE, UNSOLVABLE, allBoards };
