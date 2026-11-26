// Automated playtest: drives the full route with emulated touch input on an
// emulated Android phone and checks the race completes with a recorded time.
// Usage: node tools/playtest.mjs [screenshotDir]
import { launch } from './cdp.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = process.argv[2] || null;
const b = await launch();
const shot = async (name) => { if (shotDir) await b.shot(join(shotDir, name + '.png')); };
const fail = async (msg) => { console.error('FAIL:', msg); await shot('fail'); console.log(b.logs.join('\n')); await b.close(); process.exit(1); };

await b.goto('file://' + join(root, 'index.html'));
const t0 = Date.now();
while ((await b.eval('window.__pierun?.game.state')) !== 'title') {
  if (Date.now() - t0 > 10000) await fail('never reached title');
  await b.sleep(50);
}
console.log('world built + title in', Date.now() - t0, 'ms (incl. page load)');

// Route along real streets: up the driveway, 5th Ave west to Main St, south on Main.
const route = await b.eval(`(() => {
  const W = __pierun.world, M = MAPDATA;
  const fifth = M.roads.filter(r => r.n === '5th Avenue');
  const main = M.roads.find(r => r.n === 'Main Street');
  const pts = (r) => { const o = []; for (let i = 0; i < r.p.length; i += 2) o.push([r.p[i], r.p[i + 1]]); return o; };
  const mainX = main.p[0];
  const f = fifth.flatMap(pts).filter(([x]) => x >= mainX - 1 && x <= W.start.x).sort((a, b) => b[0] - a[0]);
  const yAt = (x) => { const all = fifth.flatMap(pts).sort((a, b) => a[0] - b[0]); for (let i = 0; i + 1 < all.length; i++) if (all[i][0] <= x && x <= all[i + 1][0]) return all[i][1] + (all[i + 1][1] - all[i][1]) * (x - all[i][0]) / (all[i + 1][0] - all[i][0]); return null; };
  const street = [W.start.x, yAt(W.start.x)];
  const m = pts(main).filter(([, y]) => y >= f[f.length - 1][1] && y <= W.pieZone.y).sort((a, b) => a[1] - b[1]);
  const out = [street, ...f, ...m, [mainX - 3, W.pieZone.y]];
  const back = [...m.slice().reverse(), ...f.slice().reverse(), street, [W.homeZone.x, W.homeZone.y]];
  return { start: W.start, pie: W.pieZone, home: W.homeZone, out, back };
})()`);
console.log('route', JSON.stringify(route));

// Synthetic touch-type pointer events go through the game's real input handlers.
const ptr = (type, x, y) => b.eval(`(() => { const c = document.getElementById('game');
  c.dispatchEvent(new PointerEvent('${type}', { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: ${x}, clientY: ${y}, bubbles: true, cancelable: true })); })()`);
const CX = 206, CY = 650; // touch origin (CSS px)
await ptr('pointerdown', CX, CY); // tap to start; same finger becomes the stick
await b.sleep(150);
if ((await b.eval('__pierun.game.state')) !== 'countdown') await fail('tap did not start countdown');
await shot('1-countdown');
await b.sleep(1200);
const pos0 = await b.eval('[__pierun.bike.x, __pierun.bike.y]');
await ptr('pointermove', CX, CY - 50); // pushing during countdown must not move the bike
await b.sleep(600);
const pos1 = await b.eval('[__pierun.bike.x, __pierun.bike.y]');
if (pos0[0] !== pos1[0] || pos0[1] !== pos1[1]) await fail('bike moved during countdown');
while ((await b.eval('__pierun.game.state')) === 'countdown') await b.sleep(20);
await shot('2-go');
const tRace = Date.now();

async function driveTo(wps, label) {
  for (const [wx, wy] of wps) {
    let tStart = null;
    for (;;) {
      const s = await b.eval('({x:__pierun.bike.x,y:__pierun.bike.y,st:__pierun.game.state,ph:__pierun.game.phase,t:__pierun.game.raceTime})');
      if (s.st !== 'race') return s;
      if (tStart === null) tStart = s.t;
      const dx = wx - s.x, dy = wy - s.y, d = Math.hypot(dx, dy);
      if (d < 8) break;
      if (s.t - tStart > 15) await fail(`stuck heading to ${wx},${wy} (${label}) at ${s.x.toFixed(1)},${s.y.toFixed(1)}`);
      await ptr('pointermove', CX + (dx / d) * 50, CY + (dy / d) * 50);
      await b.sleep(25);
    }
  }
  return b.eval('({st:__pierun.game.state,ph:__pierun.game.phase})');
}

let s = await driveTo(route.out, 'to pie');
// Nudge into the pickup zone if the last waypoint did not already trigger it.
if (s.ph !== 'home') s = await driveTo([[route.pie.x, route.pie.y]], 'pie zone');
s = await b.eval('({st:__pierun.game.state,ph:__pierun.game.phase,split:__pierun.game.pieSplit})');
if (s.ph !== 'home') await fail('pie was not picked up: ' + JSON.stringify(s));
console.log('pie picked up at', s.split.toFixed(2), 's');
await shot('3-pie');
s = await driveTo(route.back, 'home');
await b.sleep(100);
await ptr('pointerup', CX, CY);
s = await b.eval('({st:__pierun.game.state,last:__pierun.game.lastTime,best:__pierun.game.best,nb:__pierun.game.newBest})');
if (s.st !== 'finish') await fail('race did not finish: ' + JSON.stringify(s));
console.log('finished: time', s.last, 'ms; wall', ((Date.now() - tRace) / 1000).toFixed(1), 's', 'ms; best', s.best, 'newBest', s.nb);
await b.sleep(1300);
await shot('4-finish');
const stored = await b.eval('localStorage.getItem("pierun.best.v1")');
if (String(s.best) !== stored) await fail('best time not saved: ' + stored);

// Race again: tap restarts the countdown; title shows best on reload.
await ptr('pointerdown', CX, CY);
await b.sleep(100);
await ptr('pointerup', CX, CY);
if ((await b.eval('__pierun.game.state')) !== 'countdown') await fail('tap on results did not restart');
await b.goto('file://' + join(root, 'index.html'));
while ((await b.eval('window.__pierun?.game.state')) !== 'title') await b.sleep(50);
if ((await b.eval('__pierun.game.best')) !== s.best) await fail('best not restored after reload');
await b.sleep(300);
await shot('5-title-with-best');

const errors = b.logs.filter((l) => /EXCEPTION|error/i.test(l));
if (errors.length) await fail('console errors:\n' + errors.join('\n'));
console.log('PASS');
await b.close();
