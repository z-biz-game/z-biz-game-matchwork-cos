// The in-progress game: whose turn it is not, but which match is currently pinched between
// your fingers, how many 搬 you have spent, and what the board looks like right now.
//
// This is the only core module that is allowed to *mutate* — a game is a session, not a
// function of its inputs — and it is still forbidden from touching DOM, window or canvas.
// Legality never lives here: every mutation goes through `board.applyMove`, so the rule
// "the two bars of `=` cannot be moved" has exactly one implementation in this repo, and a
// UI bug cannot invent a second one.
//
// Feedback is deliberately thin. A refused move returns a reason string the shell prints
// and nothing else: no "wrong move!", no red flash on the board, and above all no hint
// about whether the move was *on the way* — the route is the puzzle.

import {
  compileShape, decode, clone, isLit, applyMove, showState, countLit, planMove,
  holds, legal, segmentEnds,
} from './board.js';
import { bestMove, exhaustive1 } from './solve.js';

// createGame(lot) -> game
//
// `lot` is a normalised library entry: `{ id, spec, state, par, proof, n1, n2, text }`.
// The state passed in is copied, never adopted, so two games from the same lot cannot
// interfere through a shared typed array.
export function createGame(lot) {
  const shape = lot.shape || compileShape(lot.spec);
  const start = typeof lot.state === 'string' ? decode(lot.state) : clone(lot.state);
  const err = legal(shape, start);
  if (err) throw new Error(`lot ${lot.id} starts on an illegal board: ${err}`);
  if (holds(shape, start)) throw new Error(`lot ${lot.id} is already solved — that is not a puzzle`);

  let current = clone(start);
  let picked = null;
  const history = []; // [{ off, on, from, to }]
  let hints = 0;
  let refusal = null;
  let drags = 0;

  const game = {
    lot: { ...lot, shape },
    shape,
    spec: shape.spec,

    state: () => current,
    text: () => showState(shape, current),
    lit: () => countLit(current),
    moves: () => history.length,
    history: () => history.map((h) => ({ off: h.off, on: h.on })),
    hints: () => hints,
    picked: () => picked,
    refusal: () => refusal,
    solved: () => holds(shape, current),

    // Where the two ends of a match are, in cell units. The view scales these to pixels and
    // the pointer test presses them.
    segmentEnds: (segIdx) => segmentEnds(shape, segIdx),

    // Press on a live, unlocked match. Returns false when there is nothing to hold, which
    // is the honest answer for "you pressed empty space" and for "you pressed the equals
    // sign" — both are no-ops, not errors, and neither costs a move.
    pick(segIdx) {
      const seg = shape.segments[segIdx];
      if (!seg) { refusal = '没有这一段'; return false; }
      if (seg.locked) { refusal = '等号的两根是锁死的：既不能搬走，也不能往上放'; return false; }
      if (!isLit(current, seg)) { refusal = '那一格现在是空的，手里没有东西'; return false; }
      picked = segIdx;
      refusal = null;
      return true;
    },

    drop(segIdx) {
      if (picked === null) { refusal = '先拿起一根，再放到空位上'; return false; }
      return game.apply(picked, segIdx);
    },

    // The one entry point that changes the board. Everything else is a read.
    apply(offIdx, onIdx) {
      const res = applyMove(shape, current, offIdx, onIdx);
      if (!res.ok) {
        refusal = res.reason;
        picked = null;
        return { ok: false, reason: res.reason };
      }
      history.push({ off: offIdx, on: onIdx, from: current, to: res.next });
      current = res.next;
      picked = null;
      refusal = null;
      drags++;
      return { ok: true, solved: holds(shape, current), moves: history.length };
    },

    cancel() {
      picked = null;
      return true;
    },

    // Undo is state replay, not arithmetic: the forward move stored the board it came from.
    undo() {
      if (!history.length) { refusal = '已经是最初的摆法了'; return false; }
      const last = history.pop();
      current = last.from;
      picked = null;
      refusal = null;
      return true;
    },

    restart() {
      current = clone(start);
      history.length = 0;
      picked = null;
      refusal = null;
      return true;
    },

    // A hint costs a counter and reveals exactly one 搬 of a *proved* shortest route — it
    // asks solve.js, so on a par 3 board it cannot offer a two-move shortcut that does not
    // exist, and it cannot lie about there being one. Returns null when no proof is
    // available inside the budget, which the UI must report rather than paper over.
    hint() {
      const b = bestMove(shape, current, { maxStates: 60000, deadlineMs: 4000 });
      if (!b) return null;
      hints++;
      return { off: b.off, on: b.on, left: b.left, moves: b.moves };
    },

    // How many one-搬 fixes exist from here. Par 1 lots print this as their second
    // difficulty dimension, and it is a complete count, not a sample.
    oneMoveFixes() {
      return exhaustive1(shape, current).n;
    },

    // Does the route spent so far actually finish the puzzle? Used at the moment of victory
    // so the shell can print "你在 N 步内完成，最少是 P 步" with both numbers measured.
    grade() {
      const done = holds(shape, current);
      const par = Number.isFinite(game.lot.par) ? game.lot.par : null;
      return {
        solved: done,
        moves: history.length,
        hints,
        par,
        optimal: done && par !== null && history.length === par,
        perfect: done && par !== null && history.length === par && hints === 0,
      };
    },

    stats() {
      return { drags, hints, moves: history.length };
    },

    // Serialise the *session*, so a mid-puzzle board could be restored. Only the moves are
    // stored, never boards: replaying k 搬 from the lot's start is cheaper and cannot drift,
    // because a 搬 is a pure function of the board it is applied to.
    serialize() {
      return { id: lot.id, moves: history.map((h) => ({ off: h.off, on: h.on })), hints };
    },

    // The route you took, verified move by move against the rules — used by the shell to
    // print a truthful "this was a k-搬 solution" and by the tests to prove applyMove and
    // planMove agree.
    //
    // Two things this function has to get right, and the original got both backwards:
    //
    //   * Where the replay starts. It starts from `start`, not from `current`, for the same
    //     reason `serialize()` stores only moves and no boards: a route *is* the walk off the
    //     lot's starting board, and a 搬 is a pure function of the board it is applied to.
    //     Replaying it onto `current` replayed it a second time — after the winning 搬 the
    //     same segments are lit the other way round, so the very first step has nothing to
    //     lift and the walk died immediately.
    //   * Which answer `board.js`'s `legal()` calls illegal. It returns an error *string* when
    //     the board is bad and `null` when it is fine (that is how line 28 above reads it).
    //     `if (!legal(...)) return false` therefore rejected every legitimate step and accepted
    //     every broken one.
    //
    // Together those made the victory gate in js/main.js refuse *every* correct run, so no
    // puzzle could be recorded, no star card appeared, and `npm test` stayed green because no
    // node suite drove a finished session through `verifyRoute` — the browser layer found it.
    verifyRoute(route) {
      let st = clone(start);
      for (const m of route || []) {
        const plan = planMove(shape, st, m.off, m.on);
        if (!plan) return false;
        if (legal(shape, plan.next) !== null) return false;
        st = plan.next;
      }
      return holds(shape, st);
    },
  };

  return game;
}

export { clone };
