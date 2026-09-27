// The board model — matchstick arithmetic in one plain, JSON-serialisable shape.
//
//   shape:  { cells: [{ t: 'digit'|'op'|'equals', locked }], ... }
//   state:  one byte per cell, the bitmask of *lit* segments in that cell
//
// A board reads `D op D op D = D`, where a `D` is one or more digit cells and an `op` is
// one operator cell. Every digit cell is a 7-segment grid, every operator cell is a
// 4-segment star (vertical / horizontal / two diagonals), and the `=` cell is two
// horizontal segments that are **locked**: no move may light or extinguish them.
//
// One move (搬) = extinguish exactly one unlocked lit segment and light exactly one
// unlocked dark segment. Total match count is therefore invariant, which is what makes
// "all positions with this many matches" a finite, enumerable space — the whole basis of
// the proofs in solve.js.
//
// Nothing in this file touches DOM, window or canvas: node --test imports it directly.

export const T_DIGIT = 'digit';
export const T_OP = 'op';
export const T_EQUALS = 'equals';

// ---------------------------------------------------------------------------
// Segment geometry, normalised to the cell box (x: 0..1, y: 0..2 for digits).
// ---------------------------------------------------------------------------

// Standard 7-segment code. Bit i of a digit cell's byte is segment i of this table.
export const DIGIT_SEGS = [
  { bit: 0, name: 'a', from: [0, 0], to: [1, 0] },
  { bit: 1, name: 'b', from: [1, 0], to: [1, 1] },
  { bit: 2, name: 'c', from: [1, 1], to: [1, 2] },
  { bit: 3, name: 'd', from: [0, 2], to: [1, 2] },
  { bit: 4, name: 'e', from: [0, 1], to: [0, 2] },
  { bit: 5, name: 'f', from: [0, 0], to: [0, 1] },
  { bit: 6, name: 'g', from: [0, 1], to: [1, 1] },
];

// An operator slot is a 1×1 box parked mid-height inside its cell. Four candidate
// matches: `+` lights v+h, `−` lights h, `×` lights the two diagonals.
export const OP_SEGS = [
  { bit: 0, name: 'v', from: [0.5, 0], to: [0.5, 1] },
  { bit: 1, name: 'h', from: [0, 0.5], to: [1, 0.5] },
  { bit: 2, name: 'p', from: [0, 0], to: [1, 1] },
  { bit: 3, name: 'q', from: [1, 0], to: [0, 1] },
];

// The two bars of `=`. Both are always lit and always locked.
export const EQUALS_SEGS = [
  { bit: 0, name: 't', from: [0, 0.34], to: [1, 0.34] },
  { bit: 1, name: 'b', from: [0, 0.66], to: [1, 0.66] },
];

const SEG_TABLE = { [T_DIGIT]: DIGIT_SEGS, [T_OP]: OP_SEGS, [T_EQUALS]: EQUALS_SEGS };

// ---------------------------------------------------------------------------
// Glyph tables: character <-> segment mask. These two directions must be exact
// inverses of each other — test/board.test.mjs walks every code point both ways.
// ---------------------------------------------------------------------------

export const DIGIT_PATTERN = {
  0: 0b0111111,
  1: 0b0000110,
  2: 0b1011011,
  3: 0b1001111,
  4: 0b1100110,
  5: 0b1101101,
  6: 0b1111101,
  7: 0b0000111,
  8: 0b1111111,
  9: 0b1101111,
};

// Model-side operator characters are ASCII; `OP_SHOW` is what the board prints.
export const OP_PATTERN = { '+': 0b0011, '-': 0b0010, x: 0b1100 };
export const OP_SHOW = { '+': '+', '-': '\u2212', x: '\u00d7' }; // + − ×

const PATTERN_DIGIT = invert(DIGIT_PATTERN);
const PATTERN_OP = invert(OP_PATTERN);

function invert(table) {
  const out = {};
  for (const [ch, p] of Object.entries(table)) out[p] = ch;
  return out;
}

export const EQUALS_PATTERN = 0b11;

export function patternFor(type, ch) {
  if (type === T_DIGIT) return DIGIT_PATTERN[ch] === undefined ? null : DIGIT_PATTERN[ch];
  if (type === T_OP) return OP_PATTERN[ch] === undefined ? null : OP_PATTERN[ch];
  if (type === T_EQUALS) return ch === '=' ? EQUALS_PATTERN : null;
  return null;
}

export function glyphFor(type, pattern) {
  if (type === T_DIGIT) return PATTERN_DIGIT[pattern] === undefined ? null : PATTERN_DIGIT[pattern];
  if (type === T_OP) return PATTERN_OP[pattern] === undefined ? null : PATTERN_OP[pattern];
  if (type === T_EQUALS) return pattern === EQUALS_PATTERN ? '=' : null;
  return null;
}

// ---------------------------------------------------------------------------
// Shape compilation
// ---------------------------------------------------------------------------

// A shape spec is compact text: `d` is a digit cell, `o` an operator cell, `e` the
// (locked) equals cell. `'ddod o e dd'` — whitespace is layout only and is ignored, so
// `"ddodoedd"` and `"dd od oe dd"` compile to the same board.
export function compileShape(spec) {
  const cells = [];
  const segments = [];
  const text = [];
  let digitsRun = 0;
  const flushRun = () => {
    // Cell *indices*, not cells: the operand table is walked as `state[ci]` everywhere.
    if (digitsRun) text.push({ kind: 'num', cells: cells.slice(-digitsRun).map((c) => c.i) });
    digitsRun = 0;
  };
  for (const ch of String(spec)) {
    const type = ch === 'd' ? T_DIGIT : ch === 'o' ? T_OP : ch === 'e' ? T_EQUALS : null;
    if (!type) continue;
    // Close the running number *before* this cell exists, so `cells.slice(-digitsRun)`
    // still ends on the last digit of that operand.
    if (type !== T_DIGIT && digitsRun) flushRun();
    const locked = type === T_EQUALS;
    const table = SEG_TABLE[type];
    const base = segments.length;
    const cell = {
      i: cells.length,
      t: type,
      locked,
      segCount: table.length,
      segBase: base,
    };
    for (const s of table) {
      segments.push({
        i: base + s.bit, cell: cell.i, bit: s.bit, name: s.name, locked,
        from: s.from.slice(), to: s.to.slice(),
      });
    }
    cells.push(cell);
    if (type === T_DIGIT) digitsRun++;
    else if (type === T_EQUALS) text.push({ kind: 'equals' });
    else text.push({ kind: 'op', cells: [cell.i] });
  }
  flushRun();
  const shape = {
    spec: String(spec).replace(/\s+/g, ''),
    cells,
    segments,
    n: cells.length,
    segCount: segments.length,
    lockMask: Uint8Array.from(segments.map((s) => (s.locked ? 1 : 0))),
    text,
    operands: text.filter((p) => p.kind === 'num'),
    ops: text.filter((p) => p.kind === 'op'),
    equalsAt: text.findIndex((p) => p.kind === 'equals'),
  };
  // Layout metric the view uses: how wide the board is in digit-cell units.
  shape.widthUnits = cells.reduce((a, c) => a + (c.t === T_DIGIT ? 1 : c.t === T_EQUALS ? 1.1 : 0.9), 0);
  shape.operandCount = shape.operands.length;
  if (!shape.operands.length || shape.equalsAt < 0) throw new Error(`shape ${shape.spec} has nothing to compare`);
  // LHS operands are everything before the `=`; the RHS is what follows.
  shape.lhsOperands = shape.text.slice(0, shape.equalsAt).filter((p) => p.kind === 'num').length;
  shape.rhsOperands = shape.operands.length - shape.lhsOperands;
  if (shape.rhsOperands !== 1) throw new Error('this game has exactly one right-hand side');
  return shape;
}

// Every digit cell gets its pattern; the locked equals cell gets its two bars.
export function blankState(shape) {
  return Uint8Array.from(shape.cells.map((c) => (c.locked ? EQUALS_PATTERN : 0)));
}

export function encode(state) {
  let s = '';
  for (let i = 0; i < state.length; i++) s += String.fromCharCode(state[i]);
  return s;
}

export function decode(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

// Text-safe serialisation for `js/data/lots.js`. Raw `encode()` bytes need JSON escaping
// and are unreadable in a diff; two hex digits per cell are both. One implementation, used
// by the bake step *and* by the reader, so a re-proof cannot be looking at a different
// encoding than the one that was written.
export function encodeHex(state) {
  let s = '';
  for (let i = 0; i < state.length; i++) s += state[i].toString(16).padStart(2, '0');
  return s;
}

export function decodeHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2) throw new Error('bad hex state');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(v)) throw new Error('bad hex state');
    out[i] = v;
  }
  return out;
}

export function clone(state) {
  return Uint8Array.from(state);
}

// ---------------------------------------------------------------------------
// Segment bookkeeping
// ---------------------------------------------------------------------------

export function isLit(state, seg) {
  return (state[seg.cell] & (1 << seg.bit)) !== 0;
}

export function litSegments(shape, state) {
  const out = [];
  for (const s of shape.segments) if (isLit(state, s)) out.push(s);
  return out;
}

export function darkSegments(shape, state) {
  const out = [];
  for (const s of shape.segments) if (!isLit(state, s)) out.push(s);
  return out;
}

export function countLit(state) {
  let n = 0;
  for (let i = 0; i < state.length; i++) n += popcount(state[i]);
  return n;
}

export function popcount(x) {
  let n = 0;
  let v = x;
  while (v) { n += v & 1; v >>= 1; }
  return n;
}

// The two sets a move may choose from. Locked segments are in *neither*: that is the
// "you cannot steal a match from the equals sign" rule, enforced once, here, at the only
// place the search ever looks.
//
// `deny` is a search-time extra lock (see solve.js): segment indices to treat as if they
// were the equals sign. It exists so a test can remove one candidate segment and watch a
// *complete* enumeration go silent — proof that the enumeration really is exhaustive.
export function pickableSegments(shape, state, deny) {
  const out = [];
  for (const s of shape.segments) {
    if (!s.locked && (!deny || !deny.has(s.i)) && isLit(state, s)) out.push(s);
  }
  return out;
}

export function droppableSegments(shape, state, deny) {
  const out = [];
  for (const s of shape.segments) {
    if (!s.locked && (!deny || !deny.has(s.i)) && !isLit(state, s)) out.push(s);
  }
  return out;
}

export function moveSpace(shape, state, deny) {
  const off = pickableSegments(shape, state, deny);
  const on = droppableSegments(shape, state, deny);
  return { off: off.length, on: on.length, combos: off.length * on.length };
}

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

// Per-cell glyph check plus the two board-wide rules: no leading zero on a multi-digit
// operand, and the equals sign intact. Returns null when legal, else a reason string.
export function cellError(shape, state, ci) {
  const cell = shape.cells[ci];
  if (cell.locked) {
    return state[ci] === EQUALS_PATTERN ? null : '等号段被移动了';
  }
  return glyphFor(cell.t, state[ci]) === null ? `位置 ${ci} 不是合法字形` : null;
}

export function leadingZeroOperands(shape, state) {
  const bad = [];
  for (const op of shape.operands) {
    if (op.cells.length > 1 && glyphFor(T_DIGIT, state[op.cells[0]]) === '0') bad.push(op.cells[0]);
  }
  return bad;
}

export function lockedIntact(shape, state) {
  for (const c of shape.cells) {
    if (!c.locked) continue;
    if (state[c.i] !== EQUALS_PATTERN) return false;
  }
  return true;
}

export function legal(shape, state) {
  if (state.length !== shape.n) return '状态长度与版面不符';
  if (!lockedIntact(shape, state)) return '等号段被移动了';
  for (let i = 0; i < shape.n; i++) {
    const err = cellError(shape, state, i);
    if (err) return err;
  }
  const lz = leadingZeroOperands(shape, state);
  if (lz.length) return `前导零（位置 ${lz.join(',')}）`;
  return null;
}

// The same question without building a reason string or an array: used by the search on
// every one of the millions of boards it touches. Must agree with `legal` — asserted
// against it in test/board.test.mjs.
export function legalQuick(shape, state) {
  if (state.length !== shape.n) return false;
  const cells = shape.cells;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.locked) {
      if (state[i] !== EQUALS_PATTERN) return false;
    } else if (c.t === T_DIGIT) {
      if (PATTERN_DIGIT[state[i]] === undefined) return false;
    } else if (PATTERN_OP[state[i]] === undefined) return false;
  }
  for (const o of shape.operands) {
    if (o.cells.length > 1 && state[o.cells[0]] === DIGIT_PATTERN[0]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Arithmetic — deliberately independent of the search above.
//
// Policy (DESIGN.md 2.4, asserted by test/board.test.mjs):
//   * `×` binds tighter than `+` and `−`;
//   * `+` and `−` run left to right, no reassociation;
//   * the running total may never go negative: `3 − 5 + 4` is an *illegal board*, not a
//     board worth −(-2). Primary-school subtraction is the only arithmetic this game
//     claims to know, so the evaluator must not invent signed intermediates to rescue it;
//   * the equation holds when both sides are defined and equal.
// ---------------------------------------------------------------------------

export function operandValues(shape, state) {
  const nums = [];
  for (const part of shape.operands) {
    let text = '';
    let value = 0;
    for (const ci of part.cells) {
      const g = glyphFor(T_DIGIT, state[ci]);
      if (g === null) return null;
      text += g;
      value = value * 10 + Number(g);
    }
    nums.push({ text, value, cells: part.cells });
  }
  return nums;
}

export function operatorNames(shape, state) {
  const ops = [];
  for (const part of shape.ops) {
    const g = glyphFor(T_OP, state[part.cells[0]]);
    if (g === null) return null;
    ops.push(g);
  }
  return ops;
}

// Returns { ok, lhs, rhs, intermediates } or { ok:false, reason }.
//
// Two-level scan: `term` is the product chain being built, `total` is everything already
// flushed into it, `sign` says how the open term joins. That is the whole precedence
// story — `×` extends `term`, `+`/`−` close it.
export function evaluate(shape, state) {
  const nums = operandValues(shape, state);
  const ops = operatorNames(shape, state);
  if (!nums || !ops) return { ok: false, reason: 'illegal-glyph' };
  const lhsCount = shape.lhsOperands;
  if (ops.length !== lhsCount - 1) return { ok: false, reason: '算符与操作数不匹配' };
  let total = 0;
  let sign = 1;
  let term = nums[0].value;
  const intermediates = [term];
  for (let i = 0; i < ops.length; i++) {
    const next = nums[i + 1].value;
    if (ops[i] === 'x') {
      term *= next;
      if (term < 0) return { ok: false, reason: 'negative' };
    } else {
      total += sign * term;
      if (total < 0) return { ok: false, reason: 'negative' };
      sign = ops[i] === '+' ? 1 : -1;
      term = next;
    }
    intermediates.push(total + sign * term);
  }
  total += sign * term;
  if (total < 0) return { ok: false, reason: 'negative' };
  const rhs = nums[lhsCount].value;
  return { ok: true, lhs: total, rhs, intermediates, nums, ops };
}

// A board is "true" when it is legal, has no negative intermediate, and both sides match.
export function holds(shape, state) {
  if (legal(shape, state)) return false;
  return equationTrue(shape, state);
}

// The search's hot predicate: the arithmetic only, allocation-free, and it assumes the
// caller already established legality (eachSuccessor filters). `evaluate` above is the
// readable reference version; test/board.test.mjs asserts the two never disagree.
export function equationTrue(shape, state) {
  const operands = shape.operands;
  const ops = shape.ops;
  const lhs = shape.lhsOperands;
  let total = 0;
  let sign = 1;
  let term = 0;
  for (let i = 0; i < lhs; i++) {
    let v = 0;
    for (const ci of operands[i].cells) {
      const g = PATTERN_DIGIT[state[ci]];
      if (g === undefined) return false;
      v = v * 10 + (g.charCodeAt(0) - 48);
    }
    if (i === 0) { term = v; continue; }
    const op = PATTERN_OP[state[ops[i - 1].cells[0]]];
    if (op === undefined) return false;
    if (op === 'x') {
      term *= v;
      if (term < 0) return false;
    } else {
      total += sign * term;
      if (total < 0) return false;
      sign = op === '+' ? 1 : -1;
      term = v;
    }
  }
  total += sign * term;
  if (total < 0) return false;
  let r = 0;
  for (const ci of operands[lhs].cells) {
    const g = PATTERN_DIGIT[state[ci]];
    if (g === undefined) return false;
    r = r * 10 + (g.charCodeAt(0) - 48);
  }
  return r === total;
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

// What one move does to two cells: exactly one bit cleared in `offCell`, exactly one set
// in `onCell` (or one of each in the same cell). Null when the pair is not a move at all
// (same segment, locked segment, already lit / already dark).
export function planMove(shape, state, offIdx, onIdx) {
  if (offIdx === onIdx) return null;
  const a = shape.segments[offIdx];
  const b = shape.segments[onIdx];
  if (a.locked || b.locked) return null;
  if (!isLit(state, a)) return null;
  if (isLit(state, b)) return null;
  const from = state[a.cell];
  const next = Uint8Array.from(state);
  next[a.cell] = from & ~(1 << a.bit);
  if (a.cell === b.cell) {
    const mid = next[a.cell];
    next[b.cell] = mid | (1 << b.bit);
  } else {
    next[b.cell] = next[b.cell] | (1 << b.bit);
  }
  return { off: offIdx, on: onIdx, offCell: a.cell, onCell: b.cell, next };
}

// Every successor of `state` that is a legal *board* (glyphs, leading zeros, lock). The
// caller decides whether it is also true. cb(next, plan).
//
// Returns the tally in three bands, because the completeness proof is priced differently
// at each one: `space` is the |lit| x |dark| product the spec talks about, `plans` are the
// pairs that are even structurally a move, `states` are those that survive the glyph and
// leading-zero filter.
export function eachSuccessor(shape, state, cb, opts = {}) {
  const deny = opts.deny || null;
  const off = pickableSegments(shape, state, deny);
  const on = droppableSegments(shape, state, deny);
  const tally = { space: off.length * on.length, plans: 0, states: 0 };
  for (const a of off) {
    for (const b of on) {
      const plan = planMove(shape, state, a.i, b.i);
      if (!plan) continue;
      tally.plans++;
      if (!legalQuick(shape, plan.next)) continue;
      tally.states++;
      cb(plan.next, plan);
    }
  }
  return tally;
}

// How many board-legal one-move successors there are, and what it cost to find them.
export function successorCount(shape, state, deny) {
  return eachSuccessor(shape, state, () => {}, { deny });
}

// Enumerate successors without the legality filter — used by the tests to show that the
// filter is doing real work.
export function rawSuccessors(shape, state, deny) {
  const off = pickableSegments(shape, state, deny);
  const on = droppableSegments(shape, state, deny);
  const out = [];
  for (const a of off) {
    for (const b of on) {
      const plan = planMove(shape, state, a.i, b.i);
      if (plan) out.push(plan);
    }
  }
  return out;
}

// The player-facing entry point: apply a requested move, refusing anything the rules
// forbid. Never mutates `state`.
export function applyMove(shape, state, offIdx, onIdx) {
  const a = shape.segments[offIdx];
  const b = shape.segments[onIdx];
  if (!a || !b) return { ok: false, reason: '没有这一段' };
  if (a.locked || b.locked) return { ok: false, reason: '等号段是锁死的，不能搬也不能放' };
  if (offIdx === onIdx) return { ok: false, reason: '原地不动不算一手' };
  if (!isLit(state, a)) return { ok: false, reason: '那根火柴本来就不在' };
  if (isLit(state, b)) return { ok: false, reason: '那个位置已经有一根了' };
  const plan = planMove(shape, state, offIdx, onIdx);
  if (!plan) return { ok: false, reason: '这不是一个合法的搬法' };
  const err = legal(shape, plan.next);
  if (err) return { ok: false, reason: err };
  return { ok: true, next: plan.next, plan };
}

// The segment a pointer is holding, if it grabbed a live, unlocked match.
export function pickAt(shape, state, segIdx) {
  const s = shape.segments[segIdx];
  if (!s || s.locked || !isLit(state, s)) return null;
  return s;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export function showState(shape, state) {
  let out = '';
  for (const part of shape.text) {
    if (part.kind === 'num') {
      for (const ci of part.cells) out += glyphFor(T_DIGIT, state[ci]) ?? '?';
      out += ' ';
    } else if (part.kind === 'op') {
      const g = glyphFor(T_OP, state[part.cells[0]]);
      out += (g ? OP_SHOW[g] : '?') + ' ';
    } else out += '= ';
  }
  return out.trim();
}

// Where a matchstick's two ends sit, in cell-normalised units. The view multiplies these
// by its own pixel geometry, and `tools/playtest.mjs` presses exactly these points through
// the view so a real mouse can pick a match up by its end.
export function segmentEnds(shape, segIdx) {
  const s = shape.segments[segIdx];
  if (!s) return null;
  const table = SEG_TABLE[shape.cells[s.cell].t];
  return {
    i: s.i, cell: s.cell, bit: s.bit, locked: !!s.locked,
    from: table[s.bit].from.slice(), to: table[s.bit].to.slice(),
  };
}
