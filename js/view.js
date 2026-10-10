// Canvas renderer + pointer handling. This file owns pixels and gestures and decides
// nothing about legality: it reads the board (`isLit`, `segment.locked` are facts about the
// state, not judgements about a move) and on release it hands `main.js` an
// (off, on) segment pair. js/core/board.js is the only place that says whether that pair is
// a legal 搬, so a rendering bug can never invent a rule.
//
// 火柴、数字、运算符星位都是现画的；台面毛毡与余烬是 assets/ 下真实烤出来的位图
// （assets/gen/make_art.py 生成，运行时由 setArt() 注入）。拿不到图的时候退回纯色 ——
// 图是表现，不是规则，缺图不该让版面画不出来。
// 火柴两端通过 `segmentEnds()` 暴露出去，所以真实鼠标事件 —— 或 tools/playtest.mjs 驱动的
// 一次按下 —— 按的是某一根的具体端头，而不是猜某个格子。

import { isLit, T_DIGIT, T_EQUALS } from './core/board.js';
import { createAnim } from './core/anim.js';

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

  // ---- 减弱动效（prefers-reduced-motion）----
  // pulse() = 0.45 + 0.55 * |sin(now / 160)| * 衰减 —— 一段 0.5s 周期的明暗呼吸，
  // 它同时喂给两处 globalAlpha：刚被拒的那一段线（BAD 红）和提示那一对（HINT 绿影）。
  // 判据：呼吸只是叠在上面的明暗，两处的**颜色与形状都另有出处** —— 红色是"刚才这一段
  // 连错了"、绿影是"该接这一对"，都不由 alpha 承载。所以减弱动效下把 alpha 钉成一个
  // 恒定值 0.75：照样看得见、看得清，只是不再一明一暗。与 ferry-cos / hashi 同口径。
  let reduceMotion = false;
  let last = 0;
  // 一切随时间变化的东西都归 anim：模拟时钟、余烬粒子、reduce-motion 与暂停。
  // view 自己不留第二套时钟，否则"暂停后还在动"这种 bug 会有两个产地。
  const anim = createAnim();
  let art = { felt: null, ember: null };
  let feltPattern = null;
  let paused = false;

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
    if (!game || paused) return;
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
      badSeg = { i, until: anim.now() + 0.7 };
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
    ctx.save();
    ctx.beginPath();
    const r = 14;
    ctx.moveTo(r, 0);
    ctx.arcTo(vw, 0, vw, vh, r);
    ctx.arcTo(vw, vh, 0, vh, r);
    ctx.arcTo(0, vh, 0, 0, r);
    ctx.arcTo(0, 0, vw, 0, r);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = FELT;
    ctx.fillRect(0, 0, vw, vh);
    if (feltPattern) {
      // 纹理是 256px 可平铺的毛毡（tileable_noise 取址回绕，接缝看不出来），铺满整块台面。
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = feltPattern;
      ctx.fillRect(0, 0, vw, vh);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
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

  // 脉冲读模拟时钟（anim.now()），不读 performance.now()：暂停时提示与拒绝的红闪要停在
  // 原地，而不是在幕布后面自己淡完。reduce-motion 下 anim.pulse 返回常量，不抖。
  function pulse(until, span = 0.7) {
    return anim.pulse(until, span);
  }

  function draw() {
    const now = anim.now();
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
        ctx.globalAlpha = pulse(badSeg.until);
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
        ctx.globalAlpha = pulse(hintPair.until, 2.8);
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
    // 6. 余烬：一搬落地撒的那一把，画在最上层。
    anim.draw(ctx, art.ember);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    // 帧间隔只喂累加器：模拟按固定步长前进，30Hz 与 120Hz 跑同一段模拟时间走同样多的步。
    const dt = last ? Math.min(0.25, (now - last) / 1000) : 0;
    last = now;
    anim.advance(dt);
    const clock = anim.now();
    // 只在真的有东西在动时重绘：静止的版面是一张静照，不该烧 CPU。暂停时连重绘都省了，
    // 因为模拟时钟已经冻住，画一百遍也是同一帧。
    if (paused) return;
    if (drag || anim.live() || (hintPair && clock < hintPair.until)
      || (badSeg && clock < badSeg.until)) draw();
  }

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  // 回落路径只在拿不到 Pointer Events 时才挂上（iOS 13 之前的 Safari、部分 webview 只发
  // touch/mouse）。这里只负责"从哪个载体取坐标"，换算仍然只有 localPoint 一处 ——
  // 多一处换算是多一处"手机上点 A 打 B"的产地。
  if (!('onpointerdown' in window)) {
    const fromTouch = (ev, list) => {
      const t = ev[list] && ev[list][0];
      if (!t) return null;
      return { clientX: t.clientX, clientY: t.clientY, pointerId: 0, preventDefault: () => ev.preventDefault() };
    };
    const fromMouse = (ev) => ({ clientX: ev.clientX, clientY: ev.clientY, pointerId: 0, preventDefault: () => ev.preventDefault() });
    canvas.addEventListener('touchstart', (ev) => { const p = fromTouch(ev, 'touches'); if (p) down(p); }, { passive: false });
    canvas.addEventListener('touchmove', (ev) => { const p = fromTouch(ev, 'touches'); if (p) move(p); }, { passive: false });
    canvas.addEventListener('touchend', (ev) => { const p = fromTouch(ev, 'changedTouches'); if (p) up(p); }, { passive: false });
    canvas.addEventListener('touchcancel', (ev) => { const p = fromTouch(ev, 'changedTouches'); if (p) up(p); }, { passive: false });
    canvas.addEventListener('mousedown', (ev) => down(fromMouse(ev)));
    canvas.addEventListener('mousemove', (ev) => move(fromMouse(ev)));
    canvas.addEventListener('mouseup', (ev) => up(fromMouse(ev)));
  }

  return {
    // The gate the runtime pref flip lands on: idempotent, repaints so the highlight settles on
    // the same frame the setting changes rather than at the next repaint.
    setReduceMotion(v) {
      const on = !!v;
      if (on === reduceMotion) return reduceMotion;
      reduceMotion = on;
      if (reduceMotion) draw();
      return reduceMotion;
    },
    isReducedMotion: () => reduceMotion,
    attach(next) {
      game = next;
      drag = null;
      hintPair = null;
      badSeg = null;
      // 换题与重开都从这里过：模拟时钟、粒子、暂停标记一起清，上一局的火星不许飘到这一局。
      anim.reset();
      paused = false;
      measure();
    },
    setArt(next) {
      art = { felt: next && next.felt ? next.felt : null, ember: next && next.ember ? next.ember : null };
      feltPattern = art.felt && ctx.createPattern ? ctx.createPattern(art.felt, 'repeat') : null;
      draw();
    },
    setPaused(v) {
      paused = !!v;
      // 暂停必须落到模拟层，不能只挡住 draw：只跳过渲染的话时钟照跑，
      // 提示与拒绝的脉冲会在幕布后面自己淡完，幕布上"模拟时钟已停住"就成了假话。
      anim.setPaused(paused);
      if (paused && drag) up(null);   // 暂停时手上的那根放回原处：不花搬数
      draw();
      return paused;
    },
    isPaused() { return paused; },
    setReducedMotion(v) { anim.setReducedMotion(v); },
    // 把火星撒在某一格的中点：main.js 在一次搬运落地、或过关那一刻调用。
    sparksAt(segIdx, count = 12, power = 1) {
      const p = segPoints(segIdx);
      if (!p) return 0;
      return anim.emit((p.a.x + p.b.x) / 2, (p.a.y + p.b.y) / 2, count, { power });
    },
    sparksAtCenter(count = 26, power = 1.4) {
      return anim.emit(geom.vw / 2, geom.vh / 2, count, { power });
    },
    animState() {
      return { ...anim.digest(), paused, reduced: anim.reducedMotion(), hasFelt: !!feltPattern, hasEmber: !!art.ember };
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
      hintPair = { off, on, until: anim.now() + 2.8 };
      draw();
    },
    flashBad(segIdx) {
      badSeg = { i: segIdx, until: anim.now() + 0.7 };
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
