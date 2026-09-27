// The generator. There is no hand-authored level file in this repo, and that is
// deliberate: a puzzle is only worth shipping once a complete enumeration has said how
// many moves it takes.
//
// Forward search — "scatter matches, then try to solve" — does not work here. A random
// segment assignment is almost never a legal board (every one of the digit cells must land
// on a real glyph, no leading zeros, no negative intermediate), so the acceptance rate
// collapses to nothing. The chain that does work runs backwards:
//
//   1. build an equation that is **true** (enumerate the left side, ask the evaluator for
//      its value, paint the right side with that value's digits);
//   2. perform 1..k random *legal* 搬 from the true board, requiring at every step that the
//      board stays legal but stops being true;
//   3. measure the result with solve.parOf and keep the puzzle only if the measured par is
//      exactly the band we are filling.
//
// Step 2's walk reversed *is* a k-move solution, so par <= k always holds — the generator
// can never produce an unsolvable puzzle, and `makeLot` throws if the search ever reports
// a bigger number than the construction spent. Whether par is *smaller* than k is exactly
// what the enumeration decides: plenty of k=3 walks land on a one-move fix, and those go
// to the one-move bucket, not the three-move one.
//
// This runs at build time (tools/bake.mjs), not on tap — the per-band cost and acceptance
// rate it measured are printed by the bake and stored verbatim in `BAKE.report`. Nothing in
// the shipped game imports this file.

import {
  compileShape, decode, encode, DIGIT_PATTERN, OP_PATTERN, EQUALS_PATTERN,
  evaluate, legal, holds, eachSuccessor, showState, clone, countLit, pickableSegments,
  droppableSegments,
} from './board.js';
import { parOf } from './solve.js';
import { rngFrom } from './rng.js';

// ---------------------------------------------------------------------------
// Step 1: true equations, by enumeration, judged by the evaluator itself.
// ---------------------------------------------------------------------------

const OP_CHOICES = Object.keys(OP_PATTERN);
const cache = new Map();

// buildTrueEquations('dododed') -> { states: [encoded], enumerated, truncated }
//
// The left side is enumerated as *values* (so a 2-digit operand never gets a leading
// zero); the resulting number's digits are painted into the right side; then `holds` — the
// same evaluator the solver and the UI use — has to agree. This file therefore never
// reimplements precedence or the negative-intermediate rule: it asks, it does not decide.
export function buildTrueEquations(spec, opts = {}) {
  const key = `${spec}|${opts.maxEnum || 0}`;
  if (cache.has(key)) return cache.get(key);
  const shape = compileShape(spec);
  const lhsCount = shape.lhsOperands;
  const operandCells = shape.operands.map((o) => o.cells);
  const opCells = shape.ops.map((o) => o.cells[0]);
  const rhsCells = operandCells[lhsCount];
  const digitCounts = operandCells.slice(0, lhsCount).map((c) => c.length);
  const rhsDigits = rhsCells.length;
  const ranges = digitCounts.map((k) => (k === 1 ? [0, 9] : [10 ** (k - 1), 10 ** k - 1]));
  const maxEnum = opts.maxEnum || 3e6;
  const state = new Array(shape.n).fill(0);
  for (let i = 0; i < shape.n; i++) if (shape.cells[i].locked) state[i] = EQUALS_PATTERN;
  const out = [];
  let enumerated = 0;
  let truncated = false;

  const finish = () => {
    enumerated++;
    if (enumerated > maxEnum) { truncated = true; return; }
    const probe = Uint8Array.from(state);
    const e = evaluate(shape, probe);
    if (!e.ok) return; // negative intermediate / bad glyph — the evaluator's own verdict
    const text = String(e.lhs);
    if (text.length !== rhsDigits) return;
    for (let k = 0; k < rhsDigits; k++) state[rhsCells[k]] = DIGIT_PATTERN[text[k]];
    const done = Uint8Array.from(state);
    if (legal(shape, done) === null && holds(shape, done)) out.push(encode(done));
  };

  const rec = (j) => {
    if (truncated) return;
    if (j === lhsCount) { finish(); return; }
    const cells = operandCells[j];
    const [lo, hi] = ranges[j];
    for (let v = lo; v <= hi; v++) {
      const s = String(v).padStart(cells.length, '0');
      for (let k = 0; k < cells.length; k++) state[cells[k]] = DIGIT_PATTERN[s[k]];
      if (j < lhsCount - 1) {
        for (const op of OP_CHOICES) {
          state[opCells[j]] = OP_PATTERN[op];
          rec(j + 1);
        }
      } else {
        rec(j + 1);
      }
    }
  };

  // Paint the right side with a legal placeholder first: `evaluate` refuses a board whose
  // glyphs are not digits, and a run of zeros is a legal (if ugly) number.
  for (const ci of rhsCells) state[ci] = DIGIT_PATTERN[0];
  rec(0);
  const res = { spec: shape.spec, states: out, enumerated, truncated, shape };
  cache.set(key, res);
  return res;
}

// ---------------------------------------------------------------------------
// Step 2: walk backwards with real moves.
// ---------------------------------------------------------------------------

// One random legal 搬 that keeps the board legal and leaves it *not* true. Returns null at
// a dead end (every one-move neighbour is either illegal or already true).
function wander(shape, state, rng) {
  const options = [];
  eachSuccessor(shape, state, (next, plan) => {
    if (!holds(shape, next)) options.push(plan);
  });
  if (!options.length) return null;
  const plan = rng.pick(options);
  return { next: plan.next, off: plan.off, on: plan.on };
}

// k legal 搬 away from a true board, landing on a board that is not true.
export function construct(shape, trueState, k, rng) {
  let cur = clone(trueState);
  const trail = [];
  const seen = new Set([encode(cur)]);
  for (let step = 0; step < k; step++) {
    const w = wander(shape, cur, rng);
    if (!w) return null;
    if (seen.has(encode(w.next))) return null; // do not step back onto a visited board
    seen.add(encode(w.next));
    cur = w.next;
    trail.push({ off: w.off, on: w.on });
  }
  if (holds(shape, cur)) return null;
  return { state: cur, trail };
}

// ---------------------------------------------------------------------------
// Step 3: measure, and only then decide what we have.
// ---------------------------------------------------------------------------

// makeLot(seed, tier, stats?) -> { spec, state, par, proof, ... } | null
export function makeLot(seed, tier, stats) {
  const hit = (k) => { if (stats) stats[k] = (stats[k] || 0) + 1; };
  const rng = rngFrom(`${tier.key}|${seed}`);
  const attempts = tier.attempts || 40;
  for (let a = 0; a < attempts; a++) {
    const spec = tier.shapes[a % tier.shapes.length];
    const pool = buildTrueEquations(spec, { maxEnum: tier.maxEnum });
    if (pool.truncated) hit('enumTruncated');
    if (!pool.states.length) { hit('noTrueEquation'); continue; }
    const trueState = decode(rng.pick(pool.states));
    const k = tier.k[0] + rng.int(tier.k[1] - tier.k[0] + 1);
    const built = construct(pool.shape, trueState, k, rng);
    if (!built) { hit('walkDeadEnd'); continue; }
    if (countLit(built.state) !== countLit(trueState)) {
      throw new Error('a 搬 changed the match count — the model is broken');
    }
    const m = parOf(pool.shape, built.state, {
      maxStates: tier.maxStates,
      deadlineMs: tier.deadlineMs,
      maxPairs2: tier.maxPairs2,
      deadlineMs2: tier.deadlineMs2,
    });
    if (m.par === null) { hit(m.reason || 'unmeasured'); continue; }
    // The construction promise, checked rather than trusted: the reversed walk is a
    // k-move solution, so a search that reports a *longer* par has lost the plot.
    if (m.par > k) {
      throw new Error(`par ${m.par} exceeds the ${k}-move construction — impossible by design`);
    }
    if (!m.complete) { hit('incompleteProof'); continue; }
    if (m.par !== tier.par) { hit(`par${m.par}`); continue; }
    const atPar = m.solutions ? m.solutions.length : m.n1;
    if (tier.n1 && !within(m.n1, tier.n1)) { hit('n1Band'); continue; }
    if (tier.rich && !within(atPar, tier.rich)) { hit('richBand'); continue; }
    if (stats) {
      stats.found = (stats.found || 0) + 1;
      stats.lastCost = m.cost;
    }
    return {
      seed,
      tier: tier.key,
      spec: pool.spec,
      shape: pool.shape,
      state: built.state,
      trail: built.trail,
      k,
      par: m.par,
      proof: m.proof,
      complete: m.complete,
      n1: m.n1,
      n2: m.n2 === null || m.n2 === undefined ? null : Math.min(m.n2, 9999),
      nAtPar: atPar,
      states: m.states === undefined ? null : m.states,
      path: m.path,
      cost: m.cost,
      text: showState(pool.shape, built.state),
      truth: showState(pool.shape, trueState),
      lit: countLit(built.state),
      segments: pool.shape.segCount,
      off: pickableSegments(pool.shape, built.state).length,
      on: droppableSegments(pool.shape, built.state).length,
    };
  }
  if (stats) stats.gaveUp = (stats.gaveUp || 0) + 1;
  return null;
}

function within(n, [lo, hi]) {
  return n >= lo && n <= hi;
}

// The generation ladder. `par` is the band the *search* has to land in, not a label: a
// lot whose measured par is 2 goes to a 2 band or nowhere, and a band that cannot fill is
// a bug we want to see, not something to paper over by widening the band.
//
// Four bands, three of them a genuinely different puzzle: par 1 with exactly one fix,
// par 1 with several, par 2, par 3. Every one of those numbers is a *complete* enumeration
// (`proof: 'exhaustive-1'` or `'exhaustive-bfs'`), which is the whole point of this repo —
// see DESIGN.md 1.3 for the measured sweep sizes behind the par 3 band.
// Shape vocabulary, in cell letters (`d` digit, `o` operator, `e` the locked equals):
//   doded        a op b = R
//   dododed      a op b op c = R
//   dodododed    a op b op c op d = R
//   ddododed     aa op b op c = R
//   dododedd     a op b op c = RR
//   ddodododed   aa op b op c op d = R
export const TIERS = [
  {
    key: 'single', label: '单挑', par: 1, k: [1, 1], n1: [1, 1],
    shapes: ['dododed', 'ddododed', 'dododedd'],
    attempts: 120,
  },
  {
    key: 'splay', label: '多解', par: 1, k: [1, 2], n1: [2, 6],
    shapes: ['doded', 'dododed', 'dodododed'],
    attempts: 120,
  },
  {
    key: 'setup', label: '布局', par: 2, k: [2, 2], rich: [1, 24],
    shapes: ['dododed', 'dododedd', 'ddododed'],
    attempts: 120,
  },
  {
    key: 'tangle', label: '缠绕', par: 3, k: [3, 3], rich: [1, 8],
    shapes: ['dododedd', 'ddododed', 'dodododed'],
    attempts: 200,
  },
  {
    key: 'deep', label: '深水', par: 3, k: [3, 4], rich: [8, 64],
    shapes: ['ddodododed', 'dodododed', 'dododedd'],
    attempts: 240,
  },
];
