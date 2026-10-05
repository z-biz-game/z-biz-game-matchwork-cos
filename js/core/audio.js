// 声音层。四下合成音（拿起 / 放下 / 被规则拒绝 / 过关），全部 WebAudio 现算，不带音频文件。
//
// "静音"的两条硬要求，都是行为而不是字段：
//   1) 静音挂起的是 AudioContext 本身（suspend/resume），不是把 master 增益设为 0 ——
//      增益 0 的图仍在跑振荡器，笔记本的 fan 与电量都不认这是静音；
//   2) 静音期间一个新振荡器都不创建。这条从外面看得见：`voices` 计数器在静音时按十次
//      play() 之后必须一动不动（test 与 window.matchwork.audio 都读得到）。
//
// 生效的静音值有**两个来源**，必须分开，否则它们会互相踩：
//   userMuted —— 玩家按下的那个开关，唯一能写进存档的值；
//   ducked    —— 暂停之类的临时静音，不许覆盖玩家的选择。
// 合成一个字段时"暂停静音、恢复还原"就写不出正确判据：早先 main.js 用
// `if (!audio.muted()) audio.setMuted(save.muted())` 还原，而 muted() 在暂停期间恒为 true
// （正是暂停自己设的），那次还原永远不执行 —— 玩家只按了一下 P，整局再也没声音，
// 按钮还显示"已静音"。实测见 test/audio.test.mjs。
//
// AudioContext 只在第一次真实手势里建：浏览器不允许在 load 之前就允许声音，Electron 的
// file:// 与 node（load_sweep 的桩环境）里干脆没有这个类，所以这里全部走惰性 + 判空。

const TONE = {
  pick: { f: 523.25, to: 523.25, dur: 0.07, type: 'triangle', gain: 0.16 },
  drop: { f: 392.00, to: 523.25, dur: 0.11, type: 'triangle', gain: 0.20 },
  refuse: { f: 196.00, to: 155.56, dur: 0.16, type: 'sawtooth', gain: 0.14 },
  win: { f: 523.25, to: 1046.5, dur: 0.42, type: 'sine', gain: 0.22 },
};

export function createAudio({ initialMuted = false, onChange = null } = {}) {
  let ctx = null;
  let master = null;
  let userMuted = !!initialMuted;   // 玩家的选择：唯一会被写进存档的那一个
  let ducked = false;               // 暂停造成的临时静音：还原时按玩家的偏好落地
  const muted = () => userMuted || ducked;
  let voices = 0;      // 成功创建的振荡器数（静音时永不加）
  let refused = 0;     // 因静音/无上下文而被挡下的 play 次数
  const live = new Set();

  // 挂起/恢复的是图本身。两次都带 catch：Safari 在页面隐藏时会拒绝 resume。
  function applyMute() {
    if (!ctx) { report(); return; }
    if (muted()) {
      if (ctx.state !== 'suspended') ctx.suspend().then(report, report);
      else report();
    } else if (ctx.state !== 'running') {
      ctx.resume().then(report, report);
    } else report();
  }

  function AC() {
    return typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  }

  function ensure() {
    if (ctx) return ctx;
    const K = AC();
    if (!K) return null;
    try {
      ctx = new K();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      if (muted()) ctx.suspend();
    } catch (err) {
      ctx = null;
      master = null;
    }
    return ctx;
  }

  function report() {
    if (onChange) onChange({ muted: muted(), userMuted, ducked, voices, refused, ctx: ctx ? ctx.state : 'none' });
  }

  return {
    // 只有真实手势能走到这里（pointerdown / keydown / click），所以不在模块加载时碰音频设备。
    unlock() {
      const c = ensure();
      if (c && !muted() && c.state === 'suspended') c.resume().then(report, () => {});
      return !!c;
    },
    play(kind = 'drop') {
      const t = TONE[kind];
      if (!t) return false;
      if (muted()) { refused += 1; report(); return false; }
      const c = ensure();
      if (!c) { refused += 1; report(); return false; }
      if (c.state === 'suspended') c.resume().then(() => {}, () => {});
      const now = c.currentTime;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = t.type;
      osc.frequency.setValueAtTime(t.f, now);
      osc.frequency.exponentialRampToValueAtTime(t.to, now + t.dur);
      gain.gain.setValueAtTime(t.gain, now);
      gain.gain.exponentialRampToValueAtTime(0.0005, now + t.dur);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now);
      osc.stop(now + t.dur + 0.02);
      voices += 1;
      const rec = { osc };
      live.add(rec);
      osc.onended = () => {
        live.delete(rec);
        try { osc.disconnect(); gain.disconnect(); } catch (err) { /* 已经断了 */ }
      };
      report();
      return true;
    },
    // 玩家的那一下开关。写的是偏好，生效值还要看有没有被暂停压住。
    setMuted(v) {
      userMuted = !!v;
      applyMute();
      return muted();
    },
    // 暂停这类"临时压住"。不许把偏好改掉：P 一下再 P 回来，声音必须原样回来。
    setDucked(v) {
      ducked = !!v;
      applyMute();
      return muted();
    },
    toggle() { return this.setMuted(!userMuted); },
    muted() { return muted(); },
    preference() { return userMuted; },
    ducked() { return ducked; },
    // 重开要把上一局还在响的尾音一起收掉，不然"重开重置一切"少一条尾巴。
    stopAll() {
      for (const rec of live) {
        try { rec.osc.stop(0); } catch (err) { /* 已停 */ }
      }
      live.clear();
    },
    state() {
      return { muted: muted(), userMuted, ducked, voices, refused, live: live.size, ctx: ctx ? ctx.state : 'none' };
    },
    reset() {
      this.stopAll();
      voices = 0;
      refused = 0;
      report();
    },
  };
}
