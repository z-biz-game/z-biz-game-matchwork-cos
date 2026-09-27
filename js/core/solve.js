// The proof layer. Everything this game prints about difficulty comes out of here, and
// the claim being defended is narrow and checkable: for par 1 and par 2 the number is a
// *complete enumeration*, not an estimate, and the cost of that enumeration is reported
// alongside it.
//
//   par = 1  <=>  some board one move away is true. "No shorter solution exists" is empty
//                 — a move always changes the board, so par can never be 0 — which is what
//                 makes depth 1 provable for free.
//   par = 2  <=>  the depth-1 product returns 0 solutions (complete) AND the depth-2 sweep
//                 returns >= 1 (complete: every legal two-move sequence was looked at).
//   par = 3  <=>  the same story one layer further out. Enumerating that layer as a nested
//                 |lit| x |dark| product is the wrong shape for it (the frontier multiplies),
//                 so `bfs` sweeps the *component* of legal boards instead: legality prunes
//                 about thirty to one, a whole component is 10 to a few thousand boards, and
//                 the sweep completes in milliseconds. `cost.bfs` prints exactly that number
//                 for every shipped lot. When a sweep does run out of budget the result is
//                 `complete: false`, and no caller may print its par — see `parOf` and
//                 DESIGN.md 1.3.
//
// Cost accounting, printed rather than assumed: depth 1 is |lit| x |dark| pairs. Depth 2
// in the worst case is that squared, so the frontier is deduped per layer — a repeated
// intermediate board has exactly the same continuations as its first visit, so dedup is
// sound for "reachable in <= d moves" — and `combos` counts the edges actually examined.
//
// Pure functions; `state` is never mutated. This module reads no browser global of any
// kind — `now()` below goes through `performance` only when one happens to exist — so
// `node --test` can import it directly. See DESIGN.md 2.4.

import {
  eachSuccessor, equationTrue, encode, moveSpace, pickableSegments, droppableSegments,
  planMove, legal,
} from './board.js';

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

const round = (x) => Math.round(x * 100) / 100;

// `deny` is a search-time extra lock: those segment indices may be neither picked up nor
// landed on, exactly as if they were the equals sign. It exists so a test can take a
// puzzle whose construction we know, forbid the one segment the construction used, and
// watch a *complete* enumeration go silent — the evidence that "exhaustive" is not a
// decoration.
function denySet(deny) {
  if (!deny) return null;
  if (deny instanceof Set) return deny;
  return new Set(deny);
}

// ---------------------------------------------------------------------------
// Depth 1: the whole `{lit} x {dark}` product. No queue, no cleverness — this is the
// layer whose completeness is the repo's headline claim, so it is written as two for
// loops you can read in one glance.
// ---------------------------------------------------------------------------

export function exhaustive1(shape, state, opts = {}) {
  const t0 = now();
  const deny = denySet(opts.deny);
  const space = moveSpace(shape, state, deny);
  const off = pickableSegments(shape, state, deny);
  const on = droppableSegments(shape, state, deny);
  const solutions = [];
  let plans = 0;
  let legalStates = 0;
  for (const a of off) {
    for (const b of on) {
      const plan = planMove(shape, state, a.i, b.i);
      if (!plan) continue;
      plans++;
      const err = legal(shape, plan.next);
      if (err) continue;
      legalStates++;
      if (equationTrue(shape, plan.next)) {
        solutions.push({ moves: [plan], next: plan.next, off: a.i, on: b.i });
      }
    }
  }
  return {
    depth: 1,
    solutions,
    n: solutions.length,
    space: space.combos,
    off: space.off,
    on: space.on,
    plans,
    legalStates,
    complete: true,
    truncatedBy: null,
    ms: round(now() - t0),
  };
}

// ---------------------------------------------------------------------------
// Depth 2 and beyond: layered, deduped per layer, budget-limited.
// ---------------------------------------------------------------------------

// search(shape, state, { depth, maxPairs, maxCombos, deadlineMs }) ->
//   { found, depth, solutions, pairs, expansions, combos, frontier, complete,
//     truncatedBy, ms }
//
// `pairs` is what the enumeration is actually priced in: every |lit| x |dark| segment pair
// the search looked at, including the ones the legality filter threw away. `combos` counts
// only the board-legal edges it walked. `found: false, complete: true` is the proof that
// nothing within `depth` moves solves the board; `complete: false` means the budget ran
// out, which is the only other answer this function is allowed to give.
//
// Budgets are read with an explicit undefined test, never `||`: `maxPairs: 0` has to mean
// "you may not look at a single pair", and `opts.maxPairs || Infinity` turns that into "no
// budget at all", which is the difference between a truncated sweep admitting it and one
// silently reporting `complete: true` on a zero budget. `test/solve.test.mjs` pins this.
export function search(shape, state, opts = {}) {
  const t0 = now();
  const budget = (v, d) => (v === undefined || v === null ? d : v);
  const depth = budget(opts.depth, 2);
  const maxPairs = budget(opts.maxPairs, Infinity);
  const maxCombos = budget(opts.maxCombos, Infinity);
  const deadline = budget(opts.deadlineMs, Infinity);
  const deny = denySet(opts.deny);

  const states = [state];
  const parent = [-1];
  const via = [null];
  const visited = new Set([encode(state)]);
  let layerStart = 0;
  let layerEnd = 1;
  let combos = 0;
  let pairs = 0;
  let expansions = 0;
  let truncatedBy = null;

  for (let d = 1; d <= depth; d++) {
    const seen = new Set();
    const found = [];
    for (let i = layerStart; i < layerEnd; i++) {
      if (truncatedBy) break;
      if (pairs >= maxPairs || combos >= maxCombos) {
        truncatedBy = pairs >= maxPairs ? 'pairs' : 'combos';
        break;
      }
      if (now() - t0 > deadline) { truncatedBy = 'time'; break; }
      expansions++;
      const tally = eachSuccessor(shape, states[i], (next, plan) => {
        combos++;
        if (equationTrue(shape, next)) {
          found.push({ at: i, plan });
          return;
        }
        if (d === depth) return; // nothing left to prove on the last layer
        const key = encode(next);
        if (visited.has(key) || seen.has(key)) return;
        seen.add(key);
        states.push(next);
        parent.push(i);
        via.push(plan);
      }, { deny });
      pairs += tally.space;
    }
    for (const key of seen) visited.add(key);
    if (found.length) {
      const solutions = found.map((f) => ({ moves: rebuild(parent, via, f.at, f.plan), off: f.plan.off, on: f.plan.on }));
      return {
        found: true,
        depth: d,
        solutions,
        pairs,
        expansions,
        combos,
        frontier: states.length,
        complete: true,
        truncatedBy: null,
        ms: round(now() - t0),
      };
    }
    layerStart = layerEnd;
    layerEnd = states.length;
    if (layerStart === layerEnd) break; // the legal-board graph is exhausted
  }
  return {
    found: false,
    depth,
    solutions: [],
    pairs,
    expansions,
    combos,
    frontier: states.length,
    complete: !truncatedBy,
    truncatedBy,
    ms: round(now() - t0),
  };
}

// Walk the parent indices back to the root: a search that never allocates a path per
// state can still hand one back when it finds something.
function rebuild(parent, via, at, plan) {
  const out = [plan];
  for (let i = at; parent[i] >= 0; i = parent[i]) out.push(via[i]);
  return out.reverse();
}

export function exhaustive2(shape, state, opts = {}) {
  return search(shape, state, { ...opts, depth: 2 });
}

// ---------------------------------------------------------------------------
// The full sweep: BFS over the *component* of legal boards reachable from a state.
// ---------------------------------------------------------------------------

// This is what makes par 3 provable rather than estimated. The nested product enumeration
// costs |lit| x |dark| per visited board (typically ~500), but only ~15 of those pairs
// produce a legal board at all — the glyph and leading-zero rules prune the graph by a
// factor of thirty — so a whole component is 10 to a few thousand states and the sweep
// finishes in milliseconds. Measured, printed, and re-checked by test/solve.test.mjs.
//
// Minimality argument: every state at depth d is generated (and therefore tested for
// truth) while expanding depth d-1, before any depth-d state is expanded. So the first
// layer that yields a true board is the shortest one, and finishing that layer costs
// nothing extra — it gives the count of distinct shortest routes.
//
// Budget semantics: `maxStates` is tested *before each expansion*, so the state list may
// overshoot the cap by the successors of the last board the sweep agreed to expand. It
// bounds the work, not the memory; `expansions` is the field that provably stays below it
// (a board can only be expanded once it is already in the list), and `test/solve.test.mjs`
// holds the sweep to exactly that.
export function bfs(shape, state, opts = {}) {
  const t0 = now();
  const budget = (v, d) => (v === undefined || v === null ? d : v);
  const deny = denySet(opts.deny);
  const limit = budget(opts.maxStates, 200000);
  const deadline = budget(opts.deadlineMs, 20000);
  if (holdsNow(shape, state)) {
    return {
      found: true, par: 0, solutions: [], states: 1, pairs: 0, expansions: 0,
      complete: true, truncatedBy: null, layerFinished: true, ms: 0,
    };
  }
  const states = [state];
  const parent = [-1];
  const via = [null];
  const visited = new Set([encode(state)]);
  let layerStart = 0;
  let layerEnd = 1;
  let pairs = 0;
  let expansions = 0;
  let truncatedBy = null;

  for (let d = 1; ; d++) {
    const found = [];
    for (let i = layerStart; i < layerEnd; i++) {
      if (truncatedBy) break;
      if (states.length >= limit) { truncatedBy = 'states'; break; }
      if (now() - t0 > deadline) { truncatedBy = 'time'; break; }
      expansions++;
      const tally = eachSuccessor(shape, states[i], (next, plan) => {
        const key = encode(next);
        if (equationTrue(shape, next)) found.push({ at: i, plan });
        if (visited.has(key)) return;
        visited.add(key);
        states.push(next);
        parent.push(i);
        via.push(plan);
      }, { deny });
      pairs += tally.space;
    }
    if (found.length) {
      return {
        found: true,
        par: d,
        solutions: found.map((f) => ({ moves: rebuild(parent, via, f.at, f.plan), off: f.plan.off, on: f.plan.on })),
        states: states.length,
        pairs,
        expansions,
        // `par` is exact whenever this returns at all: every layer above d-1 was swept whole
        // before a single state of it was expanded, so no shorter route can have been missed.
        // What a cut-short layer *does* invalidate is the route count below it — `solutions`
        // is then a lower bound on how many shortest routes there are, never an exact count.
        complete: true,
        truncatedBy: null,
        layerFinished: !truncatedBy,
        ms: round(now() - t0),
      };
    }
    layerStart = layerEnd;
    layerEnd = states.length;
    // Budget first, verdict second. Running out of states is *not* the same observation as
    // having looked at all of them, and reading the two the same way is how a starved sweep
    // ends up certifying a puzzle unsolvable.
    if (truncatedBy) break;
    if (layerStart === layerEnd) {
      // The component is exhausted and no board in it is true: this one cannot be fixed
      // by any number of 搬. That is a proof of *unsolvability*, not a timeout.
      return {
        found: false, par: null, solutions: [], states: states.length, pairs, expansions,
        complete: true, truncatedBy: null, unsolvable: true, ms: round(now() - t0),
      };
    }
  }
  return {
    found: false, par: null, solutions: [], states: states.length, pairs, expansions,
    complete: false, truncatedBy, ms: round(now() - t0),
  };
}

function holdsNow(shape, state) {
  return legal(shape, state) === null && equationTrue(shape, state);
}

// ---------------------------------------------------------------------------
// The one call the generator and the bake step make.
// ---------------------------------------------------------------------------

// parOf(shape, state, opts) ->
//   { par, complete, proof, n1, n2, path, solutions, states, cost }
//     | { par: null, reason, complete, proof: null, path: [], solutions: [], cost }
//
// Every branch answers the same fields, so a caller may read `r.path` without first asking
// whether the sweep succeeded — a refusal hands back an empty route, not `undefined`.
//
// `proof` is a statement about what was finished, and it is the only difficulty label the
// game is allowed to print:
//   'already-true'    — the board handed in already holds, so par is 0 and there is nothing
//                       to measure. The census's Bellman check asks for exactly this.
//   'exhaustive-1'    — the depth-1 product enumeration found a fix. Nothing shorter can
//                       exist because a 搬 always changes the board, so par >= 1 is free.
//   'exhaustive-bfs'  — depth 1 came back empty (complete) and the full component sweep
//                       found the first true board at layer `par`, having exhausted every
//                       layer above it. This covers par 2, 3 and anything deeper.
//   par: null         — either unsolvable (the component was exhausted, which is a proof)
//                       or unknown (budget). `reason` says which: 'unsolvable' when the sweep
//                       ran whole and no board holds, `sweep-<budget>` when it was cut short.
//                       There is no third label: a starved sweep has found *nothing*, so it
//                       has a length to withhold rather than a length to doubt.
//
// `cost` carries the price of each layer so the bake can print a measured boundary:
// `space` is |lit| x |dark| at the root, `pairs` is that summed over every board the sweep
// touched, and `n2` is the count of distinct two-move routes. Inside `cost.bfs`,
// `layerFinished: false` means the sweep answered in the middle of a layer: `par` is still
// exact (every shallower layer was whole), but `solutions` and `nAtPar` are then a *lower
// bound* on how many shortest routes there are — which is why `bake.mjs` re-proves every row
// on a budget that lets the layer finish instead of trusting the generator's run.
export function parOf(shape, state, opts = {}) {
  // A board that is already true has no route to measure. It still gets an answer, because
  // the census's optimal-substructure check asks for the par of the *successors* it walked
  // into, and half of those are solved boards: the answer is 0, not a failed sweep.
  if (holdsNow(shape, state)) {
    return {
      par: 0, complete: true, proof: 'already-true', n1: 0, n2: null, nAtPar: 0,
      path: [], solutions: [], states: 1, cost: { depth1: { space: 0, plans: 0, legalStates: 0, ms: 0 } },
    };
  }
  const e1 = exhaustive1(shape, state, { deny: opts.deny });
  const cost = { depth1: { space: e1.space, plans: e1.plans, legalStates: e1.legalStates, ms: e1.ms } };
  if (e1.n) {
    return {
      par: 1,
      complete: true,
      proof: 'exhaustive-1',
      n1: e1.n,
      n2: null,
      path: e1.solutions[0].moves,
      solutions: e1.solutions,
      cost,
    };
  }
  const b = bfs(shape, state, {
    deny: opts.deny,
    maxStates: opts.maxStates,
    deadlineMs: opts.deadlineMs === undefined ? 20000 : opts.deadlineMs,
  });
  cost.bfs = {
    states: b.states, pairs: b.pairs, expansions: b.expansions, par: b.par,
    complete: b.complete, ms: b.ms, truncatedBy: b.truncatedBy, layerFinished: b.layerFinished,
  };
  // The truncation check comes **first**: a sweep that stopped because it hit its state cap
  // has not exhausted the component, so it has proved neither a route nor its absence, and
  // 'unsolvable' from a starved search is the one label this function must never print.
  //
  // Note there is deliberately no "upper bound only" outcome here. `bfs` reports a par the
  // moment a layer yields a true board, and minimality is already settled by then (all
  // shallower layers were swept whole), so a sweep that runs out of budget has by
  // construction found *nothing* — it has a length to withhold, not a length to doubt. The
  // honest answer is therefore `par: null, complete: false`, which `make.js` refuses and
  // `tools/bake.mjs` throws on. An earlier version carried a third label, `partial-proof`,
  // that no path through this function could ever return: a label with no transition into it
  // is a ghost, and it is gone.
  if (!b.complete) {
    return {
      par: null, complete: false, proof: null,
      reason: `sweep-${b.truncatedBy || 'budget'}`, n1: 0, n2: null, nAtPar: 0,
      path: [], solutions: [], states: b.states, cost,
    };
  }
  if (b.unsolvable) {
    return {
      par: null, complete: true, proof: null, reason: 'unsolvable', n1: 0, n2: null, nAtPar: 0,
      path: [], solutions: [], states: b.states, cost,
    };
  }
  // Independent cross-check on the two-move claim: the nested product sweep is a different
  // algorithm over the same rules, and it is cheap enough to always run. When par is 2 it
  // must find routes; when par is 3 or more it must come back empty and complete.
  const e2 = search(shape, state, {
    depth: 2, deny: opts.deny, maxPairs: opts.maxPairs2 || 4e7, deadlineMs: opts.deadlineMs2 || 20000,
  });
  cost.depth2 = { pairs: e2.pairs, combos: e2.combos, expansions: e2.expansions, found: e2.found, complete: e2.complete, ms: e2.ms };
  const agrees = b.par === 2 ? (e2.found && e2.complete) : (!e2.found && e2.complete);
  if (!agrees) {
    throw new Error(`two independent sweeps disagree: bfs says par ${b.par}, depth-2 product says ${e2.found ? 'a route exists' : 'none'} (complete ${e2.complete})`);
  }
  return {
    par: b.par,
    complete: true,
    proof: 'exhaustive-bfs',
    n1: 0,
    n2: b.par === 2 ? b.solutions.length : e2.solutions.length,
    nAtPar: b.solutions.length,
    path: b.solutions[0].moves,
    solutions: b.solutions,
    states: b.states,
    cost,
  };
}

// The next move of a shortest route, for the hint button. Depth 1 first (it is the cheap
// complete product enumeration), then the full sweep, which is what makes a hint honest on
// a par 3 board. Returns null when no route exists inside the budget at all — the UI must
// then say so rather than invent one.
export function bestMove(shape, state, opts = {}) {
  // Nothing to hint about: the board already holds. Without this guard the sweep below
  // returns par 0 with an empty solution list and `solutions[0]` throws on the caller.
  if (holdsNow(shape, state)) return null;
  const e1 = exhaustive1(shape, state, { deny: opts.deny });
  if (e1.n) {
    return { moves: e1.solutions[0].moves, off: e1.solutions[0].off, on: e1.solutions[0].on, left: 1 };
  }
  const b = bfs(shape, state, {
    deny: opts.deny,
    maxStates: opts.maxStates || 60000,
    deadlineMs: opts.deadlineMs === undefined ? 4000 : opts.deadlineMs,
  });
  if (b.found && b.complete) {
    const first = b.solutions[0].moves[0];
    return { moves: b.solutions[0].moves, off: first.off, on: first.on, left: b.par };
  }
  return null;
}

// Every one-move solution, for the "本题一根搬法的解有几条" readout.
export function oneMoveSolutions(shape, state) {
  return exhaustive1(shape, state).solutions;
}
