// Canvas renderer + pointer handling. This file owns pixels and gestures and decides
// nothing about legality: it reads the board (`isLit`, `segment.locked` are facts about the
// state, not judgements about a move) and on release it hands `main.js` an
// (off, on) segment pair. js/core/board.js is the only place that says whether that pair is
// a legal 搬, so a rendering bug can never invent a rule.
//
// Everything is drawn: the matches, the digits, the operator stars, the felt they lie on.
// There is no image asset in this repo, and the matchstick endpoints are exposed through
// `segmentEnds()` so a real mouse event — or tools/playtest.mjs driving one — can press the
// end of a specific stick instead of guessing at a grid cell.

import { isLit, T_DIGIT, T_EQUALS } from './core/board.js';

const PAD = 26;
const MATCH = 0.11;         // match thickness, in units of one digit width
const HEAD = 0.2;           // match head radius, same scale
const GRAB = 0.42;          // how close a pointer has to be to a slot to count as aiming

const FELT = '#1d1a16';
const SLOT = 'rgba(236, 229, 218, 0.09)';
const SLOT_HOT = 'rgba(120, 180, 255, 0.55)';
const SLOT_LOCK = 'rgba(200, 86, 60, 0.30)';
const STICK = '#d8cdb8';
const STICK_HOT = '#f4e7c8';
const HEAD_A = '#c8563c';
const HEAD_B = '#a33f2b';
const HELD = '#ffe9b0';
const HINT = 'rgba(111, 174, 122, 0.9)';
const BAD = 'rgba(200, 86, 60, 0.95)';

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

// Distance from a point to a segment, used to decide which slot the pointer means.
function distToSeg(px, py, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len = vx * vx + vy * vy || 1;
  let t = ((px - a.x) * vx + (py - a.y) * vy) / len;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * vx), py - (a.y + t * vy));
}

export function createView(canvas, { onPick, onCommit, onRelease } = {}) {
  const ctx = canvas.getContext('2d');
  let game = null;
  let geom = { unit: 30, ox: 20, oy: 20, vw: 320, vh: 200, box: [] };
  let drag = null;   // { i, from: {x,y}, x, y, target }
  let hintPair = null; // { off, on, until }
  let badSeg = null; // { i, until }
  let raf = 0;
  let last = 0;

  // --------------------------------------------------------------------------
  // Geometry: cell -> pixels, once per resize.
  // --------------------------------------------------------------------------

  function cellWidth(type, unit) {
    return unit * (type === T_DIGIT ? 1 : type === T_EQUALS ? 1.1 : 0.9);
  }

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    const W = Math.max(200, Math.round(box.width || 320));
    const H = Math.max(140, Math.round(box.height || 240));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    geom.vw = W;
    geom.vh = H;
    if (!game) { draw(); return; }
    const shape = game.shape;
    let units = 0;
    for (const c of shape.cells) units += (c.t === T_DIGIT ? 1 : c.t === T_EQUALS ? 1.1 : 0.9);
    const gapUnits = Math.max(0, shape.cells.length - 1) * 0.16;
    const unit = Math.max(14, Math.floor(Math.min(
      (W - PAD * 2) / (units + gapUnits),
      (H - PAD * 2) / 2,
    )));
    const totalW = unit * (units + gapUnits);
    const ox = Math.round((W - totalW) / 2) + PAD;
    const oy = Math.round((H - unit * 2) / 2);
    const boxes = [];
    let x = ox;
    for (const c of shape.cells) {
      const w = cellWidth(c.t, unit);
      boxes.push({ x, y: oy, w, h: unit * 2 });
      x += w + unit * 0.16;
    }
    geom = { unit, ox, oy, vw: W, vh: H, box: boxes };
    draw();
  }

  // Normalised segment ends (per-cell tables in board.js) -> client pixels.
  function segPoints(segIdx) {
    const shape = game.shape;
    const seg = shape.segments[segIdx];
    if (!seg) return null;
    const b = geom.box[seg.cell];
    if (!b) return null;
    const cell = shape.cells[seg.cell];
    const map = (p) => (cell.t === T_DIGIT
      ? { x: b.x + p[0] * b.w, y: b.y + p[1] * b.h / 2 }
      : { x: b.x + p[0] * b.w, y: b.y + (0.5 + p[1]) * b.h / 2 });
    return { seg, cell, a: map(seg.from), b: map(seg.to) };
  }

  function toClient(px, py) {
    const box = canvas.getBoundingClientRect();
    return { x: Math.round(box.left + px), y: Math.round(box.top + py), unit: geom.unit };
  }

  function localPoint(ev) {
    const box = canvas.getBoundingClientRect();
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  }

  // The slot a pointer means: nearest segment whose *body* is within GRAB of it. `wantLit`
  // true / false / null (any) picks which bands to consider — a filter about *where a
  // pointer can land*, not about whether a move is allowed, which stays in core.
  function segAt(px, py, wantLit) {
    if (!game) return null;
    const state = game.state();
    const shape = game.shape;
    const r = GRAB * geom.unit;
    let best = null;
    for (const seg of shape.segments) {
      if (wantLit !== null && isLit(state, seg) !== wantLit) continue;
      const p = segPoints(seg.i);
      const d = distToSeg(px, py, p.a, p.b);
      if (d > r) continue;
      if (!best || d < best.d) best = { i: seg.i, d };
    }
    return best ? best.i : null;
  }

  // --------------------------------------------------------------------------
  // Pointer
  // --------------------------------------------------------------------------

  function down(ev) {
    if (!game) return;
    const p = localPoint(ev);
    const picked = game.picked();
    // Tap-then-tap: a match already held by a first tap lands on whatever dark slot this
    // tap means. The same pipeline a drag ends in, so both gestures share one rule check.
    if (picked !== null) {
      const target = segAt(p.x, p.y, false);
      if (target !== null) {
        ev.preventDefault();
        onCommit(picked, target);
        return;
      }
    }
    const i = segAt(p.x, p.y, true);
    if (i === null) {
      // Tapped bare felt: put whatever was held back down where it came from. No move is
      // spent, because nothing was moved.
      if (picked !== null) {
        game.cancel();
        if (onRelease) onRelease(null);
        draw();
      }
      ev.preventDefault();
      return;
    }
    const seg = game.shape.segments[i];
    const held = onPick ? onPick(i, seg) : false;
    if (!held) {
      badSeg = { i, until: performance.now() + 700 };
      if (onRelease) onRelease(i);
      draw();
      ev.preventDefault();
      return;
    }
    drag = { i, from: p, x: p.x, y: p.y, target: null, moved: 0 };
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(ev.pointerId); } catch (err) { /* fine inside the canvas */ }
    }
    canvas.classList.add('grabbing');
    draw();
    ev.preventDefault();
  }

  function move(ev) {
    if (!drag) return;
    const p = localPoint(ev);
    drag.x = p.x;
    drag.y = p.y;
    drag.moved = Math.max(drag.moved, Math.hypot(p.x - drag.from.x, p.y - drag.from.y));
    drag.target = segAt(p.x, p.y, false);
    ev.preventDefault();
  }

  function up(ev) {
    if (!drag) return;
    const was = drag;
    drag = null;
    canvas.classList.remove('grabbing');
    if (ev) ev.preventDefault();
    if (was.target !== null && was.target !== was.i) {
      onCommit(was.i, was.target);
      return;
    }
    // A press and release on the same match is a *selection*, not a move: the second tap
    // on an empty slot commits it. Nothing has been spent yet either way — game.applyMove is
    // what refuses the zero-displacement case, and this branch never reaches it.
    if (onRelease) onRelease(was.i);
    draw();
  }

  // --------------------------------------------------------------------------
  // Drawing
  // --------------------------------------------------------------------------

  function drawFelt() {
    const { vw, vh } = geom;
    ctx.fillStyle = FELT;
    ctx.beginPath();
    const r = 14;
    ctx.moveTo(r, 0);
    ctx.arcTo(vw, 0, vw, vh, r);
    ctx.arcTo(vw, vh, 0, vh, r);
    ctx.arcTo(0, vh, 0, 0, r);
    ctx.arcTo(0, 0, vw, 0, r);
    ctx.closePath();
    ctx.fill();
  }

  function drawMatch(a, b, { color = STICK, head = HEAD_A, lift = 0, ghost = false } = {}) {
    const u = geom.unit;
    const th = Math.max(2.5, u * MATCH) * (lift ? 1.12 : 1);
    ctx.save();
    if (lift) {
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = u * 0.35;
      ctx.shadowOffsetY = u * 0.16;
    }
    if (ghost) ctx.globalAlpha = 0.35;
    ctx.lineCap = 'round';
    ctx.lineWidth = th;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    // The head sits at the `to` end so the two ends of a stick are distinguishable —
    // which matters, because the drag test presses one specific end.
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const hx = b.x - ((b.x - a.x) / len) * Math.min(u * 0.3, len * 0.35);
    const hy = b.y - ((b.y - a.y) / len) * Math.min(u * 0.3, len * 0.35);
    ctx.fillStyle = head;
    ctx.beginPath();
    ctx.arc(hx, hy, Math.max(2, u * HEAD * 0.5), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSlot(a, b, kind) {
    const u = geom.unit;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.5, u * 0.045);
    ctx.setLineDash([u * 0.14, u * 0.14]);
    ctx.strokeStyle = kind;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  function pulse(now, until) {
    const left = Math.max(0, until - now) / 700;
    return 0.45 + 0.55 * Math.abs(Math.sin(now / 160)) * Math.max(0.2, left);
  }

  function draw() {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const { vw, vh } = geom;
    ctx.clearRect(0, 0, vw, vh);
    drawFelt();
    if (!game) return;
    const state = game.state();
    const shape = game.shape;
    const picked = game.picked();

    // 1. empty slots, so the board reads as "these are the places a match could sit".
    for (const seg of shape.segments) {
      if (isLit(state, seg)) continue;
      const p = segPoints(seg.i);
      const hot = drag && drag.target === seg.i;
      drawSlot(p.a, p.b, hot ? SLOT_HOT : (seg.locked ? SLOT_LOCK : SLOT));
    }
    // 2. locked segments get a plain, unmistakable treatment: they are part of the frame.
    for (const seg of shape.segments) {
      if (!seg.locked || !isLit(state, seg)) continue;
      const p = segPoints(seg.i);
      drawMatch(p.a, p.b, { color: '#8c95a5', head: '#5d6675' });
    }
    // 3. the rest of the matches.
    for (const seg of shape.segments) {
      if (seg.locked || !isLit(state, seg)) continue;
      if (drag && drag.i === seg.i) continue;
      const p = segPoints(seg.i);
      const isPick = picked === seg.i;
      let color = isPick ? HELD : STICK;
      if (badSeg && badSeg.i === seg.i && now < badSeg.until) {
        color = BAD;
        ctx.globalAlpha = pulse(now, badSeg.until);
      }
      drawMatch(p.a, p.b, { color, head: isPick ? '#e0a63c' : HEAD_A, lift: isPick });
      ctx.globalAlpha = 1;
    }
    // 4. hint pair: a green ghost on the source and its destination.
    if (hintPair && now < hintPair.until) {
      for (const i of [hintPair.off, hintPair.on]) {
        const p = segPoints(i);
        if (!p) continue;
        ctx.save();
        ctx.strokeStyle = HINT;
        ctx.globalAlpha = pulse(now, hintPair.until);
        ctx.lineWidth = Math.max(3, geom.unit * 0.18);
        ctx.beginPath();
        ctx.moveTo(p.a.x, p.a.y);
        ctx.lineTo(p.b.x, p.b.y);
        ctx.stroke();
        ctx.restore();
      }
    }
    // 5. the match in flight, drawn last so it is on top and visibly off the board.
    if (drag) {
      const p = segPoints(drag.i);
      const dx = drag.x - drag.from.x;
      const dy = drag.y - drag.from.y;
      drawMatch(
        { x: p.a.x + dx, y: p.a.y + dy },
        { x: p.b.x + dx, y: p.b.y + dy },
        { color: HELD, head: '#e0a63c', lift: true, ghost: false },
      );
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    last = now;
    // Repaint only while something is actually animating: a held match, a hint pulse, a
    // refusal flash. An idle board is a static image and does not need a loop burning CPU.
    if (drag || (hintPair && now < hintPair.until) || (badSeg && now < badSeg.until)) draw();
  }

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  return {
    attach(next) {
      game = next;
      drag = null;
      hintPair = null;
      badSeg = null;
      measure();
    },
    detach() {
      game = null;
      draw();
    },
    measure,
    redraw: draw,
    // Where the two ends of a match are, in *client* pixels. The pointer test presses
    // exactly these, so the drag path is exercised through the real event pipeline.
    segmentEnds(segIdx) {
      if (!game) return null;
      const p = segPoints(segIdx);
      if (!p) return null;
      const mid = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
      return {
        i: segIdx,
        cell: p.seg.cell,
        locked: !!p.seg.locked,
        lit: isLit(game.state(), p.seg),
        from: toClient(p.a.x, p.a.y),
        to: toClient(p.b.x, p.b.y),
        mid: toClient(mid.x, mid.y),
      };
    },
    // Which slot a client-space point means — the same function the pointer handlers use,
    // exposed so a test can assert it pressed the right stick rather than hoping.
    slotAtClient(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      return segAt(clientX - box.left, clientY - box.top, null);
    },
    showHint(off, on) {
      hintPair = { off, on, until: performance.now() + 2800 };
      draw();
    },
    flashBad(segIdx) {
      badSeg = { i: segIdx, until: performance.now() + 700 };
      draw();
    },
    start() {
      if (!raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
