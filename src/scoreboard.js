'use strict';
// Public scoreboard client: API calls plus the "post your time" name dialog.
// Backend: worker/ (Cloudflare Worker + D1) at /api/scores on the game's domain.
// Override the endpoint for local testing with ?api=http://127.0.0.1:8787/api/scores

const Scoreboard = (() => {
  const API = new URLSearchParams(location.search).get('api') || 'https://pierun.seththoburn.com/api/scores';
  const NAME_RE = /^[A-Z0-9 .!?'&-]{1,12}$/;

  // Uppercase and drop characters the pixel font (and the server) don't allow.
  function cleanInput(s) {
    return s.toUpperCase().replace(/[^A-Z0-9 .!?'&-]/g, '').replace(/\s+/g, ' ').slice(0, 12);
  }

  async function request(method, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetch(API, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      let data = null;
      try { data = await r.json(); } catch (e) { /* non-JSON error */ }
      if (!r.ok) throw new Error((data && data.error) || 'Scoreboard error (' + r.status + ')');
      return data;
    } catch (e) {
      if (e.name === 'AbortError' || e instanceof TypeError) throw new Error("Couldn't reach the scoreboard. Check your connection.");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  const fetchTop = () => request('GET').then((d) => d.top);
  const post = (name, ms) => request('POST', { name, ms });

  // Shows the name dialog and posts. Resolves with the server result, or null if cancelled.
  // `onName` is called with the cleaned name as soon as it is submitted (to remember it).
  function askAndPost(ms, timeText, defaultName, onName) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'sb-modal';
      wrap.innerHTML = `
        <form class="sb-box" novalidate>
          <div class="sb-title">POST TO SCOREBOARD</div>
          <div class="sb-time"></div>
          <label class="sb-label" for="sb-name">YOUR NAME</label>
          <input id="sb-name" class="sb-input" maxlength="12" autocomplete="nickname"
                 autocapitalize="characters" spellcheck="false" enterkeyhint="send">
          <div class="sb-err" role="alert"></div>
          <div class="sb-row">
            <button type="button" class="sb-btn sb-cancel">CANCEL</button>
            <button type="submit" class="sb-btn sb-post">POST</button>
          </div>
        </form>`;
      const form = wrap.querySelector('form');
      const inputEl = wrap.querySelector('input');
      const err = wrap.querySelector('.sb-err');
      const postBtn = wrap.querySelector('.sb-post');
      const cancelBtn = wrap.querySelector('.sb-cancel');
      wrap.querySelector('.sb-time').textContent = timeText;
      inputEl.value = cleanInput(defaultName || '');
      inputEl.addEventListener('input', () => {
        const v = cleanInput(inputEl.value);
        if (v !== inputEl.value) inputEl.value = v;
        err.textContent = '';
      });
      const close = (result) => { wrap.remove(); resolve(result); };
      cancelBtn.addEventListener('click', () => close(null));
      wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(null); });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = inputEl.value.trim();
        if (!NAME_RE.test(name)) { err.textContent = 'Enter a name (letters and numbers, up to 12).'; inputEl.focus(); return; }
        onName(name);
        postBtn.disabled = cancelBtn.disabled = inputEl.disabled = true;
        postBtn.textContent = 'POSTING...';
        try {
          close(await post(name, ms));
        } catch (ex) {
          err.textContent = ex.message;
          postBtn.disabled = cancelBtn.disabled = inputEl.disabled = false;
          postBtn.textContent = 'POST';
        }
      });
      document.body.appendChild(wrap);
      setTimeout(() => { inputEl.focus(); if (inputEl.value) inputEl.select(); }, 50);
    });
  }

  const isOpen = () => !!document.querySelector('.sb-modal');

  return { fetchTop, askAndPost, isOpen, API };
})();
