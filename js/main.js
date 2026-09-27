// The shell: hash routes in, canvas out, records in between. Nothing here knows the rules
// of matchstick arithmetic (js/core/board.js), nothing here decides how many moves a puzzle
// takes (js/core/solve.js), and nothing here draws (js/view.js). What is here is routing,
// the panel copy, and the save file.

import { createGame } from './core/game.js';
import { showState, legal, holds } from './core/board.js';
import { parOf } from './core/solve.js';
import * as save from './core/storage.js';
import {
  allLots, campaign, campaignAt, campaignLength, dailyLot, lotById, randomLot, tiers,
  tierLabel, stats as poolStats, rejected, dateKey, auditProofs,
} from './core/library.js';
import { createView } from './view.js';

const $ = (id) => document.getElementById(id);
const el = {
  modes: $('modes'), totals: $('totals'), crumbs: $('crumbs'), readout: $('readout'),
  shelf: $('shelf'), hintline: $('hintline'), equation: $('equation'), curtain: $('curtain'),
  stars: $('stars'), verdict: $('verdict'), tally: $('tally'), undo: $('undo'), hint: $('hint'),
  restart: $('restart'), share: $('share'), next: $('next'), again: $('again'),
  toast: $('toast'), canvas: $('lot'), wipe: $('wipe'),
};

const app = {
  mode: 'campaign',
  index: 1,
  route: null,
  lot: null,
  game: null,
  label: '',
  day: null,
  refused: 0,
  drags: 0,
};

function clampIndex(n) {
  return Math.min(campaignLength(), Math.max(1, Number(n) || 1));
}

// #/c/12 · #/daily · #/random/tangle/4kq2 · #/lot/tangle-07
// The lot id is in the URL, so a shared link resolves to the same equation on another
// device without the receiver needing the sender's save file.
function parseHash(hash = location.hash) {
  const p = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'daily') return { mode: 'daily' };
  if (p[0] === 'random') return { mode: 'random', tier: p[1] || tiers()[0].key, key: p[2] || null };
  if (p[0] === 'lot') return { mode: 'lot', id: p[1] };
  const n = p[0] === 'c' || p[0] === 'campaign' ? Number(p[1]) : Number(p[0]);
  return { mode: 'campaign', index: clampIndex(n) };
}

function resolve(rt) {
  if (rt.mode === 'daily') {
    const day = dateKey();
    return { lot: dailyLot(day), label: `每日等式 · ${day}`, note: day, day };
  }
  if (rt.mode === 'random') {
    const t = tiers().find((x) => x.key === rt.tier) || tiers()[0];
    return { lot: randomLot(t.key, rt.key), label: `随机 · ${t.label}`, note: t.blurb };
  }
  if (rt.mode === 'lot') {
    const lot = lotById(rt.id) || allLots()[0];
    return { lot, label: `题 ${lot.id}`, note: lot ? `最少 ${lot.par} 搬 · ${lot.proof}` : '' };
  }
  const lot = campaignAt(rt.index);
  return { lot, label: `第 ${rt.index} 题`, note: `共 ${campaignLength()} 题 · ${lot ? tierLabel(lot.tier) : ''}` };
}

const view = createView(el.canvas, {
  // `onPick` is the only place the shell asks permission. The view holds the pixels; this
  // returns whether core let the match leave the board, which is what decides the gesture.
  onPick: (i) => {
    const ok = app.game.pick(i);
    if (!ok) refuse(app.game.refusal(), i);
    else say(`拿起 <b>${nameOf(i)}</b> —— 拖到一个空位再松手`);
    renderReadout();
    return ok;
  },
  onCommit: (off, on) => commit(off, on),
  onRelease: () => renderReadout(),
});

function nameOf(i) {
  const seg = app.game.shape.segments[i];
  if (!seg) return '？';
  const at = seg.cell + 1;
  return `第 ${at} 格的 ${seg.name}`;
}

function say(html, bad) {
  el.hintline.innerHTML = html;
  el.hintline.classList.toggle('no', !!bad);
}

// No-spoiler feedback: a refused move says *which rule* stopped it and nothing else. It
// never says whether the move was a good idea, because "that one was closer" would be the
// answer to the puzzle.
function refuse(reason, segIdx) {
  if (!reason) return;
  app.refused++;
  save.bump('refused');
  say(`${reason}`, true);
  if (segIdx !== undefined && segIdx !== null) view.flashBad(segIdx);
}

function setGame(lot) {
  app.lot = lot;
  app.game = createGame(lot);
  app.refused = 0;
  app.drags = 0;
  view.attach(app.game);
  el.curtain.hidden = true;
  el.equation.textContent = lot.text;
  say('按住一根火柴的端头，拖到一个空位上。等号那两根不动。');
}

function renderReadout() {
  const lot = app.lot;
  const g = app.game;
  const rec = save.recordFor(lot.id);
  el.crumbs.innerHTML = `${app.label}<b>${tierLabel(lot.tier)}<span class="band"> · ${lot.spec}</span></b>`;
  el.readout.innerHTML = [
    field('已搬', g.moves(), '本局'),
    field('最少', lot.par, lot.proof === 'exhaustive-1' ? '穷举一层' : '逐层穷举', 'par'),
    field('一步解', lot.n1 === null ? '—' : lot.n1, '穷举计数'),
    field('最佳', rec ? `${rec.best.moves} 搬` : '—', rec && rec.best.moves <= lot.par ? '已达最少' : '你的纪录', 'best'),
    field('局面', lot.states === null ? '—' : lot.states, '可达合法版面'),
    field('提示', g.hints(), '次'),
  ].join('');
  el.undo.disabled = !g.moves() || g.solved();
  el.hint.disabled = g.solved();
}

function field(label, value, note, cls = '') {
  return `<div class="${cls}"><dt>${label}</dt><dd>${value}</dd><dt><small>${note}</small></dt></div>`;
}

function renderTotals() {
  const s = save.stats();
  const total = campaignLength();
  // `solvedIds` is the record index itself; the ids that no longer resolve to a baked lot are
  // still in the file (an old save survives a re-bake) but they are not lots you can show.
  const solved = save.solvedIds();
  const done = allLots().filter((l) => solved.has(l.id)).length;
  el.totals.innerHTML = `已解 <b>${done}</b>/${total} · 完美 <b>${s.perfect}</b> · 拒绝 <b>${s.refused}</b>`;
}

function renderShelf() {
  if (app.mode === 'campaign') {
    const unlocked = save.unlocked();
    const list = campaign();
    let html = '';
    for (const t of tiers()) {
      if (!t.count) continue;
      html += `<p class="tier">${t.label} · ${t.blurb}（${t.par} 搬）</p>`;
      for (let n = 1; n <= list.length; n++) {
        const lot = list[n - 1];
        if (lot.tier !== t.key) continue;
        const rec = save.recordFor(lot.id);
        const cls = [
          n === app.index ? 'here' : '',
          rec && rec.best.moves <= lot.par ? 'perfect' : rec ? 'done' : '',
        ].filter(Boolean).join(' ');
        html += `<button type="button" data-index="${n}" class="${cls}" ${n > unlocked ? 'disabled' : ''}>${n}</button>`;
      }
    }
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-index]').forEach((b) => {
      b.addEventListener('click', () => go(`#/c/${b.dataset.index}`));
    });
    return;
  }
  if (app.mode === 'random') {
    let html = '<p class="tier">选一档难度（都是穷举量出来的）</p>';
    for (const t of tiers()) {
      if (!t.count) continue;
      const on = t.key === app.route.tier ? 'here' : '';
      html += `<button type="button" class="${on}" data-tier="${t.key}">${t.label}<br><small>${t.par} 搬 · ${t.count} 题</small></button>`;
    }
    html += '<button type="button" class="wide" data-reroll="1">换一题</button>';
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-tier]').forEach((b) => {
      b.addEventListener('click', () => go(`#/random/${b.dataset.tier}/${token()}`));
    });
    el.shelf.querySelector('[data-reroll]').addEventListener('click', () => go(`#/random/${app.route.tier}/${token()}`));
    return;
  }
  if (app.mode === 'daily') {
    // `dailyOf` is the day-stamp written at the moment of victory, so this line is the only
    // thing that tells a player today has already been done on this device.
    const doneId = save.dailyOf(app.day);
    const doneRec = doneId ? save.recordFor(doneId) : null;
    el.shelf.innerHTML = '<p class="tier">今天这一题对所有人相同（日期哈希，无服务器）</p>'
      + (doneId ? `<p class="tier">今天已通过：<b>${doneId}</b>${doneRec ? ` · ${doneRec.best.moves} 搬` : ''}</p>` : '')
      + `<button type="button" class="wide" data-back="1">回到战役 第 ${save.unlocked()} 题</button>`;
  } else {
    el.shelf.innerHTML = '<p class="tier">别人分享给你的这一题</p>';
  }
  const back = el.shelf.querySelector('[data-back]');
  if (back) back.addEventListener('click', () => go(`#/c/${save.unlocked()}`));
}

function render() {
  el.modes.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.mode === app.mode));
  });
  renderReadout();
  renderTotals();
  renderShelf();
}

// The one place a move happens: a drag from the view, a tap-tap, and a test route played
// through window.matchwork all arrive here.
function commit(off, on) {
  const res = app.game.apply(off, on);
  if (!res.ok) {
    refuse(res.reason, off);
    view.redraw();
    renderReadout();
    return false;
  }
  app.drags++;
  save.bump('drags');
  el.equation.textContent = showState(app.game.shape, app.game.state());
  if (app.game.solved()) {
    view.redraw();
    finish();
    return true;
  }
  view.redraw();
  renderReadout();
  const left = app.lot.par - app.game.moves();
  say(`第 <b>${app.game.moves()}</b> 搬完成 · ${left > 0 ? `离最少还差 ${left} 搬` : '已经不少于最少搬数了，继续或撤销'}`);
  return true;
}

function stars(n) {
  return '★'.repeat(n) + '☆'.repeat(Math.max(0, 3 - n));
}

function finish() {
  const lot = app.lot;
  const g = app.game;
  const gr = g.grade();
  // The route you actually took is re-checked against the rules before anything is
  // recorded, so the victory card cannot be built on a UI bug.
  const honest = g.verifyRoute(g.history());
  if (!honest) {
    say('你的这一步序列没有让等式成立——这不是应该发生的，请刷新页面。', true);
    return;
  }
  const rec = save.solve(lot.id, { moves: gr.moves, hints: gr.hints, par: lot.par });
  if (app.day) save.markDaily(app.day, lot.id);
  let nextIndex = 0;
  if (app.mode === 'campaign') {
    save.unlockTo(app.index + 1);
    if (app.index < campaignLength()) nextIndex = app.index + 1;
  }
  const quality = gr.perfect ? 3 : gr.optimal ? 2 : 1;
  el.stars.textContent = stars(quality);
  el.verdict.textContent = gr.perfect ? `正好 ${lot.par} 搬，一次提示都没要`
    : gr.optimal ? `${lot.par} 搬完成，用了 ${gr.hints} 次提示`
      : `解出来了：${gr.moves} 搬，最少 ${lot.par} 搬`;
  el.tally.innerHTML = `你的 <b>${gr.moves}</b> 搬 · 穷举最少 <b>${lot.par}</b> 搬 · 提示 <b>${gr.hints}</b> 次`
    + `<br>这一步数是怎么来的：<b>${lot.proof}</b>`
    + (rec.improved ? '<br>这是这一题的最好成绩' : '');
  el.next.hidden = !nextIndex;
  el.curtain.hidden = false;
  render();
}

function go(hash) {
  if (location.hash === hash) apply();
  else location.hash = hash;
}

function apply() {
  const rt = parseHash();
  app.route = rt;
  app.mode = rt.mode;
  if (rt.mode === 'random' && !rt.key) {
    // A bare #/random/tangle would mean a different puzzle on every visit and an
    // unreproducible link, so the token is minted once and written back into the URL.
    location.replace(`${location.pathname}${location.search}#/random/${rt.tier}/${token()}`);
    return;
  }
  const r = resolve(rt);
  if (!r.lot) {
    say('这一档还没有烤好的题', true);
    return;
  }
  app.day = r.day || null;
  app.label = r.label;
  app.index = rt.mode === 'campaign' ? rt.index : campaign().findIndex((l) => l.id === r.lot.id) + 1;
  setGame(r.lot);
  render();
}

function token() {
  return Math.random().toString(36).slice(2, 8);
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

function shareLink() {
  const url = `${location.origin}${location.pathname}#/lot/${app.lot.id}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('链接已复制'), () => toast(url));
  } else {
    toast(url);
  }
}

el.modes.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mode]');
  if (!b) return;
  if (b.dataset.mode === 'campaign') go(`#/c/${clampIndex(save.unlocked())}`);
  else if (b.dataset.mode === 'daily') go('#/daily');
  else go(`#/random/${tiers()[0].key}/${token()}`);
});

el.undo.addEventListener('click', () => {
  if (app.game.undo()) {
    view.redraw();
    el.equation.textContent = showState(app.game.shape, app.game.state());
    renderReadout();
    say(app.game.moves() ? `退回一步，现在 ${app.game.moves()} 搬` : '回到最初那副摆法');
  } else {
    refuse(app.game.refusal());
  }
});

el.hint.addEventListener('click', () => {
  const h = app.game.hint();
  if (!h) {
    say('从当前这一步出发，穷举在预算内跑不完，所以不敢告诉你下一步——撤销或重开吧。', true);
    return;
  }
  save.bump('hints');
  view.showHint(h.off, h.on);
  say(`提示：把 <b>${nameOf(h.off)}</b> 搬到 <b>${nameOf(h.on)}</b> ——这是某条最短解的第一步，之后还差 <b>${h.left - 1}</b> 搬`);
  renderReadout();
});

function restart() {
  app.game.restart();
  view.attach(app.game);
  el.curtain.hidden = true;
  render();
  say('回到最初那副摆法');
}

el.restart.addEventListener('click', restart);
el.share.addEventListener('click', shareLink);
el.again.addEventListener('click', restart);
el.next.addEventListener('click', () => go(`#/c/${Math.min(campaignLength(), app.index + 1)}`));

// Wiping the save is the one destructive thing this game can do, so it asks twice instead
// of firing on a stray click.
let wipeArmed = false;
el.wipe.addEventListener('click', () => {
  if (!wipeArmed) {
    wipeArmed = true;
    toast('再点一次会清空本机全部成绩');
    setTimeout(() => { wipeArmed = false; }, 4000);
    return;
  }
  save.reset();
  wipeArmed = false;
  toast('存档已清空');
  apply();
});

window.addEventListener('hashchange', apply);
window.addEventListener('resize', () => view.measure());
// A page that grows a vertical scrollbar after first paint narrows its content by ~15px without
// firing window 'resize' (the window itself did not change), which on a CI runner left measure()
// holding a 592px backing store inside a 577px box. Observing the canvas catches that reflow.
const layoutCanvas = view.canvas || document.querySelector('canvas');
if (layoutCanvas && typeof ResizeObserver === 'function') {
  new ResizeObserver(() => view.measure()).observe(layoutCanvas);
}
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  if (k === 'escape' && !el.curtain.hidden) el.curtain.hidden = true;
  else if (k === 'u') el.undo.click();
  else if (k === 'h') el.hint.click();
  else if (k === 'r') el.restart.click();
});

view.start();
// Deliberately not paused on visibilitychange: the win card and the hint pulse are driven
// from the same loop, and a tab that reports itself hidden (headless Chrome does) must
// still be able to finish a puzzle.
apply();

const badRows = rejected();
if (badRows.length) console.error(`library: ${badRows.length} baked rows failed re-verification: ${badRows.join('; ')}`);
const unsound = auditProofs();
if (unsound.length) console.error(`library: rows without a complete proof: ${unsound.join('; ')}`);

window.matchwork = {
  version: 1,
  get state() {
    const g = app.game;
    const lot = app.lot;
    return {
      mode: app.mode,
      label: app.label,
      id: lot && lot.id,
      tier: lot && lot.tier,
      index: app.index,
      moves: g && g.moves(),
      par: lot && lot.par,
      proof: lot && lot.proof,
      n1: lot && lot.n1,
      states: lot && lot.states,
      space: lot && lot.space,
      hints: g && g.hints(),
      picked: g && g.picked(),
      lit: g && g.lit(),
      segments: lot && lot.segments,
      spec: lot && lot.spec,
      text: g ? showState(g.shape, g.state()) : null,
      solved: !!(g && g.solved()),
      curtain: !el.curtain.hidden,
      unlocked: save.unlocked(),
      solvedCount: allLots().filter((l) => save.recordFor(l.id)).length,
      refused: app.refused,
      drags: app.drags,
      badRows: badRows.length,
      unsound: unsound.length,
      volatile: save.isVolatile(),
    };
  },
  get pool() { return poolStats(); },
  get store() { return save.snapshot(); },
  campaign() { return campaign().map((l) => l.id); },
  tiers() { return tiers(); },
  load(hash) { go(hash); return app.lot && app.lot.id; },
  lot() {
    if (!app.lot) return null;
    return { id: app.lot.id, spec: app.lot.spec, par: app.lot.par, proof: app.lot.proof, text: app.lot.text };
  },
  segmentEnds(i) { return view.segmentEnds(i); },
  // Which slot a client-space point means, so the pointer test can prove it pressed the
  // stick it intended instead of trusting the pixel maths twice.
  slotAt(x, y) { return view.slotAtClient(x, y); },
  // The proved-shortest route baked into this lot's row, verbatim.
  path() { return app.lot ? app.lot.route.map((m) => ({ off: m.off, on: m.on })) : null; },
  // Play a route through the same commit() a finger uses — never a direct state write, so
  // the test drives the real path including its refusals.
  play(route) {
    let applied = 0;
    for (const m of route || []) {
      if (!commit(m.off, m.on)) break;
      applied++;
    }
    return { applied, moves: app.game.moves(), solved: app.game.solved() };
  },
  pick(i) { return app.game.pick(i); },
  drop(off, on) { return commit(off, on); },
  hintOnce() { el.hint.click(); return { hints: app.game.hints(), line: el.hintline.textContent }; },
  // Recompute the proof for the lot on screen, from the serialised spec+state the page is
  // actually holding. `npm test` does the same thing without a browser; this is the check
  // that the number on screen matches what this build's solver says right now.
  reprove() {
    const lot = app.lot;
    const st = app.game ? app.game.state() : null;
    if (!lot || !st) return null;
    return parOf(app.game.shape, st);
  },
  // Exposed for the console and for tests: is the board legal, and does it hold?
  probe() {
    const g = app.game;
    return { legal: g ? legal(g.shape, g.state()) : null, holds: g ? holds(g.shape, g.state()) : null };
  },
  save,
};
