// js/core/audio.js: "静音"必须是行为，不是字段。这里用一个假 AudioContext 把三条判据钉住：
//   1) 静音期间一个新振荡器都不创建（不是建完再把增益拧到 0）；
//   2) 静音挂起的是上下文本身（suspend / resume 各被调用一次以上）；
//   3) reset() 把上一局还在响的尾音停掉，重开不留余音。
// 假上下文记录自己创建过什么，所以这三条是从外部可证的 —— 和玩家在浏览器里能听见的
// 是同一件事的两个侧面。

import { test, ok, eq, run } from '../tools/harness.mjs';
import { createAudio } from '../js/core/audio.js';

function fakeAudio() {
  const log = { osc: 0, gain: 0, suspend: 0, resume: 0, stop: 0 };
  const param = () => ({ value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  class Ctx {
    constructor() {
      this.currentTime = 0;
      this.state = 'running';
      this.destination = { connect() {}, disconnect() {} };
    }

    createGain() {
      log.gain += 1;
      return { gain: param(), connect() {}, disconnect() {} };
    }

    createOscillator() {
      log.osc += 1;
      const self = {
        type: 'sine',
        frequency: param(),
        connect() {},
        disconnect() {},
        start() {},
        stop() { log.stop += 1; self.onended && setTimeout(self.onended, 0); },
        onended: null,
      };
      return self;
    }

    suspend() { log.suspend += 1; this.state = 'suspended'; return Promise.resolve(); }

    resume() { log.resume += 1; this.state = 'running'; return Promise.resolve(); }
  }
  globalThis.window = { AudioContext: Ctx };
  return log;
}

test('audio: 静音时一个振荡器都不创建，且挂起的是上下文本身', () => {
  const log = fakeAudio();
  const a = createAudio();
  eq(a.play('drop'), true, 'precondition: 未静音时该出声');
  const oscAfterOne = log.osc;
  ok(oscAfterOne === 1, `一次 play 创建了 ${oscAfterOne} 个振荡器`);

  eq(a.setMuted(true), true);
  ok(log.suspend >= 1, '静音没有挂起 AudioContext（把增益拧成 0 不叫静音）');
  const before = log.osc;
  for (let i = 0; i < 10; i += 1) eq(a.play('win'), false, '静音中还出了声');
  eq(log.osc, before, '静音期间还在创建振荡器');
  eq(a.state().refused, 10, '被挡下的 play 没有计入 refused');

  a.setMuted(false);
  ok(log.resume >= 1, '解除静音没有恢复上下文');
  eq(a.play('pick'), true);
  eq(log.osc, before + 1, '解除静音之后还是不响');
});

test('audio: 静音在上下文建立之前就设好，第一次出声也不该漏', () => {
  const log = fakeAudio();
  const a = createAudio({ initialMuted: true });
  eq(a.play('drop'), false);
  eq(log.osc, 0, '带着 initialMuted 还是建了振荡器');
  a.unlock();
  ok(a.state().ctx === 'suspended' || a.state().ctx === 'none', `静音下上下文是 ${a.state().ctx}`);
});

test('audio: reset 停掉在响的尾音并清零计数（重开不余音）', () => {
  fakeAudio();
  const a = createAudio();
  a.play('win');
  a.play('refuse');
  eq(a.state().voices, 2);
  ok(a.state().live > 0, 'precondition: 该有还在响的音');
  a.reset();
  eq(a.state().voices, 0, '重开之后振荡器计数还带着上一局');
  eq(a.state().live, 0, '重开之后还有音在响');
  eq(a.muted(), false, 'reset 把玩家的静音选择改掉了');
});

test('audio: 没有 AudioContext 的环境（file://、旧浏览器）不炸', () => {
  globalThis.window = {};
  const a = createAudio();
  eq(a.unlock(), false);
  eq(a.play('drop'), false);
  eq(a.setMuted(true), true, '静音状态本身还是要记得住');
  eq(a.state().ctx, 'none');
});

run();
