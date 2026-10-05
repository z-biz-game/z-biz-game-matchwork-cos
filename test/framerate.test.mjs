// 关卡内三档帧率对拍（简报 §3 的硬骨头），跑在真实 shell 上：装载 js/main.js，进一局
// par≥2 的题，走一次真实 commit，然后按 30/60/120Hz 喂同一份虚拟帧时间。
//
// 为什么仓里要长这样一份，而不是靠官方探针：cos_frame_probe.js 把 `<script src>` 当**经典脚本**
// 读进 vm，本仓入口是 `<script type="module">`，它只能报
// 「结论：无法比对（SyntaxError: Cannot use import statement outside a module）」。
// 简报明说那不算通过，要求"靠你自己的 harness 补判"——这份就是那个 harness，
// 留在仓里是为了下一棒能直接复跑，不必重新证明"游戏到底跑起来没有"。
//
// 为什么每个帧率各起一个子进程：anim 的粒子用的是带种子的 rngFrom，而 anim.reset() 只清粒子
// 与时钟、**不重播随机流**。同一进程里连跑三档，第二档撒的火星和第一档就不是同一把，
// 对拍会凭空白判红。分进程 = 每档一条全新的随机流，这正是 /tmp 那版 python 驱动的做法。
//
// 三条轴（逐字段数字，判词按 §3 的阈值）：
//   [A] 步号轴：按 sim 步号对齐（§3 坑①：1000/60 的浮点亏损会让 60Hz 少喂 5e-13 秒、定步长
//       累加器少跑一步，按墙钟秒对齐会凭空判红）。30Hz 一帧跨 2 步，只会经过偶数 tick ⇒
//       取三档都到达过的 tick 交集，要求逐位相同，并要求交集里真有活体。
//   [B] 时长轴：同一虚拟秒取末态，误差比 = 三档跨度 / 该字段随时间的推进量，>3.6 判红。
//   [C] 阴性对照（§6 的新口径）：本仓动画层已彻底定步长，"把 x += v*dt 改成常量"打不红
//       任何东西（那是结构性质，不是尺子空跑）。所以对照钉在**仍在吃帧 dt 的那一行**：把
//       anim.js 的 `accum += Math.min(dt, MAX_STEPS * STEP)` 换成 `accum += STEP`（一帧补一步）
//       得到一份对照动画层，用完全相同的定义去量它，必须判红。
//   [C2] 上面那个靶子必须还挂在原处：anim.js 里那一行没被改写的话，这条尺子够得着的东西就变了。
//
// 时钟从 1000ms 起步（§3 坑②：从 0 起步会被 view.js 的 `last ? dt : 0` 首帧哨兵吃掉一帧，
// 凭空造出 25ms 的假帧率依赖）；每档先空烧一帧把哨兵消化掉，再开始计数喂帧。
// 桩必须留住 requestAnimationFrame 待办队列：清掉它等于剪断渲染环，三档 ticks 全 0，
// 对拍退化成比 0 == 0（本条第一版就是这样假绿过一次，所以 [A0] 专门盯着"到底跑起来了没有"）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test, ok, eq, run } from '../tools/harness.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const RATES = [30, 60, 120];
const SPAN = 1.0;                       // 每档喂一整秒虚拟时间：30Hz 也够走出 60 个偶数 tick
const TIME_TARGETS = [0.2, 0.45, 0.55];   // 火星寿命 LIFE=0.62s ⇒ 这三个点上定步长仍有活体
const D_MAX = TIME_TARGETS[TIME_TARGETS.length - 1];
const FIELDS = ['ticks', 'clock', 'live', 'sx', 'sy'];
const LIVE_FIELDS = ['live', 'sx', 'sy', 'clock'];

/* ------------------------------------------------------------------ 桩 */

function stubEnv() {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
  const ctx2d = new Proxy({ canvas: null }, {
    get: (o, k) => {
      if (['createLinearGradient', 'createRadialGradient', 'createPattern'].includes(k)) return () => ({ addColorStop() {} });
      if (k === 'measureText') return () => ({ width: 8 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (typeof k === 'string' && ['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'globalAlpha',
        'shadowBlur', 'shadowColor', 'textAlign', 'textBaseline'].includes(k)) return o[k];
      return () => {};
    },
    set: (o, k, v) => { o[k] = v; return true; },
  });
  const mk = (id) => {
    const seen = new Set();
    const el = {
      id, dataset: {}, style: { setProperty() {}, getPropertyValue: () => '', removeProperty() {} },
      classList: {
        add: (...c) => c.forEach((x) => seen.add(x)),
        remove: (...c) => c.forEach((x) => seen.delete(x)),
        toggle: (c, f) => ((f === undefined ? !seen.has(c) : !!f) ? (seen.add(c), true) : (seen.delete(c), false)),
        contains: (c) => seen.has(c),
      },
      textContent: '', innerHTML: '', value: '1', hidden: true, disabled: false,
      width: 800, height: 600, clientWidth: 800, clientHeight: 600, children: [], _h: {},
      addEventListener(t, cb) { (el._h[t] = el._h[t] || []).push(cb); },
      removeEventListener(t, cb) { el._h[t] = (el._h[t] || []).filter((f) => f !== cb); },
      querySelector: () => mk('sub'), querySelectorAll: () => [], append() {}, appendChild() {},
      replaceChildren() {}, insertAdjacentHTML() {}, remove() {}, closest: () => null, contains: () => false,
      parentElement: { clientWidth: 960, clientHeight: 720 },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      click() { (el._h.click || []).forEach((f) => f({ target: el, preventDefault() {} })); },
      setAttribute() {}, getAttribute: () => null, hasAttribute: () => false, removeAttribute() {},
      focus() {}, blur() {}, select() {}, scrollIntoView() {},
      getContext: () => ctx2d, putImageData() {}, drawImage() {},
    };
    return el;
  };
  const cache = new Map();
  const win = {};
  const doc = {
    getElementById(i) { if (!ids.has(i)) return null; if (!cache.has(i)) cache.set(i, mk(i)); return cache.get(i); },
    querySelector: () => mk('q'), querySelectorAll: () => [], createElement: (t) => mk('c-' + t),
    createTextNode: (t) => ({ textContent: String(t) }), createDocumentFragment: () => mk('frag'),
    activeElement: null, fullscreenElement: null, exitFullscreen: () => Promise.resolve(),
    body: mk('body'), documentElement: mk('html'), head: mk('head'),
    addEventListener() {}, removeEventListener() {}, title: '', hidden: false,
    visibilityState: 'visible', fonts: { ready: Promise.resolve() },
  };
  const state = { clock: 1000, pending: [], hash: '' };
  const store = {};
  let rs = 0x2f6e2b1;
  const g = globalThis;
  const def = (k, v) => Object.defineProperty(g, k, { value: v, writable: true, configurable: true });
  const fire = (t, ev) => (win[t] || []).forEach((cb) => cb(ev));
  def('document', doc);
  def('window', g);
  def('self', g);
  def('navigator', { userAgent: 'framerate-test', maxTouchPoints: 0, clipboard: null });
  def('location', {
    href: 'http://x/', protocol: 'http:', search: '', pathname: '/', origin: 'http://x',
    get hash() { return state.hash; },
    set hash(v) { state.hash = v; fire('hashchange', { type: 'hashchange' }); },
    replace(u) { state.hash = String(u).replace(/^[^#]*/, ''); fire('hashchange', { type: 'hashchange' }); },
    assign() {}, reload() {},
  });
  def('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear() {},
  });
  def('performance', { now: () => state.clock });
  def('requestAnimationFrame', (cb) => { state.pending.push(cb); return state.pending.length; });
  def('cancelAnimationFrame', () => {});
  def('setTimeout', () => 1); def('clearTimeout', () => {}); def('setInterval', () => 1); def('clearInterval', () => {});
  def('matchMedia', () => ({ matches: false, addEventListener() {}, addListener() {} }));
  def('devicePixelRatio', 2); def('innerWidth', 1200); def('innerHeight', 900);
  def('Image', function () { return { addEventListener() {}, set src(_v) {} }; });
  def('ResizeObserver', function () { return { observe() {}, unobserve() {}, disconnect() {} }; });
  def('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  def('addEventListener', (t, cb) => { (win[t] = win[t] || []).push(cb); });
  def('removeEventListener', (t, cb) => { win[t] = (win[t] || []).filter((f) => f !== cb); });
  def('AudioContext', function () {
    const param = () => ({ value: 1, setValueAtTime() {}, setTargetAtTime() {}, linearRampToValueAtTime() {},
      exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
    const node = () => ({ connect() {}, disconnect() {}, start() {}, stop() {}, gain: param(), frequency: param(), type: 'sine', onended: null });
    const c = { destination: {}, currentTime: 0, sampleRate: 44100, state: 'suspended',
      createOscillator: node, createGain: node,
      resume() { c.state = 'running'; return Promise.resolve(); },
      suspend() { c.state = 'suspended'; return Promise.resolve(); },
      close() { c.state = 'closed'; return Promise.resolve(); } };
    return c;
  });
  def('Path2D', function () { return new Proxy({}, { get: () => () => ({}) }); });
  def('alert', () => {}); def('confirm', () => false);
  Math.random = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };

  // 一帧 = 时钟前进 1000/rate 毫秒，然后把待办的 rAF 回调全部叫一次（它们会自己续订）。
  function pump(rate, n, onFrame, t0) {
    const frameMs = 1000 / rate;
    for (let f = 0; f < n; f += 1) {
      state.clock += frameMs;
      const q = state.pending;
      state.pending = [];
      for (const cb of q) cb(state.clock);
      if (onFrame) onFrame(f, (state.clock - t0) / 1000);
    }
  }
  return {
    // 只回拨时钟，**不动 pending**：清了就是把 view 的渲染环剪断。
    resetClock() { state.clock = 1000; },
    pendingCount: () => state.pending.length,
    // 空烧一帧：把 view.js 首帧的 `last ? dt : 0` 哨兵（或上一轮回拨造成的负 dt）消化掉，
    // 之后每一帧的 dt 都精确等于 1/rate 秒。
    prime(rate) { pump(rate, 1, null, state.clock); },
    runFrames(rate, onFrame) { pump(rate, Math.round(SPAN * rate), onFrame, state.clock); },
  };
}

const env = stubEnv();
await import(pathToFileURL(path.join(REPO, 'js/main.js')).href);
const mw = globalThis.matchwork;

/* --------------------------------------------------------------- 场景 */

let LOT = null;
function pickLot() {
  if (LOT) return LOT;
  const ids = mw.campaign();
  for (let n = 1; n <= ids.length; n += 1) {
    mw.load(`#/c/${n}`);
    const lot = mw.lot();
    if (lot && lot.par >= 2 && (mw.path() || []).length >= 2) { LOT = `#/c/${n}`; return LOT; }
  }
  return null;
}

function read() {
  const a = mw.anim;
  return { ticks: a.ticks, clock: a.clock, live: a.live, sx: a.sx, sy: a.sy };
}

// 一个档率的完整一轮：换题（attach 里的 anim.reset 把时钟/步数/粒子清零）→ 空烧一帧 →
// 一次真实 commit（拿起→放下，规则自己撒一把火星）→ 再补一发探针火星 → 按该档喂帧。
function playRate(rate) {
  env.resetClock();
  mw.load(LOT);
  if (mw.state.state !== 'playing') return { rate, error: `state=${mw.state.state}` };
  env.prime(rate);
  const step = mw.path()[0];
  const dropped = mw.drop(step.off, step.on);
  const emitted = mw.sparks(24);
  const perTick = {};
  const at = {};
  env.runFrames(rate, (f, t) => {
    const r = read();
    if (!(r.ticks in perTick)) perTick[r.ticks] = r;
    for (const mt of TIME_TARGETS) if (!at[mt] && t >= mt - 1e-9) at[mt] = r;
  });
  const last = read();
  return { rate, dropped, emitted, par: mw.state.par, id: mw.state.id, perTick, at, last,
    pending: env.pendingCount() };
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
// 展开必须写两处：少写一个 `...` 就是 Math.min([…]) ⇒ NaN ⇒ 所有 `> 3.6` 静默为 false，
// 对拍会假绿（本条第一版就是这样让 [B] 和 [C] 同时变成空判的）。
function spread(vals) { return Math.max(...vals) - Math.min(...vals); }
// §3 的误差比：三档跨度 ÷ 该字段在这段时间里的推进量。推进量为 0 而跨度不为 0，直接 Infinity。
function errRatio(vals, advance) {
  const s = spread(vals);
  // 读数取空（undefined ⇒ NaN）不该被当成"没有偏差"：非有限数一律按最坏情况判红。
  if (!Number.isFinite(s) || !Number.isFinite(advance)) return Infinity;
  if (advance > 1e-9) return s / advance;
  return s <= 0 ? 0 : Infinity;
}
function fmt(r) { return r === Infinity ? 'Infinity' : r.toFixed(3); }

/* -------------------------------------------- [C] 对照动画层：只改累加器那一行 */

const ANIM_PATH = path.join(REPO, 'js/core/anim.js');
const ANIM_SRC = fs.readFileSync(ANIM_PATH, 'utf8');
const ACCUM = 'accum += Math.min(dt, MAX_STEPS * STEP)';
const CTRL_FILE = path.join(os.tmpdir(), `mw_anim_control_${process.pid}.mjs`);

function controlAnimSource() {
  return ANIM_SRC
    .replace(ACCUM, 'accum += STEP')   // 一帧补一步：走几步从此取决于屏幕多少 Hz
    .replace("from './rng.js'", `from '${pathToFileURL(path.join(REPO, 'js/core/rng.js')).href}'`);
}

async function loadControl() {
  if (!ANIM_SRC.includes(ACCUM)) return null;
  fs.writeFileSync(CTRL_FILE, controlAnimSource());
  // 必须 await 之后再删：`return import(...)` 配 finally 会在 promise 落实前 unlink，
  // node 接着去读源文件就是 ENOENT（第一版正好栽在这里）。
  const mod = await import(pathToFileURL(CTRL_FILE).href);
  fs.unlinkSync(CTRL_FILE);
  return mod;
}

// 同一把尺量对照层：定步长换成"每帧一步"之后，同一虚拟秒上三档必然分家。
function controlRate(rate, createAnim) {
  const a = createAnim({ seed: 20261002 });
  a.emit(320, 240, 24);
  const at = {};
  const frames = Math.round(SPAN * rate);
  const frameMs = 1000 / rate;
  let clock = 1000;
  for (let f = 0; f < frames; f += 1) {
    clock += frameMs;
    a.advance(frameMs / 1000);
    const d = a.digest();
    const r = { ticks: d.ticks, clock: d.clock, live: d.live, sx: d.sx, sy: d.sy };
    for (const mt of TIME_TARGETS) if (!at[mt] && (clock - 1000) / 1000 >= mt - 1e-9) at[mt] = r;
  }
  return { rate, at, ticks: a.digest().ticks };
}

/* ------------------------------------------------------------- 分角色 */

if (process.env.MW_FR_RATE) {
  // 子进程：只跑自己这一档，把读数打成 JSON 最后一行（main.js 的库告警走 stderr，不混进来）。
  // 必须在这里同步退出并切断后续：下面父进程会按档 spawn 子进程，不退出就是无限递归。
  LOT = pickLot();
  const out = LOT ? playRate(Number(process.env.MW_FR_RATE)) : { error: 'NO-LOT' };
  fs.writeSync(1, JSON.stringify(out) + '\n');
  process.exit(0);
}

// 对照层：只算数，不断言。断言全在下面的 test 行里，harness 之外的 throw 会崩掉整个文件。
let CTRL = null;
{
  const mod = await loadControl();
  if (mod && mod.createAnim) {
    const ctrls = RATES.map((r) => controlRate(r, mod.createAnim));
    let peak = [0, '', 0];
    for (const dur of TIME_TARGETS) {
      for (const f of LIVE_FIELDS) {
        const vals = ctrls.map((c) => c.at[dur][f]);
        const advance = median(ctrls.map((c) => Math.abs(c.at[dur][f] - c.at[TIME_TARGETS[0]][f])))
          || median(vals.map(Math.abs));
        const ratio = errRatio(vals, advance);
        if (ratio > peak[2]) peak = [dur, f, ratio];
      }
    }
    CTRL = { ctrls, peak };
  }
}

function spawnRate(rate) {
  const r = spawnSync(process.execPath, [import.meta.filename], {
    env: { ...process.env, MW_FR_RATE: String(rate) }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  ok(r.status === 0 && lines.length, `${rate}Hz 子进程没跑出读数：${(r.stderr || '').slice(0, 200)}`);
  const parsed = JSON.parse(lines[lines.length - 1]);
  ok(!parsed.error, `${rate}Hz 那一轮没跑起来（${parsed.error}）`);
  parsed.perTick = Object.fromEntries(Object.entries(parsed.perTick).map(([k, v]) => [Number(k), v]));
  return parsed;
}

/* --------------------------------------------------------------- 判据 */

test('framerate: 进得去 par≥2 的真实关卡（不是标题态、不是一搬就通关的静止快照）', () => {
  ok(mw, 'window.matchwork 没挂出来：任何探针都读不到本仓状态（简报 §3 要求的判据复验）');
  const hash = pickLot();
  ok(hash, '战役里没有 par≥2 且路径可放的题 ⇒ 对拍无从开始');
  mw.load(hash);
  eq(mw.state.state, 'playing', `进关后是 ${mw.state.state}`);
  ok(mw.state.par >= 2, `这一题 par=${mw.state.par}`);
  ok(mw.state.moves === 0, '开局该是零搬');
});

const runs = RATES.map(spawnRate);
const byRate = Object.fromEntries(runs.map((r) => [r.rate, r]));

test('framerate: [A0] 尺子的地基 —— 三档都真的在跑，且各自走完同样多的模拟步', () => {
  for (const r of runs) {
    ok(r.dropped === true, `${r.rate}Hz 那一手的规则判定不是 true`);
    ok(r.emitted > 0, `${r.rate}Hz 探针火星一个都没撒出来 ⇒ 模拟层没有可比的实体`);
    ok(r.last.ticks >= 55, `${r.rate}Hz 一秒只走了 ${r.last.ticks} 步 ⇒ 渲染环没跑起来（桩剪断 rAF 就是这个症状）`);
    ok(r.pending > 0, `${r.rate}Hz 喂完之后待办队列空了 ⇒ 循环早退了`);
  }
  const steps = runs.map((r) => r.last.ticks);
  console.log(`         ${runs[0].id} par=${runs[0].par}；一秒末各档步数 ${steps.join(' / ')}，`
    + `sim 时钟 ${runs.map((r) => r.last.clock.toFixed(6)).join(' / ')}`);
  ok(spread(steps) <= 2, `同一段虚拟时长走出 ${steps.join('/')} 步 ⇒ 步数在吃帧率，定步长失效`);
});

test('framerate: [A] 步号轴 —— 同一 sim 步号的模拟态三档逐位相同', () => {
  let common = null;
  for (const r of runs) {
    const ks = new Set(Object.keys(r.perTick).map(Number));
    common = common === null ? ks : new Set([...common].filter((k) => ks.has(k)));
  }
  const ticks = [...common].sort((a, b) => a - b);
  ok(ticks.length >= 20, `交集只有 ${ticks.length} 个 tick，样本不够（30Hz 一帧跨 2 步，只经过偶数 tick）`);
  let worst = 0;
  let worstAt = null;
  let alive = 0;
  for (const f of FIELDS) {
    for (const t of ticks) {
      const vals = runs.map((r) => r.perTick[t][f]);
      const d = spread(vals);
      if (d > worst) { worst = d; worstAt = [t, f]; }
      if (f === 'live' && vals[0] > 0) alive += 1;
    }
  }
  const sample = ticks[Math.floor(ticks.length / 2)];
  console.log(`         交集 ${ticks.length} 个 tick（其中 ${alive} 个还有活体火星），最大逐位偏差 ${worst}`
    + ` @ ${JSON.stringify(worstAt)}；样例 tick${sample} sx=`
    + runs.map((r) => r.perTick[sample].sx).join(' | '));
  ok(alive >= 10, `交集里只有 ${alive} 个 tick 还带着火星 ⇒ 比的大半是空池，[A] 近乎空跑`);
  eq(worst, 0, `同一 tick 三档不同（最大偏差 ${worst} @ ${JSON.stringify(worstAt)}）⇒ 模拟在吃帧 dt`);
  const seq30 = Object.keys(byRate[30].perTick).map(Number).sort((a, b) => a - b);
  ok(seq30.some((v, i) => i > 0 && v - seq30[i - 1] > 1), '30Hz 每帧只跨 1 步 ⇒ 定步长补步那一支没被走到');
});

test('framerate: [B] 时长轴 —— 同一虚拟秒的末态误差比 ≤3.6', () => {
  let peak = [0, '', 0];
  for (const dur of TIME_TARGETS) {
    for (const f of FIELDS) {
      const vals = runs.map((r) => r.at[dur][f]);
      const advance = median(runs.map((r) => Math.abs(r.at[dur][f] - r.at[TIME_TARGETS[0]][f])))
        || median(vals.map(Math.abs));
      const ratio = errRatio(vals, advance);
      if (ratio > peak[2]) peak = [dur, f, ratio];
      ok(!(ratio === Infinity || ratio > 3.6),
        `${dur}s 的 ${f}：三档 ${JSON.stringify(vals)} 跨度 ${spread(vals)} / 推进量 ${advance} = ${fmt(ratio)} > 3.6 ⇒ 帧率依赖`);
    }
  }
  console.log(`         时长轴最坏一项 ${peak[0]}s ${peak[1]} 比值 ${fmt(peak[2])}（阈值 3.6）；`
    + `${D_MAX}s 上 live=` + runs.map((r) => r.at[D_MAX].live).join('/')
    + ` sy=` + runs.map((r) => r.at[D_MAX].sy.toFixed(4)).join('/'));
});

test('framerate: [C] 阴性对照 —— 把累加器换成"一帧一步"，同一定义必须判红', () => {
  ok(CTRL, '对照动画层没起来（anim.js 里找不到那行累加器，见 [C2]）⇒ 无法证明这把尺不是空跑');
  const { ctrls, peak } = CTRL;
  console.log(`         对照（accum += STEP，一帧一步）一秒步数 ${ctrls.map((c) => c.ticks).join(' / ')}；`
    + `同一定义下最坏 ${peak[0]}s ${peak[1]} 比值 ${fmt(peak[2])} ⇒ 判红，尺子有效`);
  ok(peak[2] === Infinity || peak[2] > 3.6,
    `对照比值 ${fmt(peak[2])} ≤3.6 ⇒ 这把尺是空跑的，[B] 的绿不说明任何事`);
  ok(spread(ctrls.map((c) => c.ticks)) > 20,
    '对照的一秒步数几乎相同 ⇒ 那行替换没改变任何东西，对照无效');
});

test('framerate: [C2] 靶子还在原位 —— anim.js 的累加器仍须吃帧 dt', () => {
  ok(ANIM_SRC.includes(ACCUM),
    `anim.js 里找不到 "${ACCUM}" ⇒ 本仓唯一还在吃帧 dt 的地方换了位置，`
    + '按简报 §6 重新定位靶子后，把 [C] 的替换串和这条一起改掉');
});

run();
