// Minimal zero-dep CDP driver for headless playtesting (Node 21+ global WebSocket/fetch).
// No Playwright, no npm install: the whole browser layer is one WebSocket and JSON calls.
//
// env: CDP_PORT (devtools port, default 9345), BASE_URL (page to attach to, default
//      http://127.0.0.1:5185/)
// usage:
//   node playtest.mjs open  <url>              # reuse-or-create our page and navigate
//   node playtest.mjs nav   <url>
//   node playtest.mjs eval  '<js expression>'  # pass `nonav` as argv[4] to skip the reload
//   node playtest.mjs eval  '@boot'            # | @play | @routes | @save
//   node playtest.mjs eval  '@pointer'         # real Input.dispatchMouseEvent drags
//   node playtest.mjs drag  <off>,<on>         # one real drag of match <off> onto slot <on>
//   node playtest.mjs shot  <path.png>
//   node playtest.mjs logs
//
// Every scenario reports { rows, fail } in the same shape as tools/harness.mjs, so
// tools/verify.sh aggregates node suites and browser suites on one line.
const PORT = process.env.CDP_PORT || 9345;
// Which page to attach to. Hard-coding the dev-server port silently evaluates against a
// fresh about:blank tab when pointed at any other origin.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5185/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 40000);
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];
const arg = process.argv[3];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One real mouse event at a client-space coordinate. `clickCount` must be 1 on the press and
// 0 on the release: with a constant 1 Chrome reads every release as the second half of a
// double click, and the view's pointer pipeline never sees a clean single drag.
const mouseAt = (cdp, sessionId, type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', {
  type, x: Math.round(x), y: Math.round(y), button: 'left', buttons,
  clickCount: type === 'mouseReleased' ? 0 : 1,
}, sessionId);

// Where the pointer has to be to mean a given stick, according to the page itself.
const midOf = (runJS, i) => runJS(`(() => { const e = window.matchwork.segmentEnds(${i}); return e && e.mid; })()`);

// Drag match `off` onto slot `on` with the real pointer, in `steps` mousemove events. `end`
// overrides the release point, which is how the off-the-board case is reached without
// inventing a second gesture model in the test.
async function dragStick(cdp, sessionId, runJS, off, on, { end = null, steps = 4, hold = 40, rest = 90 } = {}) {
  const from = await midOf(runJS, off);
  const to = end || (on === null || on === undefined ? null : await midOf(runJS, on));
  if (!from || !to) return null;
  await mouseAt(cdp, sessionId, 'mousePressed', from.x, from.y, 1);
  await sleep(hold);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    await mouseAt(cdp, sessionId, 'mouseMoved', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 1);
    await sleep(20);
  }
  await sleep(hold);
  await mouseAt(cdp, sessionId, 'mouseReleased', to.x, to.y, 0);
  await sleep(rest);
  return { from, to };
}

// Press and release one point in place, with no drag in between.
async function pressAt(cdp, sessionId, x, y, hold = 30, rest = 80) {
  await mouseAt(cdp, sessionId, 'mousePressed', x, y, 1);
  await sleep(hold);
  await mouseAt(cdp, sessionId, 'mouseReleased', x, y, 0);
  await sleep(rest);
}

async function main() {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* gone already */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Wait on the shell, not on a timer. The page is a module graph fetched over the network:
  // a fixed sleep is long enough for a localhost server and too short for GitHub Pages, where
  // it made an innocent deployment look broken (`window.matchwork` still undefined and the
  // canvas still the unstyled 300x150 default the HTML spec hands out).
  const waitShell = async (floorMs, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.matchwork && window.matchwork.state && window.matchwork.state.id)');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url: arg || BASE }, sessionId);
    await waitShell(600);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url: arg }, sessionId);
    await waitShell(400);
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'drag') {
    // One real drag against the page that is already open (no navigation, so the game keeps
    // running between commands). Same primitive @pointer uses, on the command line: the win
    // screenshot a human reviews can then be produced by a finger, not by an injected call.
    const [off, on] = String(arg || '').split(',').map((x) => Number(x));
    if (!Number.isInteger(off) || !Number.isInteger(on)) {
      console.log('drag wants "<off>,<on>", got: ' + arg);
      process.exit(1);
    }
    const used = await dragStick(cdp, sessionId, runJS, off, on);
    if (!used) {
      console.log('EVAL THROW: no match ' + off + ' or slot ' + on + ' on screen');
      process.exit(1);
    }
    const now = await runJS(`(() => { const s = window.matchwork.state;
      return s.text + ' | ' + s.moves + '/' + s.par + ' solved=' + s.solved + ' lit=' + s.lit; })()`);
    console.log(`dragged ${off} -> ${on}: (${Math.round(used.from.x)},${Math.round(used.from.y)}) -> (${Math.round(used.to.x)},${Math.round(used.to.y)})\n  ${now}`);
  } else if (cmd === 'eval') {
    if (process.argv[4] !== 'nonav') {
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      await waitShell(300);
    }
    if (arg && arg.startsWith('@')) {
      const name = arg.slice(1);
      let value = null;
      if (name === 'pointer') {
        // `rows` live inside pointerScenario, so a throw mid-suite must not cost their result:
        // the array is stashed here as it is filled and the catch hands back what got that far
        // plus the crash itself. Without this the whole @pointer section printed `NO RESULT`
        // and a single bad call hid every row behind it.
        try {
          value = await pointerScenario(cdp, sessionId, runJS);
        } catch (err) {
          value = { rows: (lastPointerRows || []).slice() };
          value.rows.push({ test: '@pointer threw', pass: false, detail: String(err && err.message || err).slice(0, 300) });
        }
      } else if (SCENARIOS[name]) {
        // Clear the row buffer *before* running. With `nonav` every scenario is evaluated in
        // the same page, so if this suite throws at parse time the fallback below would
        // otherwise hand back the previous suite's rows and verify.sh would print them as if
        // they belonged to this one — a broken suite that looks green.
        await runJS('window.__lastRows = null; 1');
        try {
          value = await runJS(SCENARIOS[name]);
        } catch (err) {
          const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
          value = { rows: JSON.parse(dumped) };
          value.rows.push({ test: `@${name} threw`, pass: false, detail: String(err.message).slice(0, 300) });
        }
      } else {
        console.log('unknown scenario ' + name + ' — have ' + Object.keys(SCENARIOS).join(', ') + ', pointer');
        process.exit(1);
      }
      value.fail = (value.rows || []).filter((r) => !r.pass).map((r) => r.test);
      console.log(JSON.stringify(value, null, 2));
    } else {
      try {
        console.log(JSON.stringify(await runJS(arg), null, 2));
      } catch (err) {
        console.log('EVAL THROW: ' + err.message);
      }
    }
    if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  } else if (cmd === 'shot') {
    await runJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    (await import('node:fs')).writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg + ' (' + Math.round(data.length / 1024) + 'kB b64)');
  } else if (cmd === 'logs') {
    await sleep(800);
    console.log(logs.join('\n') || '(none)');
  }
  ws.close();
  process.exit(0);
}

// Installs `window.__held(x, y)`: how many pixels of the in-flight match colour sit in a
// small box around a client-space point. The stick a drag is carrying is drawn in HELD
// (#ffe9b0); an empty slot is drawn as a dashed outline in four other colours, so a count of
// HELD pixels *at the pointer* is the only way to ask "did the match follow the finger"
// without reading the view's private state.
//
// The readback goes through a scratch canvas created with `willReadFrequently: true`. Reading
// the *game* canvas with getImageData is exactly what makes Chrome log
// "Canvas2D: Multiple readback operations using getImageData are faster with the
// willReadFrequently attribute set to true", and a console that is not clean fails the run —
// so the game canvas is never read directly.
const HELD_PROBE = `window.__readback = (sx, sy, w, h) => {
  const c = document.getElementById('lot');
  const s = window.__scratch || (window.__scratch = document.createElement('canvas'));
  s.width = w; s.height = h;
  const x = Math.max(0, Math.min(c.width - w, sx | 0));
  const y = Math.max(0, Math.min(c.height - h, sy | 0));
  const ctx = s.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(c, x, y, w, h, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
};
window.__held = (x, y) => {
  const c = document.getElementById('lot'); const b = c.getBoundingClientRect();
  const k = c.width / b.width; const r = Math.round(9 * k);
  const sx = Math.round((x - b.left) * k) - r, sy = Math.round((y - b.top) * k) - r;
  const d = window.__readback(sx, sy, 2 * r, 2 * r);
  let n = 0;
  for (let p = 0; p < d.length; p += 4) {
    if (Math.abs(d[p] - 255) < 24 && Math.abs(d[p + 1] - 233) < 24 && Math.abs(d[p + 2] - 176) < 30) n++;
  }
  return n;
}; 1`;

let lastPointerRows = null;

// ---------------------------------------------------------------------------
// The one suite a page-side script cannot run: real input. Everything below goes through
// Chrome's own mouse and keyboard over CDP, so what gets asserted is the pointer-to-matchstick
// wiring in js/view.js rather than the rule behind it. This game's gesture is a *drag*, so
// unlike the rest of the batch this suite drags: press a stick's middle, carry it across the
// felt in several real mousemove events, and let go.
// ---------------------------------------------------------------------------
async function pointerScenario(cdp, sessionId, runJS) {
  const rows = [];
  lastPointerRows = rows;
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  const mouse = (type, x, y, buttons) => mouseAt(cdp, sessionId, type, x, y, buttons);
  const st = () => runJS('window.matchwork.state');
  const said = () => runJS(`document.getElementById('hintline').textContent`);
  const drag = (off, on, opts) => dragStick(cdp, sessionId, runJS, off, on, opts);
  const board = () => runJS(`(() => { const g = window.matchwork; const s = g.state; return {
    text: s.text, moves: s.moves, lit: s.lit, picked: s.picked, solved: s.solved, id: s.id,
    hints: s.hints, drags: s.drags, refused: s.refused, par: s.par, curtain: s.curtain }; })()`);

  const ids = await runJS(`['lot','modes','totals','crumbs','readout','hintline','curtain','stars','verdict','tally','again','next','undo','hint','restart','share','shelf','wipe','toast','equation']
    .map((i) => [i, !!document.getElementById(i)])`);
  rec('every control the shell reaches for exists', ids.every(([, on]) => on), Object.fromEntries(ids));
  await runJS(HELD_PROBE);

  // A par-1 lot: one proved 搬, so the whole authenticated solution is a single real drag.
  await runJS(`window.matchwork.load('#/c/1'); 'ok'`);
  await sleep(300);
  const start = await runJS(`(() => { const g = window.matchwork; return {
    state: g.state, path: g.path(), ends: Array.from({ length: g.state.segments }, (_, i) => {
      const e = g.segmentEnds(i); return e && { i, lit: e.lit, locked: e.locked, cell: e.cell, mid: e.mid };
    }).filter(Boolean) }; })()`);
  const par = start.state.par;
  rec('a par-1 lot opens with a proved route of exactly one 搬', !!start.state.id && par === 1 && start.path.length === 1,
    { id: start.state.id, par, route: start.path.length });
  rec('the board reports its own geometry, locked bars included', start.ends.length === start.state.segments
    && start.ends.filter((e) => e.locked).length === 2 && start.ends.every((e) => typeof e.lit === 'boolean'),
    { segments: start.ends.length, locked: start.ends.filter((e) => e.locked).map((e) => e.i) });
  rec('the canvas is painted with matches on it', await runJS(`(() => {
    const c = document.getElementById('lot');
    const d = window.__readback(0, 0, c.width, c.height);
    let n = 0;
    for (let p = 0; p < d.length; p += 4) {
      if (Math.abs(d[p] - 216) < 26 && Math.abs(d[p + 1] - 205) < 26 && Math.abs(d[p + 2] - 184) < 30) n++;
    }
    return n > 300;
  })()`), 'stick-coloured pixels sampled off the felt');

  const pickIdx = start.path[0].off;
  const dropIdx = start.path[0].on;

  // Aim self-check: the coordinates this test is about to press must mean the sticks the
  // baked route names, according to the same function the pointer handlers call.
  const aims = await runJS(`(() => { const g = window.matchwork;
    const a = g.segmentEnds(${pickIdx}), b = g.segmentEnds(${dropIdx});
    return { a: g.slotAt(a.mid.x, a.mid.y), b: g.slotAt(b.mid.x, b.mid.y), aLit: a.lit, bLit: b.lit, bLocked: b.locked }; })()`);
  rec('the press point means match ' + pickIdx, aims.a === pickIdx && aims.aLit === true, aims);
  rec('the release point means empty slot ' + dropIdx, aims.b === dropIdx && aims.bLit === false && aims.bLocked === false, aims);

  // --- the classic cheat of this genre, refused by a finger rather than by an assertion ----
  const eqBar = start.ends.find((e) => e.locked && e.lit);
  const cheat = await drag(eqBar.i, dropIdx);
  const afterCheat = await board();
  rec('pressing an `=` bar and dragging it away lifts nothing', !!cheat && afterCheat.moves === 0 && afterCheat.solved === false,
    { seg: eqBar.i, at: cheat && [cheat.from.x, cheat.from.y], board: afterCheat });
  rec('the shell says the equals bars are locked', /等号/.test(await said()), await said());
  rec('so the total match count cannot be smuggled down', afterCheat.lit === start.state.lit, { before: start.state.lit, after: afterCheat.lit });

  // --- a press where there is nothing to hold ----------------------------------------------
  // `down()` magnetically grabs the nearest *lit* segment within 0.42 units, so "empty felt"
  // has to be a point that is out of reach of every stick — found by asking the page, not by
  // assuming a corner is free.
  const far = await runJS(`(() => { const g = window.matchwork; const c = document.getElementById('lot');
    const b = c.getBoundingClientRect();
    for (let x = b.left + 3; x < b.right - 3; x += 5) {
      for (let y = b.top + 3; y < b.bottom - 3; y += 5) {
        if (g.slotAt(x, y) === null) return { x: Math.round(x), y: Math.round(y) };
      }
    }
    return null; })()`);
  rec('there is bare felt on this board at all', !!far, far);
  if (far) {
    await pressAt(cdp, sessionId, far.x, far.y);
    const afterBare = await board();
    rec('a press on bare felt lifts nothing and spends nothing', afterBare.moves === 0 && afterBare.picked === null, afterBare);
  }

  // --- the in-flight stick follows the pointer --------------------------------------------
  const before = await board();
  // Recorded here so the over-drag below can be shown not to have moved anything that is not
  // supposed to move: the canvas box, its backing store, and the document scroll.
  const geom = await runJS(`(() => { const c = document.getElementById('lot'); const b = c.getBoundingClientRect();
    return { w: c.width, h: c.height, left: Math.round(b.left), top: Math.round(b.top) }; })()`);
  const a = await midOf(runJS, pickIdx);
  const b = await midOf(runJS, dropIdx);
  await mouse('mousePressed', a.x, a.y, 1);
  await sleep(40);
  const held = await board();
  rec('a real press on match ' + pickIdx + ' lifts it', held.picked === pickIdx && held.moves === 0, held);
  const near0 = await runJS(`window.__held(${b.x}, ${b.y})`);
  rec('before the pointer moves, the match has not moved either', near0 <= 4, { heldPixelsAtTarget: near0 });
  await mouse('mouseMoved', (a.x + b.x) / 2, (a.y + b.y) / 2, 1);
  await sleep(40);
  await mouse('mouseMoved', b.x, b.y, 1);
  await sleep(60);
  const near1 = await runJS(`window.__held(${b.x}, ${b.y})`);
  rec('the held match travels with the pointer', near1 >= 25, { heldPixelsAtTarget: near1 });

  // --- over-drag: let go past the board, then let go on the target -------------------------
  const overshoot = await runJS(`(() => { const c = document.getElementById('lot'); const b = c.getBoundingClientRect();
    const x = Math.min(b.right + 24, innerWidth - 4), y = Math.min(b.bottom - 8, innerHeight - 4);
    return { x: Math.round(x), y: Math.round(y), inWindow: x < innerWidth - 1 && y < innerHeight - 1,
             slot: window.matchwork.slotAt(x, y) }; })()`);
  rec('a point past the board edge means no slot at all', overshoot.inWindow && overshoot.slot === null, overshoot);
  await mouse('mouseMoved', overshoot.x, overshoot.y, 1);
  await sleep(50);
  await mouse('mouseReleased', overshoot.x, overshoot.y, 0);
  await sleep(140);
  const afterOver = await board();
  rec('letting go off the board spends nothing', afterOver.text === before.text && afterOver.lit === before.lit && afterOver.moves === 0,
    { before, after: afterOver });
  rec('the stick stays in hand, so the gesture is resumable', afterOver.picked === pickIdx, afterOver);
  // "Over-dragging is absorbed by the boundary" has to mean something checkable, and the honest
  // reading is: extra travel outside the felt buys no authority and no side effect. Nothing is
  // spent (above), the stick is still held (above), and the page itself does not move — the
  // canvas keeps its box and its backing store, and the document never scrolls.
  const bounded = await runJS(`(() => { const c = document.getElementById('lot'); const b = c.getBoundingClientRect();
    return { inside: b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1, w: c.width, h: c.height,
             left: Math.round(b.left), top: Math.round(b.top), scrollX: scrollX, scrollY: scrollY }; })()`);
  rec('the over-drag left the layout exactly where it was', bounded.inside && bounded.scrollX === 0 && bounded.scrollY === 0
    && bounded.w === geom.w && bounded.h === geom.h && bounded.left === geom.left && bounded.top === geom.top,
    { now: bounded, started: geom });
  // The release already ended the drag; this press is the second tap of the tap-then-tap
  // gesture the view shares with dragging, and it commits through the same onCommit path.
  await mouse('mousePressed', b.x, b.y, 1);
  await sleep(30);
  await mouse('mouseReleased', b.x, b.y, 0);
  await sleep(180);
  const afterBack = await board();
  rec('carrying it back and letting go on slot ' + dropIdx + ' is the 搬', afterBack.moves === 1 && afterBack.solved === true, afterBack);
  rec('the board it lands on is legal, and the `=` bars are intact', await runJS(`(() => { const p = window.matchwork.probe();
    return p.legal === null && p.holds === true; })()`), await runJS('window.matchwork.probe()'));
  rec('the equation on screen is the equation that holds', afterBack.text !== before.text && afterBack.text === await runJS(`document.getElementById('equation').textContent`),
    { before: before.text, after: afterBack.text });

  const win = await runJS(`(() => { const g = window.matchwork; return {
    curtain: !document.getElementById('curtain').hidden, stars: document.getElementById('stars').textContent,
    verdict: document.getElementById('verdict').textContent, tally: document.getElementById('tally').textContent,
    rec: g.save.recordFor(g.state.id), drags: g.state.drags,
  }; })()`);
  rec('the victory card goes up after the real drag', win.curtain && win.stars === '★★★', { curtain: win.curtain, stars: win.stars });
  rec('the card prints the player count against the measured minimum', /你的 1 搬/.test(win.tally) && /穷举最少 1 搬/.test(win.tally), win.tally);
  rec('a finger-solved lot is on record at par with no hints', !!win.rec && win.rec.best.moves === 1 && win.rec.best.hints === 0, win.rec);
  rec('one drag billed one move, not one per mousemove', win.drags === 1, { drags: win.drags });

  // --- a two-搬 campaign lot, walked entirely by real input --------------------------------
  await runJS(`window.matchwork.save.reset(); window.matchwork.load('#/c/25'); 'ok'`);
  await sleep(320);
  const two = await runJS(`(() => { const g = window.matchwork; return { state: g.state, path: g.path() }; })()`);
  rec('a par-2 lot opens with a two-搬 proved route', two.state.par === 2 && two.path.length === 2,
    { par: two.state.par, route: two.path.length, id: two.state.id });
  let billed = 0;
  const steps = [];
  for (const m of two.path) {
    const used = await drag(m.off, m.on);
    const now = await board();
    billed = now.moves;
    steps.push({ pair: m.off + '->' + m.on, moves: now.moves, solved: now.solved, at: used && [used.from.x, used.to.x] });
    if (now.moves !== steps.length) break;
    await sleep(140);
  }
  rec('the whole certified par-2 route is reachable by dragging', billed === 2 && steps.length === 2, steps);
  const twoCard = await runJS(`(() => { const g = window.matchwork; return { s: g.state,
    tally: document.getElementById('tally').textContent, stars: document.getElementById('stars').textContent,
    rec: g.save.recordFor(g.state.id) }; })()`);
  rec('the par-2 card prints its own arithmetic', twoCard.s.solved && /你的 2 搬/.test(twoCard.tally) && /穷举最少 2 搬/.test(twoCard.tally)
    && twoCard.stars === '★★★', { tally: twoCard.tally, stars: twoCard.stars });
  rec('two real drags left the match count alone', await runJS('window.matchwork.state.lit') === two.state.lit,
    { before: two.state.lit, after: await runJS('window.matchwork.state.lit') });
  rec('the second lot solved by hand is on record at par', !!twoCard.rec && twoCard.rec.best.moves === 2, twoCard.rec);

  // Undo has to be reachable by hand too, and only when the shell allows it.
  await runJS(`document.getElementById('restart').click(); 'ok'`);
  await sleep(160);
  rec('重开 drops the card and returns the opening equation', (await board()).moves === 0 && (await board()).text === two.state.text, await board());
  await drag(two.path[0].off, two.path[0].on);
  const afterStep1 = await board();
  rec('a single real 搬 on the par-2 lot is billed and does not finish it', afterStep1.moves === 1 && afterStep1.solved === false, afterStep1);
  const undoEnabled = await runJS(`!document.getElementById('undo').disabled`);
  rec('撤销 is enabled exactly when there is a 搬 to take back', undoEnabled === true, { undoEnabled });
  await runJS(`document.getElementById('undo').click(); 'ok'`);
  await sleep(160);
  const undone = await board();
  rec('a real click on 撤销 takes the 搬 and the board back', undone.moves === 0 && undone.text === two.state.text, undone);
  rec('and the button disables itself again at the start of the route', await runJS(`document.getElementById('undo').disabled`) === true, await runJS(`document.getElementById('undo').disabled`));

  // Dropping onto a slot that already holds a match: the view only ever aims at dark slots, so
  // a drag onto a lit one silently springs back. The model, asked directly, refuses out loud.
  const litA = await runJS(`(() => { const g = window.matchwork; for (let i = 0; i < g.state.segments; i++) {
    const e = g.segmentEnds(i); if (e && e.lit && !e.locked) return i; } return null; })()`);
  const litB = await runJS(`(() => { const g = window.matchwork; let n = 0; for (let i = 0; i < g.state.segments; i++) {
    const e = g.segmentEnds(i); if (e && e.lit && !e.locked) { n++; if (n === 2) return i; } } return null; })()`);
  const darkA = await runJS(`(() => { const g = window.matchwork; for (let i = 0; i < g.state.segments; i++) {
    const e = g.segmentEnds(i); if (e && !e.lit && !e.locked) return i; } return null; })()`);
  const beforeNo = await board();
  await drag(litA, litB);
  const afterNo = await board();
  rec('dragging one lit match onto another lit slot is not a 搬', afterNo.moves === beforeNo.moves && afterNo.text === beforeNo.text,
    { from: litA, onto: litB, after: afterNo });
  rec('the spring-back leaves the stick in hand, not on the board', afterNo.picked === litA, afterNo);
  // Illegal operations, asked for one at a time, with the line the shell printed kept next to
  // each one. Reading the toast only *after* the whole batch would have been self-deluding: the
  // restart below (and 重开 in general) overwrites the hint line, so a single final read cannot
  // tell you which rule spoke — which is the whole point of "a finger cannot cheat this game".
  const rules = [
    ['same slot', litA, litA, /原地不动/],
    ['occupied target', litA, litB, /已经有一根/],
    ['dark source', darkA, litB, /本来就不在/],
    ['locked equals bar', eqBar.i, darkA, /等号|锁死/],
  ];
  const refusedBefore = await runJS('window.matchwork.state.refused');
  const seen = {};
  for (const [name, a, b] of rules) {
    const res = await runJS(`window.matchwork.drop(${a}, ${b})`);
    seen[name] = { refused: res === false, line: await said() };
  }
  rec('the shell refuses same-slot, occupied-target, dark-source and equals-bar pairs',
    rules.every(([n]) => seen[n].refused), seen);
  rec('and each refusal names the rule that blocked it',
    rules.every(([n, , , re]) => re.test(seen[n].line)), seen);
  const afterRefusals = await board();
  rec('none of those four cost a 搬', afterRefusals.moves === beforeNo.moves && afterRefusals.solved === false,
    { before: beforeNo.moves, after: afterRefusals.moves });
  rec('and they are counted as refusals, not as progress',
    afterRefusals.drags === beforeNo.drags && afterRefusals.refused === refusedBefore + rules.length,
    { drags: afterRefusals.drags, refused: afterRefusals.refused, was: refusedBefore });
  await runJS(`document.getElementById('restart').click(); 'ok'`);
  await sleep(140);
  const rewound = await board();
  // The lot on screen is the par-2 one by now, so the opening equation to compare against is the
  // one *this* lot printed — not the first lot the suite loaded.
  const openingNow = await runJS('window.matchwork.lot().text');
  rec('重开 rewinds to the false opening equation the lot printed',
    rewound.moves === 0 && rewound.text === openingNow && rewound.solved === false, { ...rewound, opening: openingNow });

  // Keyboard, dispatched for real. A reload of the *same* hash does not rebuild the session
  // (location.hash is already that value, so no hashchange fires), so the way to get a session
  // with a zeroed hint counter is to visit another rung and come back.
  const key = (k) => cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', text: k, key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0),
  }, sessionId);
  await runJS(`window.matchwork.load('#/c/2'); 'ok'`);
  await sleep(160);
  await runJS(`window.matchwork.load('#/c/1'); 'ok'`);
  await sleep(220);
  const fresh = await board();
  rec('a reloaded lot starts its own walk and its own hint counter', fresh.moves === 0 && fresh.hints === 0 && fresh.solved === false, fresh);
  await key('h');
  await sleep(240);
  const hinted = await board();
  const hintText = await said();
  rec('the h key bills exactly one hint', hinted.hints === fresh.hints + 1 && hinted.moves === 0, { hints: hinted.hints, line: hintText.slice(0, 60) });
  rec('and the hint names two sticks instead of guessing at one', /提示/.test(hintText) && /搬到/.test(hintText), hintText.slice(0, 90));
  await key('r');
  await sleep(200);
  const afterR = await board();
  rec('the r key restarts the walk without erasing the hint it paid for',
    afterR.moves === 0 && afterR.hints === 1 && afterR.solved === false, afterR);
  await drag(pickIdx, dropIdx);
  const won = await board();
  rec('a par-1 lot is winnable by the same gesture', won.solved === true && won.moves === 1, won);
  await key('u');
  await sleep(180);
  const afterU = await board();
  rec('u cannot erase a solve: 撤销 is disabled the moment the lot is won',
    afterU.moves === 1 && afterU.solved === true && (await runJS('document.getElementById("undo").disabled')) === true, afterU);

  // A keyboard undo needs a walk that is not finished, so take it on the par-2 lot.
  await runJS(`window.matchwork.load('#/c/25'); 'ok'`);
  await sleep(240);
  const twoFresh = await board();
  rec('the par-2 lot opens unfinished, so there is something to take back',
    twoFresh.moves === 0 && twoFresh.solved === false && twoFresh.par === 2, twoFresh);
  await key('u');
  await sleep(140);
  rec('the u key cannot undo past the first position', (await board()).moves === 0, await board());
  await drag(two.path[0].off, two.path[0].on);
  const oneStep = await board();
  rec('one real 搬 on the par-2 lot is billed and leaves it false', oneStep.moves === 1 && oneStep.solved === false, oneStep);
  await key('u');
  await sleep(200);
  const steppedBack = await board();
  rec('the u key takes a real 搬 back', steppedBack.moves === 0 && steppedBack.text === two.state.text, steppedBack);
  await drag(two.path[0].off, two.path[0].on);
  await drag(two.path[1].off, two.path[1].on);
  const wonAgain = await board();
  rec('and the same two drags win the par-2 lot twice in a row', wonAgain.solved === true && wonAgain.moves === 2, wonAgain);

  return { rows };
}

// ---------------------------------------------------------------------------
// In-page suites. Each returns { rows: [{ test, pass, detail }] }.
//
// ESCAPING NOTE (these bodies are template literals, so they are *source text* the page
// compiles): a regex slash must be written doubled (`\\/`), and a literal backslash as
// `\\\\`. A single backslash is eaten by the template and the suite then dies at parse time,
// which reads as a broken page rather than as a broken test. And no backtick anywhere inside a
// body — not even in a comment, because a template literal does not know about comments — or the
// literal ends mid-suite and node --check points at a line that reads like prose.
// ---------------------------------------------------------------------------
const SCENARIOS = {
  boot: `(async () => {
    const g = window.matchwork;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const D = (id) => document.getElementById(id);
    // Pixel sampling goes through a scratch canvas flagged willReadFrequently, never through
    // the game canvas's own context: reading the live canvas is what makes Chrome log a
    // performance warning, and a non-clean console fails the run.
    const readback = (sx, sy, w, h) => {
      const src = D('lot');
      const s = window.__scratch || (window.__scratch = document.createElement('canvas'));
      s.width = w; s.height = h;
      const ctx = s.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(src, Math.max(0, sx | 0), Math.max(0, sy | 0), w, h, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    };
    rec('the shell boots straight into a game', !!g && g.version === 1 && !!g.state && g.state.mode === 'campaign', g && g.state);
    const s = g.state;
    rec('the boot lot carries a measured par and a proof label', s.par >= 1 && /^exhaustive-/.test(s.proof), { par: s.par, proof: s.proof });
    rec('a lot opens unplayed and unsolved', s.moves === 0 && s.solved === false && s.curtain === false && s.hints === 0, s);
    const c = D('lot');
    rec('the canvas has real pixels', c.width > 0 && c.height > 0 && !!c.getContext('2d'), { w: c.width, h: c.height });
    // A canvas whose CSS never loaded is still the 300x150 box the HTML spec hands out, and
    // the board would then be drawn into a strip nobody designed.
    const box = c.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    rec('the canvas is laid out, not the unstyled 300x150 default',
      box.width > 320 && box.height > 200
        && Math.abs(c.width - box.width * dpr) <= dpr + 1 && Math.abs(c.height - box.height * dpr) <= dpr + 1,
      { css: [Math.round(box.width), Math.round(box.height)], backing: [c.width, c.height], dpr });
    rec('the board is actually painted', (() => {
      const d = readback(0, 0, c.width, c.height);
      let n = 0;
      for (let p = 0; p < d.length; p += 16) if (Math.abs(d[p] - 216) < 26 && Math.abs(d[p + 1] - 205) < 26 && Math.abs(d[p + 2] - 184) < 30) n++;
      return n > 60;
    })(), 'sampled stick-coloured pixels');
    const pool = g.pool;
    rec('the baked pool loaded and rejected nothing', !!pool && pool.lots === 60 && pool.rejected === 0, pool && { lots: pool.lots, rejected: pool.rejected });
    rec('no shipped row carries an unfinished proof', s.badRows === 0 && s.unsound === 0 && pool.proofs.join(',') === 'exhaustive-1,exhaustive-bfs',
      { badRows: s.badRows, unsound: s.unsound, proofs: pool.proofs });
    rec('all five bands shipped 12 lots with a measured par', g.tiers().length === 5 && g.tiers().every((t) => t.count === 12 && t.par >= 1),
      g.tiers().map((t) => t.key + ':' + t.par + '/' + t.count));
    const rp = g.reprove();
    rec("the browser's own enumeration agrees with the printed par", rp.par === s.par && rp.complete === true && rp.path.length === s.par,
      { reproof: rp.par, printed: s.par, complete: rp.complete, proof: rp.proof });
    const readout = D('readout').textContent;
    rec('the panel prints 已搬, the measured 最少 and the record', /已搬/.test(readout) && /最少/.test(readout) && /最佳/.test(readout), readout);
    rec('the panel prints where the number came from', /穷举/.test(readout), readout.slice(0, 200));
    rec('the printed equation is the board on screen', D('equation').textContent.replace(/\\s/g, '') === s.text.replace(/\\s/g, ''),
      { dom: D('equation').textContent, state: s.text });
    rec('the probe says the opening board is legal but false', (() => { const p = g.probe(); return p.legal === null && p.holds === false; })(), g.probe());
    rec('the equals bars are locked in the geometry the pointer uses', (() => {
      const locked = []; for (let i = 0; i < s.segments; i++) { const e = g.segmentEnds(i); if (e && e.locked) locked.push(e); }
      return locked.length === 2 && locked.every((e) => e.lit === true);
    })(), 'two lit locked segments');
    rec('the campaign ladder starts at the cheapest lot in the pool', s.index === 1 && s.par === Math.min(...Object.keys(g.pool.byPar).map(Number)),
      { index: s.index, par: s.par, byPar: g.pool.byPar });
    rec('a fresh device saves to disk and says so', g.state.volatile === false && g.save.snapshot().version === 1, { volatile: g.state.volatile });
    return { rows };
  })()`,

  play: `(async () => {
    const g = window.matchwork;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);
    g.save.reset();

    // Lot 25 is the first par-2 rung of the measured ladder: two 搬, which is the cheapest
    // board where "over par" and "a legal move that does not solve" are even expressible.
    g.load('#/c/25'); await sleep(160);
    const par = g.state.par;
    const path = g.path();
    const lit0 = g.state.lit;
    const text0 = g.state.text;
    rec('the par-2 route the page finds is exactly par', path.length === 2 && par === 2, { path: path.length, par });
    rec('every step of that route is a live match onto a real empty slot', path.every((m) => m.off !== m.on
      && (() => { const a = g.segmentEnds(m.off), b = g.segmentEnds(m.on); return !!a && !!b && a.lit && !b.lit && !a.locked && !b.locked; })()), path);
    const half = g.play(path.slice(0, 1));
    rec('the first 搬 is billed and does not solve it', half.applied === 1 && half.moves === 1 && half.solved === false, half);
    rec('the panel says how far is left without saying if it was right', /还差 1 搬/.test(D('hintline').textContent) && !/正确|错了/.test(D('hintline').textContent), D('hintline').textContent);
    const rest = g.play(path.slice(1)); await sleep(180);
    rec('the second 搬 ends it', rest.applied === 1 && rest.moves === 2 && rest.solved === true, rest);
    rec('the match count never changed across the solve', g.state.lit === lit0, { before: lit0, after: g.state.lit });
    rec('the win card goes up at three stars', !D('curtain').hidden && D('stars').textContent === '★★★' && /正好 2 搬/.test(D('verdict').textContent),
      { stars: D('stars').textContent, verdict: D('verdict').textContent });
    rec('the card names the proof behind the number', /穷举最少 2 搬/.test(D('tally').textContent) && /exhaustive/.test(D('tally').textContent), D('tally').textContent);
    const rec1 = g.save.recordFor(g.state.id);
    rec('the run is on record at par with no hints', !!rec1 && rec1.best.moves === 2 && rec1.best.hints === 0, rec1);
    rec('the next button is offered because a rung 25 of 60 is not the end', !D('next').hidden, { nextHidden: D('next').hidden });

    D('restart').click(); await sleep(150);
    rec('重开 clears the count, the card and the board', g.state.moves === 0 && g.state.solved === false && D('curtain').hidden && g.state.text === text0, g.state);

    // A legal 搬 that does not solve: billed, and undone without a trace.
    const wrong = (() => {
      for (let i = 0; i < g.state.segments; i++) {
        const e = g.segmentEnds(i);
        if (!e || e.lit || e.locked) continue;
        const before = g.state.moves;
        if (!g.drop(path[0].off, i)) continue;
        const now = g.state;
        if (now.moves === before + 1 && !now.solved) { D('undo').click(); return { slot: i, text: now.text }; }
        if (now.solved) D('restart').click(); else D('undo').click();
      }
      return null;
    })();
    rec('a legal-but-wrong 搬 exists on this board and is billable', wrong !== null, wrong);
    rec('undoing it returns the exact opening equation', g.state.text === text0 && g.state.moves === 0, { text: g.state.text, moves: g.state.moves });

    // The refusals the rule book actually has, each with its own distinct reason string.
    const idx = (() => {
      const out = { locked: null, dark: null, litA: null, litB: null };
      for (let i = 0; i < g.state.segments; i++) {
        const e = g.segmentEnds(i);
        if (!e) continue;
        if (e.locked && out.locked === null) out.locked = i;
        if (!e.locked && !e.lit && out.dark === null) out.dark = i;
        if (!e.locked && e.lit) { if (out.litA === null) out.litA = i; else if (out.litB === null) out.litB = i; }
      }
      return out;
    })();
    const r0 = { moves: g.state.moves, refused: g.state.refused };
    const eq = g.drop(idx.locked, idx.dark);
    rec('lifting an equals bar is refused', eq === false && /等号/.test(D('hintline').textContent), { idx, said: D('hintline').textContent });
    const same = g.drop(idx.litA, idx.litA);
    rec('a move with nowhere to go is refused', same === false && /原地/.test(D('hintline').textContent), D('hintline').textContent);
    const dup = g.drop(idx.litA, idx.litB);
    rec('dropping onto an occupied slot is refused', dup === false && /已经有一根/.test(D('hintline').textContent), D('hintline').textContent);
    const nop = g.drop(idx.dark, idx.litA);
    rec('lifting a match that is not there is refused', nop === false && /本来就不在/.test(D('hintline').textContent), D('hintline').textContent);
    rec('none of the four cost a move', g.state.moves === r0.moves, { before: r0.moves, after: g.state.moves });
    rec('all four were counted as refusals', g.state.refused === r0.refused + 4, { before: r0.refused, after: g.state.refused });
    rec('the board the refusals left is the board they started from', g.state.text === text0 && g.state.lit === lit0, g.state);

    // The hint is the solver made visible, so it can never promise better than the proof.
    const h = g.hintOnce();
    rec('提示 names a stick and bills itself', h.hints === 1 && /提示：把/.test(h.line) && /之后还差 1 搬/.test(h.line), h);
    g.play(g.path()); await sleep(170);
    const hintedRec = g.save.recordFor(g.state.id);
    rec('a hinted run still wins but loses the perfect flag', g.state.solved && hintedRec.best.hints === 0 && D('stars').textContent === '★★☆'
      && /用了 1 次提示/.test(D('verdict').textContent), { stars: D('stars').textContent, verdict: D('verdict').textContent, rec: hintedRec });
    D('restart').click(); await sleep(150);
    rec('重开 does not launder the hint away', g.state.moves === 0 && g.state.hints === 1, g.state);

    // Over par: spend one 搬 on a wrong move, then let the sweep re-price what is left.
    if (wrong) g.drop(path[0].off, wrong.slot);
    const rp = g.reprove();
    rec('from a wasted 搬 the sweep re-prices the board', g.state.moves === 1 && rp.par >= 1 && rp.complete === true, { spent: g.state.moves, left: rp.par, complete: rp.complete });
    g.play(rp.path); await sleep(180);
    const over = g.state;
    rec('over par still wins, with the gap printed', over.solved === true && over.moves === 1 + rp.par && D('tally').textContent.indexOf('你的 ' + over.moves + ' 搬') >= 0,
      { moves: over.moves, par: over.par, tally: D('tally').textContent });
    rec('a run over par cannot earn the third star', D('stars').textContent === (over.moves === over.par && over.hints === 0 ? '★★★' : over.moves === over.par ? '★★☆' : '★☆☆'),
      { stars: D('stars').textContent, moves: over.moves, par: over.par, hints: over.hints });
    rec('and the record keeps the better of the two runs', g.save.recordFor(g.state.id).best.moves === 2 && g.save.recordFor(g.state.id).moves === over.moves,
      g.save.recordFor(g.state.id));
    rec('undo is disabled on a fresh board', (() => { D('restart').click(); return D('undo').disabled === true; })(), D('undo').disabled);
    return { rows };
  })()`,

  routes: `(async () => {
    const g = window.matchwork;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pars = Object.keys(g.pool.byPar).map(Number).sort((a, b) => a - b);
    const cheapest = pars[0], dearest = pars[pars.length - 1];

    g.load('#/c/1'); await sleep(150);
    rec('#/c/1 is rung one and holds the cheapest lot in the pool', g.state.index === 1 && g.state.par === cheapest, { index: g.state.index, par: g.state.par, cheapest });
    g.load('#/c/12'); await sleep(150);
    rec('#/c/12 is the twelfth lot, not the eleventh', g.state.index === 12 && g.campaign()[11] === g.state.id, { index: g.state.index, id: g.state.id });
    g.load('#/c/60'); await sleep(150);
    rec('the last rung resolves instead of blanking the board', g.state.index === 60 && !!g.state.id && g.state.par === dearest,
      { index: g.state.index, id: g.state.id, par: g.state.par, dearest });
    const ladder = [];
    for (const n of [1, 12, 13, 24, 25, 36, 37, 60]) { g.load('#/c/' + n); await sleep(80); ladder.push(g.state.par); }
    rec('the ladder never gets easier as you climb it', ladder.every((p, i) => i === 0 || ladder[i - 1] <= p), ladder);
    rec('and the ladder is the measured pars, in bands', JSON.stringify(ladder) === JSON.stringify([1, 1, 1, 1, 2, 2, 3, 3]), ladder);
    g.load('#/c/99999'); await sleep(150);
    rec('a huge index clamps to the last rung', g.state.index === 60, g.state.index);
    g.load('#/c/0'); await sleep(150);
    rec('index zero clamps up to one', g.state.index === 1, g.state.index);
    g.load('#/nonsense'); await sleep(150);
    rec('an unparseable route still deals a puzzle', g.state.mode === 'campaign' && g.state.index === 1, g.state);

    g.load('#/daily'); await sleep(150);
    const daily = g.state.id, dailyPar = g.state.par;
    g.load('#/c/1'); await sleep(110);
    g.load('#/daily'); await sleep(150);
    rec('the daily route is the same puzzle twice', g.state.mode === 'daily' && g.state.id === daily, { first: daily, again: g.state.id });
    rec('the daily label carries the date', /^每日等式 · \\d{4}-\\d{2}-\\d{2}$/.test(g.state.label), g.state.label);
    rec('and its par is a measured number, re-provable on this device', g.state.par === dailyPar && g.reprove().par === dailyPar, { par: dailyPar });

    for (const t of g.tiers()) {
      g.load('#/random/' + t.key + '/fixedseed'); await sleep(110);
      const first = { id: g.state.id, par: g.state.par, tier: g.state.tier };
      g.load('#/c/1'); await sleep(110);
      g.load('#/random/' + t.key + '/fixedseed'); await sleep(110);
      rec('#/random/' + t.key + ' stays in its band and repeats itself',
        first.tier === t.key && g.state.id === first.id && g.state.par >= t.parMin && g.state.par <= t.par,
        { want: first, got: { id: g.state.id, par: g.state.par } });
    }
    g.load('#/random/deep/another-token'); await sleep(130);
    const reroll = g.state.id;
    g.load('#/random/deep/fixedseed'); await sleep(130);
    rec('a different token is a different draw', reroll !== g.state.id, { reroll, again: g.state.id });
    g.load('#/random/zzz/t1'); await sleep(130);
    const fell = { tier: g.state.tier, id: g.state.id };
    g.load('#/random/zzz/t1'); await sleep(130);
    rec('an unknown band falls back to the first band, reproducibly', fell.tier === g.tiers()[0].key && g.state.id === fell.id,
      { fellTo: fell, again: { tier: g.state.tier, id: g.state.id } });
    location.hash = '#/random/tangle'; await sleep(320);
    rec('a bare #/random mints a token into the URL', /^#\\/random\\/[a-z]+\\/[a-z0-9]+$/.test(location.hash), location.hash);

    g.load('#/c/5'); await sleep(130);
    const sample = g.state.id;
    g.load('#/c/1'); await sleep(110);
    g.load('#/lot/' + sample); await sleep(130);
    rec('#/lot/<id> opens that puzzle', g.state.id === sample && g.state.mode === 'lot', { want: sample, got: g.state.id });
    g.load('#/lot/deep-11'); await sleep(150);
    rec('a deep-band lot opens with its measured par and route', g.state.id === 'deep-11' && g.state.par === 3 && g.path().length === 3,
      { par: g.state.par, route: g.path().length });
    rec('the share route for it is the lot id, not the campaign index', g.state.mode === 'lot' && /deep-11/.test(location.hash), location.hash);
    g.load('#/lot/not-a-real-lot'); await sleep(130);
    rec('an unknown lot id falls back instead of blanking the board', !!g.state.id && g.state.par >= 1, g.state);
    // The shelf is DOM, and load() hands over to location.hash, whose hashchange event renders
    // on a later task: reading the shelf synchronously right after a load() still sees the
    // previous page's markup, which is exactly how these two rows reported buttons: 0 on the
    // first run. Await one render tick before counting.
    g.load('#/c/1');
    g.save.reset();
    g.save.unlockTo(60);
    g.load('#/c/3');
    await sleep(260);
    const btns = Array.from(document.querySelectorAll('#shelf button[data-index]'));
    rec('the shelf renders all 60 rungs and marks the current one',
      btns.length === 60 && !!document.querySelector("#shelf button[data-index='3'].here") && btns.every((x) => !x.disabled),
      { buttons: btns.length, unlocked: g.save.unlocked() });
    const rung7 = document.querySelector("#shelf button[data-index='7']");
    rec('a shelf button routes to its own rung', (() => {
      if (!rung7) return false;
      rung7.click();
      return true;
    })(), { clicked: !!rung7 });
    await sleep(180);
    rec('and the board it routes to is the rung 7 lot', g.state.index === 7 && g.state.mode === 'campaign' && location.hash.endsWith('#/c/7'),
      { index: g.state.index, id: g.state.id, hash: location.hash });
    return { rows };
  })()`,

  save: `(async () => {
    const g = window.matchwork;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);
    const KEY = 'matchwork.save.v1';

    g.save.reset();
    g.load('#/c/1'); await sleep(150);
    rec('a wiped device prints no record', g.save.recordFor(g.state.id) === null && g.state.solvedCount === 0 && g.save.unlocked() === 1,
      { record: g.save.recordFor(g.state.id), unlocked: g.save.unlocked() });
    g.play(g.path()); await sleep(170);
    const id = g.state.id;
    const raw = JSON.parse(localStorage.getItem(KEY));
    rec('a solve reaches localStorage, not only memory', !!(raw && raw.records && raw.records[id] && raw.records[id].best.moves === g.state.par),
      { key: KEY, ids: raw && Object.keys(raw.records || {}) });
    rec('clearing the first rung unlocks the second', g.save.unlocked() === 2 && raw.unlocked === 2, { unlocked: g.save.unlocked() });
    rec('the version travels with the file', raw.version === 1, raw.version);
    const shelf2 = document.querySelector("#shelf button[data-index='2']");
    const shelf9 = document.querySelector("#shelf button[data-index='9']");
    rec('the shelf lets the unlocked rung be clicked', !!shelf2 && !shelf2.disabled, shelf2 && shelf2.outerHTML.slice(0, 70));
    rec('and keeps a far rung locked', !!shelf9 && shelf9.disabled, shelf9 && shelf9.outerHTML.slice(0, 70));
    // The panel prints the record with its unit ("1 搬"), so compare the *number* the player
    // reads against the number that is on disk — a stale or off-by-one best would still let a
    // regex like <dd>1</dd> match, which is not the promise being tested.
    const printed = (D('readout').innerHTML.match(/class="best"><dt>最佳<\\/dt><dd>([^<]*)<\\/dd>/) || [])[1] || '';
    rec('the panel prints the record it just wrote', printed.trim() === g.save.recordFor(id).best.moves + ' 搬',
      { printed, stored: g.save.recordFor(id).best.moves });
    rec('the header tally counts the solve', /已解 <b>1<\\/b>\\/60/.test(D('totals').innerHTML), D('totals').innerHTML);

    // best only ever goes down: replay the same lot sloppily and the record must survive it.
    const best = g.save.recordFor(id).best.moves;
    // Walking the winning 搬 back is legal (it is just another 搬) and it lands on the opening
    // equation, so the session is now two steps deep while the board is false again.
    const back = g.play([{ off: g.path()[0].on, on: g.path()[0].off }]);
    await sleep(140);
    rec('running the route backwards is a legal wasted 搬',
      back.applied === 1 && back.moves === 2 && back.solved === false && g.state.text === g.lot().text,
      { back, text: g.state.text, opening: g.lot().text });
    g.play(g.path()); await sleep(170);
    const afterSloppy = g.save.recordFor(id);
    // The second win is the *same* session, so the run it records cost 3 搬 (win, waste, win)
    // while the stored best stays at the clean 1 — that asymmetry is the whole point.
    rec('a sloppy replay does not take the record down', afterSloppy.best.moves === best && afterSloppy.moves === 3, afterSloppy);
    rec('the stored best is still the hintless one', afterSloppy.best.hints === 0, afterSloppy.best);

    // unlock only ever goes up.
    g.save.unlockTo(41);
    g.load('#/c/1'); await sleep(140);
    g.play(g.path()); await sleep(160);
    rec('re-solving rung one cannot lock rung 41 away', g.save.unlocked() === 41, g.save.unlocked());
    rec('and the shell keeps the higher number on disk', JSON.parse(localStorage.getItem(KEY)).unlocked === 41, JSON.parse(localStorage.getItem(KEY)).unlocked);
    rec('the perfect counter counts hintless runs at par', g.save.stats().perfect >= 1 && g.save.stats().solves >= 3, g.save.stats());

    g.load('#/daily'); await sleep(170);
    const day = g.state.label.split(' · ')[1];
    const beforeDaily = g.save.stats().solves;
    g.play(g.path()); await sleep(170);
    rec('today is logged once solved', g.save.dailyOf(day) === g.state.id, { day, mark: g.save.dailyOf(day) });
    rec('the shelf says today is done', /已通过/.test(D('shelf').textContent), D('shelf').textContent.slice(0, 90));
    rec('solving daily moved the session counters', g.save.stats().solves === beforeDaily + 1 && g.save.stats().drags >= 1, g.save.stats());
    rec('the daily mark is a dated slot, not just a record', !!JSON.parse(localStorage.getItem(KEY)).daily[day], JSON.parse(localStorage.getItem(KEY)).daily);

    // The wipe is the one destructive control, so it asks twice.
    const had = Object.keys(g.save.snapshot().records).length;
    D('wipe').click(); await sleep(130);
    rec('the first click only arms it', Object.keys(g.save.snapshot().records).length === had && !D('toast').hidden && /清空/.test(D('toast').textContent),
      { records: Object.keys(g.save.snapshot().records).length, toast: D('toast').textContent });
    D('wipe').click(); await sleep(280);
    rec('清空存档 takes two clicks and clears everything',
      Object.keys(g.save.snapshot().records).length === 0 && g.save.unlocked() === 1 && localStorage.getItem(KEY) !== null,
      { records: Object.keys(g.save.snapshot().records), unlocked: g.save.unlocked(), rewritten: localStorage.getItem(KEY) !== null });
    rec('and the shell re-renders as a clean device', /已解 <b>0<\\/b>\\/60/.test(D('totals').innerHTML), D('totals').innerHTML);
    rec('a corrupt save is refused, not trusted', (() => {
      localStorage.setItem(KEY, '{not json');
      g.save._forget();
      const fresh = g.save.snapshot();
      localStorage.removeItem(KEY); g.save._forget();
      return fresh.version === 1 && Object.keys(fresh.records).length === 0 && fresh.unlocked === 1;
    })(), 'snapshot taken after feeding the reader a truncated JSON body');
    rec('a hand-edited negative counter is not a counter', (() => {
      localStorage.setItem(KEY, JSON.stringify({ version: 1, unlocked: -3, stats: { drags: -4, solves: 2 } }));
      g.save._forget();
      const s = g.save.snapshot();
      localStorage.removeItem(KEY); g.save._forget(); g.save.reset(); g.load('#/c/1');
      return s.stats.drags === 0 && s.unlocked >= 1 && s.stats.solves === 2;
    })(), g.save.snapshot().stats);
    return { rows };
  })()`,
};

main().catch((err) => {
  console.error('playtest failed: ' + ((err && err.stack) || err));
  process.exit(1);
});
