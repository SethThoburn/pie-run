'use strict';
// PIE RUN: ride from 704 5th Ave to The Pie Safe and back home, fast.

(function () {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });

  // ---- Tuning (world units are pixels; 1px = 0.5 m) -----------------------------------
  const MAX_SPEED = 92;      // px/s on pavement
  const ACCEL = 120;         // px/s^2
  const COAST_DECEL = 90;
  const BRAKE_DECEL = 220;
  const TURN_RATE = 4.4;     // rad/s at low speed
  const BIKE_R = 3.5;        // collision radius
  const BEST_KEY = 'pierun.best.v1';
  const SOUND_KEY = 'pierun.sound.v1';
  const NAME_KEY = 'pierun.name.v1';

  // ---- Persistent storage (may be unavailable in private/sandboxed browsers) -----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
  function loadBest() {
    const v = parseInt(store.get(BEST_KEY), 10);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  // ---- Screen ----------------------------------------------------------------------------------
  let VW = 240, VH = 400, PIX = 1, DPR = 1;
  function resize() {
    DPR = window.devicePixelRatio || 1;
    const cssW = window.innerWidth, cssH = window.innerHeight;
    const devW = Math.round(cssW * DPR), devH = Math.round(cssH * DPR);
    PIX = Math.max(1, Math.round(Math.min(devW, devH) / 230));
    VW = Math.ceil(devW / PIX);
    VH = Math.ceil(devH / PIX);
    canvas.width = VW;
    canvas.height = VH;
    canvas.style.width = (VW * PIX) / DPR + 'px';
    canvas.style.height = (VH * PIX) / DPR + 'px';
    ctx.imageSmoothingEnabled = false;
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- Audio -------------------------------------------------------------------------------------
  const audio = {
    ctx: null, engine: null, engineGain: null, filter: null,
    on: store.get(SOUND_KEY) !== 'off',
    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
        this.engine = this.ctx.createOscillator();
        this.engine.type = 'sawtooth';
        this.engine.frequency.value = 50;
        this.filter = this.ctx.createBiquadFilter();
        this.filter.type = 'lowpass';
        this.filter.frequency.value = 500;
        this.engineGain = this.ctx.createGain();
        this.engineGain.gain.value = 0;
        this.engine.connect(this.filter).connect(this.engineGain).connect(this.ctx.destination);
        this.engine.start();
      } catch (e) { this.ctx = null; }
    },
    beep(freq, dur, kind = 'square', vol = 0.12, slide = 0) {
      if (!this.on || !this.ctx) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = kind;
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.linearRampToValueAtTime(freq + slide, t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.ctx.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    },
    tune(notes, step = 0.09) {
      if (!this.on || !this.ctx) return;
      notes.forEach((f, i) => setTimeout(() => this.beep(f, step * 1.6, 'square', 0.1), i * step * 1000));
    },
    setEngine(speed, active) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const target = this.on && active ? 0.05 + 0.03 * speed : 0;
      this.engineGain.gain.setTargetAtTime(target, t, 0.08);
      this.engine.frequency.setTargetAtTime(48 + speed * 70, t, 0.06);
      this.filter.frequency.setTargetAtTime(380 + speed * 900, t, 0.06);
    },
  };

  // ---- Input ---------------------------------------------------------------------------------------
  const input = {
    pointerId: null, ox: 0, oy: 0, x: 0, y: 0, // CSS pixels
    keys: new Set(),
  };
  const JOY_DEAD = 8, JOY_FULL = 44; // CSS px

  function toNative(cx, cy) {
    const r = canvas.getBoundingClientRect();
    return [((cx - r.left) / r.width) * VW, ((cy - r.top) / r.height) * VH];
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    audio.init();
    const [nx, ny] = toNative(e.clientX, e.clientY);
    if (handleTap(nx, ny)) return;
    if (input.pointerId === null) {
      input.pointerId = e.pointerId;
      input.ox = input.x = e.clientX;
      input.oy = input.y = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== input.pointerId) return;
    e.preventDefault();
    // The stick stays anchored where the finger first touched; only lifting
    // and touching again moves it.
    input.x = e.clientX; input.y = e.clientY;
  });
  const endPointer = (e) => { if (e.pointerId === input.pointerId) input.pointerId = null; };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('lostpointercapture', endPointer);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  window.addEventListener('keydown', (e) => {
    if (Scoreboard.isOpen()) return; // typing a name
    const k = e.key;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(k)) e.preventDefault();
    audio.init();
    if (!e.repeat && (k === ' ' || k === 'Enter')) handleTap(-1, -1, true);
    input.keys.add(k.toLowerCase());
  });
  window.addEventListener('keyup', (e) => input.keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => { input.keys.clear(); input.pointerId = null; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      input.keys.clear(); input.pointerId = null;
      if (audio.ctx) audio.ctx.suspend();
    } else if (audio.ctx) audio.ctx.resume();
  });

  // Returns {mode, target, throttle, turn, brake}.
  function readControls() {
    const k = input.keys;
    const up = k.has('arrowup') || k.has('w'), down = k.has('arrowdown') || k.has('s');
    const left = k.has('arrowleft') || k.has('a'), right = k.has('arrowright') || k.has('d');
    if (up || down || left || right) {
      return { mode: 'keys', throttle: up ? 1 : 0, brake: down, turn: (right ? 1 : 0) - (left ? 1 : 0) };
    }
    if (input.pointerId !== null) {
      const dx = input.x - input.ox, dy = input.y - input.oy;
      const d = Math.hypot(dx, dy);
      if (d > JOY_DEAD) {
        return {
          mode: 'stick', target: Math.atan2(dx, -dy),
          throttle: Math.min(1, (d - JOY_DEAD) / (JOY_FULL - JOY_DEAD)),
        };
      }
    }
    return { mode: 'none', throttle: 0 };
  }

  // ---- Game state ---------------------------------------------------------------------------------------
  let world = null;
  const game = {
    state: 'loading', // loading | title | countdown | race | finish
    t: 0,             // time in current state
    raceTime: 0,
    phase: 'pie',     // pie | home
    best: loadBest(),
    lastTime: 0,
    newBest: false,
    pieSplit: 0,
    toast: '', toastT: 0,
    posted: null,     // scoreboard result for the last run, once posted
    topTen: null,     // last run would make the global top 10: true / false / null (unknown yet)
    runId: 0,
  };
  let board = null;   // scoreboard overlay: { loading, error, top, name, rank, best }
  const bike = { x: 0, y: 0, a: 0, speed: 0, bumpT: 0 };
  const cam = { x: 0, y: 0, lx: 0, ly: 0, shake: 0 };
  const particles = [];
  window.__pierun = { game, bike, get world() { return world; }, get board() { return board; }, get buttons() { return buttons; }, toCss: (x, y) => { const r = canvas.getBoundingClientRect(); return [r.left + (x / VW) * r.width, r.top + (y / VH) * r.height]; }, finishRace: () => finishRace(),
    // Advance the game by n fixed 1/60 s frames (tests can't rely on rAF in headless Chrome).
    step: (n = 1) => { for (let i = 0; i < n; i++) { if (world) update(1 / 60); render(1 / 60); } } }; // for automated testing

  function resetRace() {
    bike.x = world.start.x; bike.y = world.start.y; bike.a = world.start.a;
    bike.speed = 0; bike.bumpT = 0;
    cam.lx = cam.ly = 0; cam.shake = 0;
    cam.x = bike.x; cam.y = bike.y;
    game.raceTime = 0;
    game.phase = 'pie';
    game.newBest = false;
    game.posted = null;
    game.topTen = null;
    game.runId++;
    game.toast = ''; game.toastT = 0;
    particles.length = 0;
  }

  function setState(s) {
    game.state = s;
    game.t = 0;
  }

  function startCountdown() {
    resetRace();
    setState('countdown');
    audio.beep(440, 0.15);
  }

  function requestFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement || !el.requestFullscreen || !document.fullscreenEnabled) return;
    try { const p = el.requestFullscreen({ navigationUI: 'hide' }); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
  }

  // ---- Menus, buttons and the scoreboard ----------------------------------------------------
  // Buttons are registered while drawing each frame and hit-tested on tap.
  let buttons = [];
  function button(label, cx, y, opts, action) {
    const scale = opts.scale || 1;
    const w = opts.w || measureText(label, scale) + 12;
    const h = 7 * scale + 8;
    const x = Math.round(cx - w / 2);
    ctx.fillStyle = DARK; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = opts.color || '#4a3d5c'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(x, y, w, 1);
    drawText(ctx, label, cx, y + 4, { scale, color: WHITE, align: 'center' });
    buttons.push({ label, x: x - 2, y: y - 2, w: w + 4, h: h + 4, action });
    return h;
  }

  function openBoard(result) {
    const name = store.get(NAME_KEY);
    if (result) {
      board = { loading: false, error: null, top: result.top, name: result.name, rank: result.rank, best: result.best };
      return;
    }
    board = { loading: true, error: null, top: null, name, rank: null, best: null };
    const mine = board;
    Scoreboard.fetchTop().then((top) => {
      mine.top = top; mine.loading = false;
      const me = top.find((e) => e.name === name);
      if (me) { mine.rank = me.rank; mine.best = me.ms; }
    }).catch((e) => { mine.error = e.message; mine.loading = false; });
  }

  function postScore() {
    input.pointerId = null;
    Scoreboard.askAndPost(game.lastTime, fmtTime(game.lastTime), store.get(NAME_KEY) || '', (name) => store.set(NAME_KEY, name))
      .then((result) => {
        if (!result) return;
        game.posted = result;
        audio.tune([659, 784, 1047]);
        openBoard(result);
      });
  }

  // Taps on menus. Returns true if the tap was consumed (so it does not start steering).
  function handleTap(nx, ny, fromKey) {
    if (Scoreboard.isOpen()) return true;
    if (board) { board = null; return true; }
    const hit = buttons.find((b) => nx >= b.x && nx <= b.x + b.w && ny >= b.y && ny <= b.y + b.h);
    if (hit && (game.state === 'title' || game.state === 'finish')) { hit.action(); return true; }
    if (game.state === 'title') {
      requestFullscreen();
      startCountdown();
      return false; // let the same touch become the steering stick
    }
    if (game.state === 'finish') {
      if (fromKey && game.t > 1.0) startCountdown();
      return true;
    }
    return false;
  }

  // ---- Simulation ----------------------------------------------------------------------------------
  function angDiff(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function blocked(x, y) {
    if (world.solidAt(x, y)) return true;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (world.solidAt(x + Math.cos(a) * BIKE_R, y + Math.sin(a) * BIKE_R)) return true;
    }
    return false;
  }

  function updateBike(dt, canDrive) {
    const c = canDrive ? readControls() : { mode: 'none', throttle: 0 };
    const surf = world.speedAt(bike.x, bike.y);
    const speedFrac = Math.min(1, Math.abs(bike.speed) / MAX_SPEED);
    const turn = TURN_RATE * (1 - 0.35 * speedFrac);
    let want = 0, braking = false;

    if (c.mode === 'stick') {
      const diff = angDiff(c.target, bike.a);
      const step = turn * dt;
      bike.a += Math.max(-step, Math.min(step, diff));
      want = MAX_SPEED * c.throttle;
      if (Math.abs(diff) > 1.7) want *= 0.4; // slow down for a U-turn
    } else if (c.mode === 'keys') {
      bike.a += c.turn * turn * dt;
      want = c.throttle * MAX_SPEED;
      braking = c.brake;
      if (c.brake && bike.speed <= 1) want = -MAX_SPEED * 0.25; // gentle reverse
    }
    want *= surf;

    if (bike.speed < want) bike.speed = Math.min(want, bike.speed + ACCEL * dt);
    else if (bike.speed > want) bike.speed = Math.max(want, bike.speed - (braking ? BRAKE_DECEL : COAST_DECEL) * dt);
    bike.a = ((bike.a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

    // Move in small steps, sliding along walls.
    const vx = Math.sin(bike.a) * bike.speed, vy = -Math.cos(bike.a) * bike.speed;
    const dist = Math.hypot(vx, vy) * dt;
    const steps = Math.max(1, Math.ceil(dist / 1.5));
    let hit = false;
    for (let s = 0; s < steps; s++) {
      const nx = bike.x + (vx * dt) / steps;
      if (!blocked(nx, bike.y)) bike.x = nx; else hit = true;
      const ny = bike.y + (vy * dt) / steps;
      if (!blocked(bike.x, ny)) bike.y = ny; else hit = true;
    }
    bike.bumpT -= dt;
    if (hit) {
      if (bike.bumpT <= 0 && Math.abs(bike.speed) > 25) {
        audio.beep(90, 0.12, 'square', 0.12, -40);
        cam.shake = Math.min(3, Math.abs(bike.speed) / 30);
        bike.bumpT = 0.3;
      }
      bike.speed *= Math.pow(0.02, dt); // scrubbing speed against the wall
    }

    // Dust when riding off pavement.
    if (Math.abs(bike.speed) > 30 && surf < 0.95 && Math.random() < dt * 30) {
      const t = world.typeAt(bike.x, bike.y);
      const col = t === T.GRAVEL || t === T.SIDEWALK ? '#cfc4a8' : t === T.DIRT || t === T.RAIL ? '#b08a5c' : t === T.WATER ? '#cfe6ff' : '#9cc46e';
      particles.push({
        x: bike.x - Math.sin(bike.a) * 6 + (Math.random() - 0.5) * 3,
        y: bike.y + Math.cos(bike.a) * 6 + (Math.random() - 0.5) * 3,
        vx: (Math.random() - 0.5) * 10, vy: (Math.random() - 0.5) * 10, life: 0.45, col,
      });
    }
  }

  function inZone(z) { return Math.hypot(bike.x - z.x, bike.y - z.y) <= z.r; }

  function update(dt) {
    game.t += dt;
    if (game.toastT > 0) game.toastT -= dt;
    switch (game.state) {
      case 'countdown': {
        const before = Math.floor(game.t - dt), now = Math.floor(game.t);
        if (now !== before && now < 3) audio.beep(440, 0.15);
        if (game.t >= 3) {
          setState('race');
          audio.beep(880, 0.35);
        }
        updateBike(dt, false);
        break;
      }
      case 'race':
        game.raceTime += dt;
        updateBike(dt, true);
        if (game.phase === 'pie' && inZone(world.pieZone)) {
          game.phase = 'home';
          game.pieSplit = game.raceTime;
          game.toast = 'GOT THE PIE!'; game.toastT = 1.8;
          audio.tune([523, 659, 784]);
        } else if (game.phase === 'home' && inZone(world.homeZone)) {
          finishRace();
        }
        break;
      case 'finish':
        updateBike(dt, false);
        break;
      default:
        break;
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
    if (particles.length > 80) particles.splice(0, particles.length - 80);
    audio.setEngine(Math.abs(bike.speed) / MAX_SPEED, game.state === 'race' || game.state === 'countdown' || game.state === 'finish');
  }

  function finishRace() {
    const ms = Math.round(game.raceTime * 1000);
    game.lastTime = ms;
    game.newBest = game.best === null || ms < game.best;
    if (game.newBest) {
      game.best = ms;
      store.set(BEST_KEY, String(ms));
    }
    setState('finish');
    audio.tune(game.newBest ? [523, 659, 784, 1047, 784, 1047] : [523, 659, 784, 1047]);
    // Check whether this time would make the global top 10 (also postable if it does).
    const run = game.runId;
    Scoreboard.fetchTop().then((top) => {
      if (game.runId !== run) return; // a newer race started meanwhile
      game.topTen = top.length < 10 || ms < top[9].ms;
    }).catch(() => { if (game.runId === run) game.topTen = false; });
  }

  function fmtTime(ms) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return m + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
  }

  // ---- Rendering -------------------------------------------------------------------------------------
  const YELLOW = '#ffd640', DARK = '#1a1410', WHITE = '#ffffff';

  function updateCamera(dt) {
    const vx = Math.sin(bike.a) * bike.speed, vy = -Math.cos(bike.a) * bike.speed;
    const k = 1 - Math.exp(-dt * 2.5);
    cam.lx += (vx * 0.55 - cam.lx) * k;
    cam.ly += (vy * 0.55 - cam.ly) * k;
    cam.x = bike.x + cam.lx;
    cam.y = bike.y + cam.ly;
    cam.shake = Math.max(0, cam.shake - dt * 10);
  }

  function viewOrigin() {
    let x0 = Math.round(cam.x - VW / 2), y0 = Math.round(cam.y - VH / 2);
    x0 = Math.max(0, Math.min(world.w - VW, x0));
    y0 = Math.max(0, Math.min(world.h - VH, y0));
    if (VW > world.w) x0 = Math.round((world.w - VW) / 2);
    if (VH > world.h) y0 = Math.round((world.h - VH) / 2);
    if (cam.shake > 0) {
      x0 += Math.round((Math.random() - 0.5) * cam.shake * 2);
      y0 += Math.round((Math.random() - 0.5) * cam.shake * 2);
    }
    return [x0, y0];
  }

  function drawWorld(x0, y0) {
    ctx.fillStyle = '#28462c';
    ctx.fillRect(0, 0, VW, VH);
    const C = world.chunk;
    const cx0 = Math.max(0, Math.floor(x0 / C)), cy0 = Math.max(0, Math.floor(y0 / C));
    const cx1 = Math.min(world.cols - 1, Math.floor((x0 + VW - 1) / C));
    const cy1 = Math.min(world.rows - 1, Math.floor((y0 + VH - 1) / C));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) ctx.drawImage(world.getChunk(cx, cy), cx * C - x0, cy * C - y0);
    }
  }

  // Dotted, pulsing ring drawn pixel by pixel to stay crisp.
  function drawRing(x, y, r, color) {
    ctx.fillStyle = color;
    const n = Math.max(12, Math.round(r * 2.2));
    const spin = performance.now() / 900;
    for (let i = 0; i < n; i++) {
      if (i % 2) continue;
      const a = (i / n) * Math.PI * 2 + spin;
      ctx.fillRect(Math.round(x + Math.cos(a) * r) - 1, Math.round(y + Math.sin(a) * r) - 1, 2, 2);
    }
  }

  function currentTarget() {
    return game.phase === 'pie' ? world.pieZone : world.homeZone;
  }

  function drawTargetMarker(x0, y0) {
    if (game.state !== 'race' && game.state !== 'countdown' && game.state !== 'title') return;
    const z = currentTarget();
    const sx = z.x - x0, sy = z.y - y0;
    const icon = game.phase === 'pie' ? ART.pie : ART.house;
    const pulse = Math.sin(performance.now() / 160);
    const onScreen = sx > 12 && sx < VW - 12 && sy > 24 && sy < VH - 12;
    if (onScreen) {
      drawRing(sx, sy, z.r + pulse, YELLOW);
      const bob = Math.round(pulse * 2);
      ctx.drawImage(icon, Math.round(sx - icon.width / 2), Math.round(sy - z.r - icon.height - 6 + bob));
      return;
    }
    // Off-screen: arrow on the screen edge pointing at the target.
    const cx = VW / 2, cy = VH / 2;
    const dx = sx - cx, dy = sy - cy;
    const m = 14;
    const kx = dx !== 0 ? (VW / 2 - m) / Math.abs(dx) : Infinity;
    const ky = dy !== 0 ? (VH / 2 - m) / Math.abs(dy) : Infinity;
    const k = Math.min(kx, ky);
    const ax = cx + dx * k, ay = cy + dy * k;
    const ang = Math.atan2(dx, -dy);
    const fr = rotFrame(ART.arrow, ang);
    const push = Math.round(pulse * 1.5);
    ctx.drawImage(fr, Math.round(ax - fr.width / 2 + Math.sin(ang) * push), Math.round(ay - fr.height / 2 - Math.cos(ang) * push));
    ctx.drawImage(icon, Math.round(ax - Math.sin(ang) * 14 - icon.width / 2), Math.round(ay + Math.cos(ang) * 14 - icon.height / 2));
  }

  function drawBike(x0, y0) {
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / 0.45);
      ctx.fillStyle = p.col;
      ctx.fillRect(Math.round(p.x - x0), Math.round(p.y - y0), 1, 1);
    }
    ctx.globalAlpha = 1;
    const sh = rotFrame(ART.bikeShadow, bike.a);
    const fr = rotFrame(ART.bike, bike.a);
    const bx = Math.round(bike.x - x0 - fr.width / 2), by = Math.round(bike.y - y0 - fr.height / 2);
    ctx.drawImage(sh, bx + 2, by + 2);
    ctx.drawImage(fr, bx, by);
    if (game.phase === 'home' && game.state !== 'title') {
      // Pie strapped on the back.
      const px = bike.x - Math.sin(bike.a) * 6 - x0, py = bike.y + Math.cos(bike.a) * 6 - y0;
      ctx.drawImage(ART.pie, Math.round(px - 4), Math.round(py - 3));
    }
  }

  function drawMinimap() {
    const mm = world.mini, s = world.miniScale;
    const x = 3, y = 3;
    ctx.fillStyle = DARK;
    ctx.fillRect(x - 1, y - 1, mm.width + 2, mm.height + 2);
    ctx.globalAlpha = 0.9;
    ctx.drawImage(mm, x, y);
    ctx.globalAlpha = 1;
    const z = currentTarget();
    ctx.fillStyle = game.phase === 'pie' ? '#ff4060' : '#4080ff';
    ctx.fillRect(x + Math.round(z.x / s) - 1, y + Math.round(z.y / s) - 1, 3, 3);
    if (Math.floor(performance.now() / 250) % 2 === 0) {
      ctx.fillStyle = DARK;
      ctx.fillRect(x + Math.round(bike.x / s) - 1, y + Math.round(bike.y / s) - 1, 3, 3);
      ctx.fillStyle = WHITE;
      ctx.fillRect(x + Math.round(bike.x / s), y + Math.round(bike.y / s), 1, 1);
    }
  }

  function drawStick() {
    if (input.pointerId === null || (game.state !== 'race' && game.state !== 'countdown')) return;
    const [ox, oy] = toNative(input.ox, input.oy);
    const [px, py] = toNative(input.x, input.y);
    const r = (JOY_FULL * DPR) / PIX;
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = WHITE;
    const n = 24;
    for (let i = 0; i < n; i += 2) {
      const a = (i / n) * Math.PI * 2;
      ctx.fillRect(Math.round(ox + Math.cos(a) * r), Math.round(oy + Math.sin(a) * r), 2, 2);
    }
    // Knob follows the finger but stays on the anchored ring.
    const dx = px - ox, dy = py - oy, d = Math.hypot(dx, dy);
    const k = d > r ? r / d : 1;
    ctx.fillRect(Math.round(ox + dx * k) - 3, Math.round(oy + dy * k) - 3, 6, 6);
    ctx.globalAlpha = 1;
  }

  function drawHUD() {
    drawMinimap();
    const timeStr = fmtTime(Math.round(game.raceTime * 1000));
    drawText(ctx, timeStr, VW - 4, 4, { scale: 2, color: WHITE, outline: DARK, align: 'right' });
    const goal = game.phase === 'pie' ? 'GET PIE!' : 'GO HOME!';
    drawText(ctx, goal, VW - 4, 22, { color: game.phase === 'pie' ? YELLOW : '#9cc8ff', outline: DARK, align: 'right' });
    if (game.best !== null) drawText(ctx, 'BEST ' + fmtTime(game.best), VW - 4, 32, { color: '#d0d0d0', outline: DARK, align: 'right' });
    if (game.toastT > 0 && Math.floor(game.toastT * 8) % 2 === 0 || game.toastT > 1.2) {
      drawText(ctx, game.toast, VW / 2, VH * 0.3, { scale: 2, color: YELLOW, outline: DARK, align: 'center' });
    }
  }

  function dim(a) {
    ctx.fillStyle = `rgba(10,8,20,${a})`;
    ctx.fillRect(0, 0, VW, VH);
  }

  function drawCountdown() {
    const n = 3 - Math.floor(game.t);
    const frac = game.t % 1;
    const scale = frac < 0.12 ? 10 : 8;
    drawText(ctx, String(n), VW / 2, VH * 0.36 - (7 * scale) / 2, { scale, color: YELLOW, outline: DARK, align: 'center' });
    if (game.t < 1.6) drawText(ctx, 'DRAG TO STEER', VW / 2, VH * 0.36 + 40, { color: WHITE, outline: DARK, align: 'center' });
  }

  function drawGo() {
    if (game.state === 'race' && game.t < 0.8) {
      drawText(ctx, 'GO!', VW / 2, VH * 0.36 - 28, { scale: 8, color: '#60ff80', outline: DARK, align: 'center' });
    }
  }

  function panel(cx, cy, w, h) {
    const x = Math.round(cx - w / 2), y = Math.round(cy - h / 2);
    ctx.fillStyle = DARK; ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = '#f2e2c4'; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = '#2b2236'; ctx.fillRect(x, y, w, h);
    return [x, y];
  }

  function drawTitle() {
    dim(0.45);
    const cx = VW / 2;
    const w = Math.min(VW - 12, 220);
    const [, py] = panel(cx, VH / 2, w, 214);
    let y = py + 10;
    const tw = measureText('PIE RUN', 3);
    ctx.drawImage(ART.pie, Math.round(cx - tw / 2 - 15), y + 7);
    ctx.drawImage(ART.pie, Math.round(cx + tw / 2 + 6), y + 7);
    drawText(ctx, 'PIE RUN', cx, y, { scale: 3, color: YELLOW, outline: DARK, align: 'center' });
    y += 26;
    drawText(ctx, 'DEARY, IDAHO', cx, y, { color: '#9cc8ff', align: 'center' });
    y += 18;
    drawText(ctx, 'RIDE FROM 704 5TH AVE', cx, y, { color: WHITE, align: 'center' }); y += 10;
    drawText(ctx, 'TO THE PIE SAFE', cx, y, { color: WHITE, align: 'center' }); y += 10;
    drawText(ctx, 'AND BACK HOME. FAST!', cx, y, { color: WHITE, align: 'center' }); y += 18;
    drawText(ctx, game.best !== null ? 'BEST ' + fmtTime(game.best) : 'NO BEST TIME YET', cx, y, { scale: game.best !== null ? 2 : 1, color: YELLOW, align: 'center' });
    y += 24;
    if (Math.floor(game.t * 2.5) % 2 === 0) drawText(ctx, 'TAP TO START', cx, y, { scale: 2, color: WHITE, outline: DARK, align: 'center' });
    y += 24;
    drawText(ctx, 'DRAG ANYWHERE TO STEER', cx, y, { color: '#c8c0d8', align: 'center' });
    y += 16;
    button('SCOREBOARD', cx - 46, y, { w: 84, color: '#2f6f9e' }, () => openBoard());
    button(audio.on ? 'SOUND: ON' : 'SOUND: OFF', cx + 46, y, { w: 84 }, () => {
      audio.on = !audio.on;
      store.set(SOUND_KEY, audio.on ? 'on' : 'off');
      if (audio.on) audio.beep(660, 0.1);
    });
    drawText(ctx, 'MAP DATA (C) OPENSTREETMAP', cx, VH - 10, { color: '#e0e0e0', outline: DARK, align: 'center' });
  }

  function drawFinish() {
    const a = Math.min(1, game.t / 0.4);
    dim(0.4 * a);
    if (game.t < 0.3) return;
    const cx = VW / 2;
    const w = Math.min(VW - 12, 210);
    const [, py] = panel(cx, VH / 2, w, 208);
    let y = py + 10;
    ctx.drawImage(ART.pie, Math.round(cx - 4), y);
    y += 12;
    drawText(ctx, 'HOME WITH PIE!', cx, y, { scale: 2, color: YELLOW, outline: DARK, align: 'center' });
    y += 24;
    drawText(ctx, 'YOUR TIME', cx, y, { color: '#c8c0d8', align: 'center' });
    y += 11;
    drawText(ctx, fmtTime(game.lastTime), cx, y, { scale: 3, color: WHITE, outline: DARK, align: 'center' });
    y += 28;
    if (game.newBest) {
      if (Math.floor(game.t * 4) % 2 === 0) drawText(ctx, 'NEW BEST!', cx, y, { scale: 2, color: '#60ff80', outline: DARK, align: 'center' });
    } else {
      drawText(ctx, 'BEST ' + fmtTime(game.best), cx, y, { scale: 2, color: YELLOW, align: 'center' });
    }
    y += 22;
    drawText(ctx, 'PIE PICKUP ' + fmtTime(Math.round(game.pieSplit * 1000)), cx, y, { color: '#c8c0d8', align: 'center' });
    y += 16;
    if (game.t < 1.0) return; // brief pause so a stray tap can't hit a button
    if (game.posted) {
      drawText(ctx, 'POSTED! RANK #' + game.posted.rank, cx, y, { color: '#60ff80', align: 'center' });
      y += 12;
      y += button('SCOREBOARD', cx, y, { w: 150, color: '#2f6f9e' }, () => openBoard()) + 6;
    } else if (game.newBest || game.topTen) {
      if (!game.newBest) drawText(ctx, 'TOP 10 TIME!', cx, y, { color: '#60ff80', align: 'center' });
      y += 12;
      y += button('POST TO SCOREBOARD?', cx, y, { w: 150, color: '#2f8f4e' }, postScore) + 6;
    } else {
      y += button('SCOREBOARD', cx, y, { w: 150, color: '#2f6f9e' }, () => openBoard()) + 6;
    }
    button('RACE AGAIN', cx, y, { w: 150 }, startCountdown);
  }

  function drawBoard() {
    dim(0.5);
    const cx = VW / 2;
    const w = Math.min(VW - 8, 214);
    const h = Math.min(VH - 16, 290);
    const [px, py] = panel(cx, VH / 2, w, h);
    let y = py + 8;
    drawText(ctx, 'SCOREBOARD', cx, y, { scale: 2, color: YELLOW, outline: DARK, align: 'center' });
    y += 18;
    drawText(ctx, 'FASTEST PIE RUNS', cx, y, { color: '#9cc8ff', align: 'center' });
    y += 14;
    const bottom = py + h - 16;
    if (board.loading) {
      drawText(ctx, 'LOADING...', cx, y + 20, { color: WHITE, align: 'center' });
    } else if (board.error) {
      drawText(ctx, "COULDN'T LOAD", cx, y + 14, { color: '#ff8080', align: 'center' });
      drawText(ctx, 'THE SCOREBOARD', cx, y + 24, { color: '#ff8080', align: 'center' });
    } else if (!board.top.length) {
      drawText(ctx, 'NO TIMES YET.', cx, y + 14, { color: WHITE, align: 'center' });
      drawText(ctx, 'BE THE FIRST!', cx, y + 24, { color: YELLOW, align: 'center' });
    } else {
      const maxRows = Math.max(1, Math.floor((bottom - y) / 11));
      let rows = board.top.slice(0, maxRows);
      const meShown = rows.some((e) => e.name === board.name);
      // Always show the player's own rank, even below the visible list.
      if (!meShown && board.rank && board.best) {
        rows = rows.slice(0, maxRows - 1).concat([{ rank: board.rank, name: board.name, ms: board.best }]);
      }
      const lx = px + 8, rx = px + w - 8;
      for (const e of rows) {
        const mine = e.name === board.name;
        const col = mine ? YELLOW : e.rank <= 3 ? WHITE : '#d8d0e8';
        if (mine) { ctx.fillStyle = 'rgba(255,214,64,0.18)'; ctx.fillRect(px + 3, y - 2, w - 6, 11); }
        drawText(ctx, e.rank + '.', lx + 18, y, { color: col, align: 'right' });
        drawText(ctx, e.name, lx + 24, y, { color: col });
        drawText(ctx, fmtTime(e.ms), rx, y, { color: col, align: 'right' });
        y += 11;
      }
    }
    if (Math.floor(performance.now() / 400) % 2 === 0) drawText(ctx, 'TAP TO CLOSE', cx, py + h - 12, { color: '#c8c0d8', align: 'center' });
  }

  function render(dt) {
    if (game.state === 'loading') {
      ctx.fillStyle = '#2b2236';
      ctx.fillRect(0, 0, VW, VH);
      drawText(ctx, loadError ? 'COULD NOT LOAD MAP' : 'LOADING DEARY...', VW / 2, VH / 2 - 4, { color: loadError ? '#ff8080' : WHITE, align: 'center' });
      if (loadError) drawText(ctx, 'PLEASE RELOAD', VW / 2, VH / 2 + 8, { color: WHITE, align: 'center' });
      return;
    }
    buttons = [];
    updateCamera(dt);
    const [x0, y0] = viewOrigin();
    drawWorld(x0, y0);
    drawTargetMarker(x0, y0);
    drawBike(x0, y0);
    if (game.state === 'title') drawTitle();
    else {
      drawHUD();
      drawStick();
      if (game.state === 'countdown') drawCountdown();
      drawGo();
      if (game.state === 'finish') drawFinish();
    }
    if (board) { buttons = []; drawBoard(); }
  }

  // ---- Main loop ------------------------------------------------------------------------------
  let last = 0;
  function frame(now) {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    if (world) update(dt);
    render(dt);
    requestAnimationFrame(frame);
  }

  let loadError = null;
  function boot() {
    initArt();
    requestAnimationFrame(frame);
    loadSatGround(window.SATDATA)
      // Let the loading screen paint before the (blocking) world build.
      .then((ground) => new Promise((r) => setTimeout(() => r(ground), 30)))
      .then((ground) => {
        world = buildWorld(window.MAPDATA, window.SATDATA, ground);
        resetRace();
        setState('title');
      })
      .catch((e) => { loadError = String(e && e.message || e); console.error(e); });
  }
  boot();
})();
