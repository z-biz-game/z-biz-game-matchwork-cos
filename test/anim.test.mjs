// js/core/anim.js: 定步长模拟。这里量的不是"有没有写 dt"，而是那条性质本身：
// 同一撮火星，用 30/60/120Hz 三种帧间隔喂进去，走完同样的模拟时间后必须落在同样的位置。
//
// 反向对照（这条测试为什么会红）：把 anim.js 里的 `p.x += p.vx * STEP` 改成
// `p.x += p.vx * realDt`（也就是直接拿这一帧的真实耗时积分），下面那三条 digest 立刻不再
// 相等 —— 衰减的复合次数从 40 次变成 20/40/80 次，轨迹就按刷新率分叉了。这正是
// polish/script/cos_frame_probe.js 量不动 ESM 仓时，我自己在仓内补的那把尺。

import { test, ok, eq, run } from '../tools/harness.mjs';
import { createAnim, STEP } from '../js/core/anim.js';

const T = 2 / 3;   // 模拟时间：0.666s，正好 40 步

function burst(frames) {
  const anim = createAnim({ seed: 7 });
  anim.emit(120, 90, 24, { power: 1.2 });
  for (let i = 0; i < frames; i += 1) anim.advance(T / frames);
  return anim.digest();
}

test('anim: 30/60/120Hz 走完同样的模拟时间，火星落在同一个地方', () => {
  const a30 = burst(20);
  const a60 = burst(40);
  const a120 = burst(80);
  eq(a30.ticks, 40, '30Hz 下该走 40 个模拟步');
  eq(a60.ticks, a30.ticks, '60Hz 与 30Hz 的步数不一致');
  eq(a120.ticks, a30.ticks, '120Hz 与 30Hz 的步数不一致');
  ok(Math.abs(a30.sx - a60.sx) < 1e-9 && Math.abs(a30.sy - a60.sy) < 1e-9,
    `60Hz 的位置和 30Hz 分叉了：${a30.sx} vs ${a60.sx}`);
  ok(Math.abs(a120.sx - a30.sx) < 1e-9 && Math.abs(a120.sy - a30.sy) < 1e-9,
    `120Hz 的位置和 30Hz 分叉了：${a120.sx} vs ${a30.sx}`);
});

test('anim: 暂停就是模拟时钟停住，不是"看不见就不跑"', () => {
  const anim = createAnim({ seed: 3 });
  anim.emit(10, 10, 8);
  anim.advance(0.5);
  const before = anim.digest();
  anim.setPaused(true);
  for (let i = 0; i < 12; i += 1) anim.advance(1 / 60);
  const after = anim.digest();
  eq(after.ticks, before.ticks, '暂停中还在推进模拟步');
  eq(after.clock, before.clock, '暂停中模拟时钟自己走了');
  eq(after.emitted, before.emitted);
  anim.setPaused(false);
  ok(anim.advance(1 / 60) > 0, '解除暂停之后没有接着跑');
});

test('anim: 重开把时钟、粒子、发射计数一起归零', () => {
  const anim = createAnim({ seed: 5 });
  anim.emit(4, 4, 16);
  anim.advance(0.2);
  ok(anim.digest().live > 0, 'precondition: 场上该还有火星');
  anim.reset();
  const d = anim.digest();
  eq(d.clock, 0, '重开后模拟时钟没归零');
  eq(d.ticks, 0, '重开后步数计数没归零');
  eq(d.live, 0, '重开后粒子还在');
  eq(d.emitted, 0, '重开后发射计数还在累加');
});

test('anim: reduce-motion 是不产生模拟实体，不是把 alpha 调小', () => {
  const anim = createAnim({ seed: 9 });
  anim.setReducedMotion(true);
  eq(anim.emit(1, 1, 30), 0, '关掉动效还在发射粒子');
  anim.advance(0.5);
  eq(anim.digest().live, 0);
  eq(anim.pulse(9), 1, 'reduce 下脉冲应当是常量，不该按 sin 抖');
});

test('anim: 同一粒种子跑两次得到同一撮火星（不吃 Math.random）', () => {
  const once = burst(40);
  const twice = burst(40);
  eq(twice.sx, once.sx);
  eq(twice.sy, once.sy);
  eq(twice.live, once.live);
});

test('anim: 一帧最多补 MAX_STEPS 步，欠的账不滚成一次跳变', () => {
  const anim = createAnim({ seed: 11 });
  const steps = anim.advance(4);      // 切到后台四秒再回来
  ok(steps <= 5, `一帧补了 ${steps} 步`);
  ok(anim.digest().clock <= 5 * STEP + 1e-9, '模拟时钟一次追平了墙上时间');
  eq(anim.advance(0), 0, 'dt=0 也推进了');
});

run();
