// End-to-end UI test of the scoreboard flow on an emulated phone, against a local
// worker (cd worker && npx wrangler dev --port 8787).
// Usage: node tools/scoreboard-ui-test.mjs [screenshotDir]
import { launch } from './cdp.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = process.argv[2] || null;
const API = 'http://127.0.0.1:8787/api/scores';
const b = await launch();
const shot = async (n) => { if (shotDir) await b.shot(join(shotDir, n + '.png')); };
let failed = 0;
const check = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) { failed++; console.log(b.logs.filter(l => !/willRead/.test(l)).join('\n')); } };
const tapButton = async (label) => {
  const pos = await b.eval(`(() => { const bt = __pierun.buttons.find(x => x.label === ${JSON.stringify(label)}); return bt ? __pierun.toCss(bt.x + bt.w / 2, bt.y + bt.h / 2) : null; })()`);
  if (!pos) return false;
  await b.eval(`document.getElementById('game').dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: ${pos[0]}, clientY: ${pos[1]}, bubbles: true, cancelable: true }))`);
  await b.eval(`document.getElementById('game').dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: ${pos[0]}, clientY: ${pos[1]}, bubbles: true }))`);
  return true;
};
// Headless Chrome stops delivering animation frames after a few seconds, so the test
// advances the game loop itself (__pierun.step) while waiting.
const waitFor = async (expr, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await b.eval(expr)) return true; await b.eval('__pierun.step(6)'); await b.sleep(20); }
  return false;
};
const stepFor = (seconds) => b.eval(`__pierun.step(${Math.round(seconds * 60)})`);

await b.goto('file://' + join(root, 'index.html') + '?api=' + encodeURIComponent(API));
check(await waitFor("window.__pierun?.game.state === 'title'", 10000), 'title screen');
await b.eval("localStorage.removeItem('pierun.name.v1'); localStorage.removeItem('pierun.best.v1')");

// Title -> scoreboard
check(await tapButton('SCOREBOARD'), 'title has SCOREBOARD button');
check(await waitFor('__pierun.board && !__pierun.board.loading'), 'scoreboard loads from API');
check(!(await b.eval('__pierun.board.error')), 'no load error: ' + (await b.eval('__pierun.board.error')));
await shot('sb1-title-board');
await tapButton('nothing'); // tap anywhere closes
await b.eval(`document.getElementById('game').dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 100, clientY: 100, bubbles: true }))`);
check(await waitFor('__pierun.board === null'), 'tap closes scoreboard');
check((await b.eval("__pierun.game.state")) === 'title', 'closing board does not start a race');

// Finish a run (simulated) with a new personal best.
await b.eval(`document.getElementById('game').dispatchEvent(new PointerEvent('pointerdown', { pointerId: 4, pointerType: 'touch', clientX: 200, clientY: 700, bubbles: true }))`);
await b.eval(`document.getElementById('game').dispatchEvent(new PointerEvent('pointerup', { pointerId: 4, pointerType: 'touch', clientX: 200, clientY: 700, bubbles: true }))`);
check(await waitFor("__pierun.game.state === 'race'", 30000), 'race started');
await b.eval('__pierun.game.raceTime = 38.47; __pierun.game.phase = "home"; __pierun.finishRace()');
check(await b.eval('__pierun.game.newBest'), 'finish is a new best');
check(!(await tapButton('POST TO SCOREBOARD?')), 'post button hidden for the first second');
await stepFor(1.2);
await shot('sb2-finish');
check(await tapButton('POST TO SCOREBOARD?'), 'POST TO SCOREBOARD? button shown after new best');
check(await waitFor("!!document.querySelector('.sb-modal input')"), 'name dialog opens');
await shot('sb3-dialog');

// Invalid then valid name.
await b.eval("document.querySelector('.sb-post').click()");
check((await b.eval("document.querySelector('.sb-err').textContent")).length > 0, 'empty name shows an error');
await b.eval("document.querySelector('.sb-input').focus()");
await b.send('Input.insertText', { text: 'pie<>kid' });
check((await b.eval("document.querySelector('.sb-input').value")) === 'PIEKID', 'input uppercased and filtered (PIEKID)');
await b.eval("document.querySelector('.sb-post').click()");
check(await waitFor("!document.querySelector('.sb-modal')", 8000), 'dialog closes after posting');
check((await b.eval("localStorage.getItem('pierun.name.v1')")) === 'PIEKID', 'name saved to localStorage');
const posted = await b.eval('__pierun.game.posted');
check(posted && posted.name === 'PIEKID' && posted.best <= 38470 && posted.rank >= 1, 'post result: rank ' + (posted && posted.rank));
check(await b.eval("__pierun.board && __pierun.board.name === 'PIEKID' && __pierun.board.top.some(e => e.name === 'PIEKID')"), 'scoreboard opens with my entry');
await stepFor(0.2);
await shot('sb4-board-after-post');
await b.eval(`document.getElementById('game').dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 100, clientY: 100, bubbles: true }))`);
await stepFor(0.1);
check(!(await tapButton('POST TO SCOREBOARD?')), 'no second post button after posting');
await shot('sb5-finish-posted');

// Next run: dialog pre-fills the saved name; cancel works.
check(await tapButton('RACE AGAIN'), 'RACE AGAIN button');
check(await waitFor("__pierun.game.state === 'race'", 30000), 'second race started');
await b.eval('__pierun.game.raceTime = 36.0; __pierun.game.phase = "home"; __pierun.finishRace()');
await stepFor(1.2);
await tapButton('POST TO SCOREBOARD?');
check(await waitFor("!!document.querySelector('.sb-modal input')"), 'dialog opens again');
check((await b.eval("document.querySelector('.sb-input').value")) === 'PIEKID', 'saved name pre-filled');
await b.eval("document.querySelector('.sb-cancel').click()");
check(await waitFor("!document.querySelector('.sb-modal')"), 'cancel closes dialog');
check(!(await b.eval('__pierun.game.posted')), 'cancel does not post');

// A slower run is not a new best -> no post button.
await tapButton('RACE AGAIN');
await waitFor("__pierun.game.state === 'race'", 30000);
await b.eval('__pierun.game.raceTime = 50.0; __pierun.game.phase = "home"; __pierun.finishRace()');
await stepFor(1.2);
check(!(await tapButton('POST TO SCOREBOARD?')), 'no post button when not a new best');

const errs = b.logs.filter((l) => /EXCEPTION|error/i.test(l) && !/favicon/.test(l));
check(errs.length === 0, 'no console errors' + (errs.length ? ':\n' + errs.join('\n') : ''));
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
await b.close();
process.exit(failed ? 1 : 0);
