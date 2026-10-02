// 动画层：一个定步长的模拟时钟 + 一池余烬。渲染读它，规则不读它。
//
// 为什么要单独一层，而不是在 view.js 里 `x += v` 一把梭：
//   如果每帧按"这一帧来了多少毫秒"直接积分，那么 30Hz 上一步走完的量、120Hz 上要拆成
//   四步走，浮点舍入与衰减的复合次数都跟着刷新率变 —— 同一个动作在不同机器上余烬轨迹
//   不一样。这里真实 dt 只喂累加器，模拟只按固定 STEP 前进：一步就是一步，跑几步只取决于
//   过了多少模拟时间，与屏幕多少 Hz 无关。
//   这条性质不是信仰，是量出来的：见 test/anim.test.mjs 里 30/60/120Hz 对拍的那一条。
//
// 余烬用 seeded RNG（rngFrom）而不是 Math.random：同一局重开，火星该落在同样的地方。

import { rngFrom } from './rng.js';

export const STEP = 1 / 60;        // 一模拟步 = 1/60 秒
const MAX_STEPS = 5;               // 一帧最多补 5 步：切走久了回来不该一次追平（那才是真卡）
const DRAG = 0.40;                // 每秒速度保留率：一步的衰减是它的 STEP 次幂，不是"每帧乘一个数"
const GRAVITY = 620;               // px/s²，画布坐标向下为正
const LIFE = 0.62;                 // 秒

export function createAnim({ seed = 20261002, max = 220 } = {}) {
  const rand = rngFrom(seed);
  const parts = [];
  let clock = 0;      // 模拟时间（秒）：只有 step() 会推进它，暂停时它不动
  let ticks = 0;      // 走过的模拟步数，对拍就按它对齐，不按墙上时间
  let accum = 0;
  let paused = false;
  let reduced = false;
  let emitted = 0;    // 累计发射数（重开要归零，见 reset）

  function step() {
    clock += STEP;
    ticks += 1;
    const decay = Math.pow(DRAG, STEP);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const p = parts[i];
      p.life -= STEP;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      p.vx *= decay;
      p.vy = (p.vy + GRAVITY * STEP) * decay;
      p.x += p.vx * STEP;
      p.y += p.vy * STEP;
      p.spin += p.swirl * STEP;
    }
  }

  return {
    // 真实经过的秒数只进这里。暂停时直接丢掉 dt，累加器原样留着 —— 模拟时钟因此冻结，
    // 而不是"看不见就不跑"。
    advance(dt) {
      if (paused || !(dt > 0)) return 0;
      accum += Math.min(dt, MAX_STEPS * STEP);
      let n = 0;
      while (accum >= STEP && n < MAX_STEPS) {
        accum -= STEP;
        step();
        n += 1;
      }
      if (accum > STEP) accum = 0;   // 补不完就丢弃余量，欠账不该在下一帧变成一次跳变
      return n;
    },
    // 一撮火星。reduce-motion 打开时这里直接返回 0：不是"画得淡一点"，是不产生模拟实体。
    emit(x, y, count = 10, { power = 1 } = {}) {
      if (reduced) return 0;
      let made = 0;
      for (let i = 0; i < count; i += 1) {
        if (parts.length >= max) break;
        const a = rand() * Math.PI * 2;
        const v = (52 + rand() * 150) * power;
        parts.push({
          x, y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v - 40 * power,
          life: LIFE * (0.55 + rand() * 0.45),
          max: LIFE,
          r: 2 + rand() * 3.4,
          spin: rand() * Math.PI,
          swirl: (rand() - 0.5) * 5,
        });
        made += 1;
      }
      emitted += made;
      return made;
    },
    // 时钟读数：脉冲类动效（提示、拒绝）从这里取"现在几点"，不取 performance.now()，
    // 否则暂停中的提示会在幕布后面自己淡完。
    now() { return clock; },
    pulse(until, span = LIFE) {
      const left = Math.max(0, until - clock) / span;
      return reduced ? 1 : 0.45 + 0.55 * Math.abs(Math.sin(clock / 0.16)) * Math.max(0.2, left);
    },
    live() { return parts.length; },
    alive() { return parts.some((p) => p.life > 0); },
    setPaused(v) { paused = !!v; },
    isPaused() { return paused; },
    setReducedMotion(v) { reduced = !!v; },
    reducedMotion() { return reduced; },
    reset() {
      parts.length = 0;
      clock = 0;
      ticks = 0;
      accum = 0;
      emitted = 0;
      paused = false;
    },
    // 只给测试与探针看：位置求和是浮点，对拍时比"同一 tick 的同一量"才说明步长无关。
    digest() {
      let sx = 0;
      let sy = 0;
      for (const p of parts) { sx += p.x + p.vx; sy += p.y + p.vy; }
      return { clock, ticks, live: parts.length, emitted, sx, sy };
    },
    draw(ctx, sprite) {
      if (!parts.length) return;
      for (const p of parts) {
        const a = Math.max(0, Math.min(1, p.life / p.max));
        ctx.save();
        ctx.globalAlpha = a * a;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin);
        const s = p.r * (sprite ? 7 : 2);
        if (sprite) ctx.drawImage(sprite, -s / 2, -s / 2, s, s);
        else {
          ctx.fillStyle = a > 0.6 ? '#ffe9b0' : '#e0a63c';
          ctx.beginPath();
          ctx.arc(0, 0, s / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    },
  };
}
