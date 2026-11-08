/* Turntable — a record player visualizer for Spotify.
 * Plain JS, no build step. Talks to the Spotify Web API from the browser using PKCE login.
 */
(() => {
  'use strict';

  // ================================================================ config
  const SCOPES = [
    'user-read-currently-playing', 'user-read-playback-state', 'user-modify-playback-state',
    'user-library-read', 'playlist-read-private', 'playlist-read-collaborative',
  ].join(' ');
  const REDIRECT_URI = location.origin + location.pathname;
  const POLL_MS = 3000;
  let rpmDeg = 200;                     // 33⅓ rpm = 200°/s; singles spin at 45 rpm = 270°/s
  const ARM_REST = -12;                 // tonearm angle on its rest
  const R_OUT = 95, R_IN = 38;          // playable groove band, % of record radius
  const REC_R = 41.71;                  // record radius in tonearm-SVG units (platter 86% of 100, record inset 1.5%)
  const TILT = 48 * Math.PI / 180;      // must match .turntable rotateX() in styles.css
  const LIFT = .13;                     // must match .turntable translateY(-13cqw)
  const PERSP_K = 2.6;                  // must match perspective(260cqw) in styles.css
  const ARM_VEC_DEG = Math.atan2(58, 2) * 180 / Math.PI; // direction of the arm (pivot → needle) at 0°
  const LS = {
    client: 'tt.clientId', tokens: 'tt.tokens', verifier: 'tt.verifier', mode: 'tt.mode',
    finish: 'tt.finish', crackle: 'tt.crackle', vol: 'tt.crackleVol',
  };
  const FINISHES = [
    ['walnut', 'Walnut'], ['oat', 'Oat'], ['clay', 'Clay'], ['charcoal', 'Charcoal'], ['oxblood', 'Oxblood'],
    ['rose', 'Rose quartz'], ['lilac', 'Lilac'], ['sage', 'Sage'], ['terracotta', 'Terracotta'], ['moss', 'Moss'],
  ];

  // ================================================================ tiny helpers
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  // Spotify lists images widest first; pick the smallest one that is still sharp enough
  function pickImage(images, want = 640) {
    if (!Array.isArray(images) || !images.length) return null;
    const sized = images.filter((im) => im && im.url && im.width);
    if (!sized.length) return (images.find((im) => im && im.url) || {}).url || null;
    const big = sized.filter((im) => im.width >= want).sort((a, b) => a.width - b.width);
    return (big[0] || sized.sort((a, b) => b.width - a.width)[0]).url;
  }
  function placeholderCover(seed) {
    let h = 0; for (const ch of String(seed || '?')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const a = h % 360, b = (a + 35) % 360;
    return {
      gradient: `radial-gradient(circle at 32% 30%, hsl(${a} 55% 68%), hsl(${a} 45% 46%) 50%, hsl(${b} 40% 24%))`,
      colors: [`hsl(${a} 50% 52%)`, `hsl(${a} 35% 12%)`],
    };
  }
  const coverCss = (c) => (!c ? '' : c.url ? `url("${c.url}")` : c.gradient || '');
  let toastTimer;
  function toast(msg, ms = 3400) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
  // deterministic random so the room looks the same every visit
  function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // ================================================================ state
  const state = {
    mode: 'idle',          // 'idle' | 'spotify' | 'demo'
    track: null,           // { id, uri, name, artist, albumName, albumId, cover, durationMs, number, disc }
    isPlaying: false,
    progressMs: 0,
    syncedAt: performance.now(),
    context: null,         // { type: 'album' | 'playlist' | ..., uri }
    album: null,           // { id, uri, name, artist, cover, tracks: [{ id, uri, name, durationMs, number, disc }] }
    cum: [], albumTotal: 0,
    trackIndex: -1,
    albumMode: false,      // playing an album start-to-finish: record + tonearm map the whole album
    armParked: false,      // needle lifted back onto its rest by the user
  };

  function currentProgress() {
    if (!state.track) return 0;
    const p = state.isPlaying ? state.progressMs + (performance.now() - state.syncedAt) : state.progressMs;
    return clamp(p, 0, state.track.durationMs);
  }

  // single entry point for "what is playing now" (used by both Spotify and the demo)
  function setPlayback({ track, isPlaying, progressMs, context }) {
    const prevId = state.track && state.track.id;
    state.track = track || null;
    state.isPlaying = !!(track && isPlaying);
    state.progressMs = progressMs || 0;
    state.syncedAt = performance.now();
    state.context = context || null;
    if ((track && track.id) !== prevId) onTrackChange();
    else refreshAlbumMatch();
    setPlayIcon();
    renderContext();
    if (tl.mode === 'queue') highlightQueue();
  }

  const tl = { mode: 'album', uri: null, data: null, req: 0 };   // tracklist panel: album list or playlist queue

  // "Playing from playlist · Name" above the title
  const ctxNames = new Map();
  let ctxKey = null;
  function renderContext() {
    const c = state.track ? state.context : null, el = $('ctxLine');
    markCurrentOnWall();
    const key = c ? c.uri : '';
    if (key === ctxKey) return;
    ctxKey = key;
    const isPl = !!c && c.type === 'playlist';
    el.classList.toggle('link', isPl);
    if (isPl) { el.setAttribute('role', 'button'); el.tabIndex = 0; el.title = 'Show this playlist'; }
    else { el.removeAttribute('role'); el.removeAttribute('tabindex'); el.removeAttribute('title'); }
    if (tl.mode === 'queue' && (!c || c.uri !== tl.uri)) closeQueue();
    const set = (txt) => { if (ctxKey !== key) return; el.textContent = txt; el.classList.toggle('hidden', !txt); };
    if (!c) { set(''); return; }
    if (c.type === 'playlist') {
      const known = ctxNames.get(c.uri) || ((lib.items.playlists || []).find((p) => p.uri === c.uri) || {}).name;
      set(known ? `Playing from playlist · ${known}` : 'Playing from a playlist');
      if (!known) source().contextName(c.uri).then((n) => { if (n) { ctxNames.set(c.uri, n); set(`Playing from playlist · ${n}`); } }).catch(() => {});
    } else if (c.type === 'album') set('Playing the full album');
    else if (c.type === 'collection') set('Playing from Liked Songs');
    else if (c.type === 'artist') set('Playing from an artist');
    else if (c.type === 'show') set('Playing a podcast');
    else set('');
  }

  // ================================================================ rendering: track + visuals
  function setPlayIcon() {
    const p = state.isPlaying;
    $('playIcon').innerHTML = p ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
    $('playBtn').setAttribute('aria-label', p ? 'Pause' : 'Play');
    $('led').classList.toggle('on', p);
    document.body.classList.toggle('playing', p);
    if (p) state.armParked = false;
    setArmFilter();
  }
  function setArmFilter() { /* lift is animated in frame() */ }

  function onTrackChange() {
    const t = state.track;
    armHold.until = 0;
    $('title').textContent = t ? t.name : 'Nothing playing';
    $('artist').textContent = t ? t.artist : state.mode === 'spotify' ? 'Play something on Spotify, or pick a record from your Library' : 'Connect Spotify, or try the demo';
    $('album').textContent = t && t.albumName ? t.albumName : ' ';
    $('tDur').textContent = fmt(t ? t.durationMs : 0);
    $('seek').setAttribute('aria-valuemax', String(Math.round((t ? t.durationMs : 0) / 1000)));
    document.title = t ? `${t.name} · ${t.artist}` : 'Turntable';
    setVisuals(t ? (t.cover || placeholderCover(t.albumName || t.name)) : null, t ? (t.albumName || t.name) : '');
    ensureAlbum();
  }

  let lastCoverKey = null;
  function setVisuals(cover, name) {
    const key = cover ? coverCss(cover) : '';
    if (key === lastCoverKey) return;
    lastCoverKey = key;
    const label = $('label'), sleeve = $('sleeveArt');
    $('labelText').textContent = cover ? (cover.url ? '' : name) : 'Turntable';
    // record slides back into the sleeve and out again
    const peek = $('peek'); peek.classList.add('swap'); setTimeout(() => peek.classList.remove('swap'), 650);

    if (!cover) {
      label.style.backgroundImage = sleeve.style.backgroundImage = '';
      setRoomCover(null); setColors('#7a5238', '#1d140f');
      return;
    }
    if (!cover.url) {
      label.style.backgroundImage = sleeve.style.backgroundImage = cover.gradient;
      setRoomCover(null);
      if (cover.colors) setColors(cover.colors[0], cover.colors[1]);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (lastCoverKey !== key) return;
      crossfade(label, $('labelNext'), key);
      crossfade(sleeve, $('sleeveNext'), key);
      setRoomCover(cover.url);
      extractColors(img);
    };
    img.src = cover.url;
  }
  function crossfade(base, next, css) {
    next.style.backgroundImage = css; next.classList.add('show');
    setTimeout(() => { base.style.backgroundImage = css; next.classList.remove('show'); }, 850);
  }
  function setRoomCover(url) {
    const img = $('roomCover');
    if (url) img.setAttribute('href', url); else img.removeAttribute('href');
  }
  function setColors(c1, c2) {
    const s = document.documentElement.style;
    s.setProperty('--c1', c1); s.setProperty('--c2', c2);
    document.querySelector('meta[name=theme-color]').content = c2;
  }
  function extractColors(img) {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 24;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 24, 24);
      const d = ctx.getImageData(0, 0, 24, 24).data;
      let best = null, bestScore = -1, r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const R = d[i], G = d[i + 1], B = d[i + 2];
        r += R; g += G; b += B; n++;
        const max = Math.max(R, G, B), min = Math.min(R, G, B);
        const sat = max ? (max - min) / max : 0, lum = max / 255;
        const score = sat * (1 - Math.abs(lum - .6));
        if (score > bestScore) { bestScore = score; best = [R, G, B]; }
      }
      const avg = [r / n, g / n, b / n].map(Math.round);
      const vivid = bestScore > .15 ? best : avg;
      setColors(`rgb(${vivid.join(',')})`, `rgb(${avg.map((v) => Math.round(v * .3)).join(',')})`);
    } catch { /* artwork not readable (CORS): keep current colours */ }
  }

  // ================================================================ album recognition
  const albumCache = new Map();
  let albumReq = 0;
  async function ensureAlbum() {
    const t = state.track;
    if (!t || !t.albumId) { setAlbum(null); return; }
    if (state.album && state.album.id === t.albumId) { refreshAlbumMatch(true); return; }
    const req = ++albumReq;
    try {
      let a = albumCache.get(t.albumId);
      if (!a) { a = await source().album(t.albumId); albumCache.set(t.albumId, a); }
      if (req === albumReq) setAlbum(a);
    } catch { if (req === albumReq) setAlbum(null); }
  }

  function setAlbum(a) {
    state.album = a && a.tracks && a.tracks.length ? a : null;
    // 7-inch style: short singles spin at 45
    const is45 = !!(state.album && state.album.tracks.length <= 2 && (state.album.type === 'single' || state.album.tracks.length === 1));
    rpmDeg = is45 ? 270 : 200;
    document.querySelectorAll('#speedSw i').forEach((i) => i.classList.toggle('on', i.dataset.rpm === (is45 ? '45' : '33')));
    state.cum = []; state.albumTotal = 0;
    if (state.album) for (const tr of state.album.tracks) { state.cum.push(state.albumTotal); state.albumTotal += tr.durationMs; }
    document.body.classList.toggle('has-album', !!state.album);
    if (!state.album) closePanel($('tracklist'));
    renderTracklist();
    refreshAlbumMatch(true);
    onAlbumForVinyl(state.album);
  }

  function refreshAlbumMatch(force) {
    const a = state.album, t = state.track;
    let idx = -1;
    if (a && t) {
      idx = a.tracks.findIndex((x) => x.id === t.id);
      if (idx < 0 && t.number) idx = a.tracks.findIndex((x) => x.number === t.number && x.disc === t.disc);
      if (idx < 0) idx = a.tracks.findIndex((x) => x.name === t.name);
    }
    const albumMode = !!(a && idx >= 0 && state.context && state.context.type === 'album');
    if (!force && idx === state.trackIndex && albumMode === state.albumMode) return;
    state.trackIndex = idx; state.albumMode = albumMode;
    renderGrooves(); renderAlbumBar(); highlightTracklist();
  }

  // groove gaps on the record line up with the real track breaks when an album is playing
  function renderGrooves() {
    const fracs = state.albumMode ? state.cum.slice(1).map((c) => c / state.albumTotal) : [.21, .43, .63, .82];
    const radii = fracs.map((f) => R_OUT - f * (R_OUT - R_IN)).sort((a, b) => a - b);
    const stops = ['transparent 0%'];
    for (const r of radii) {
      stops.push(`transparent ${(r - .75).toFixed(2)}%`, `rgba(255,255,255,.075) ${(r - .45).toFixed(2)}%`,
                 `rgba(255,255,255,.075) ${(r + .45).toFixed(2)}%`, `transparent ${(r + .75).toFixed(2)}%`);
    }
    $('record').style.setProperty('--gaps', `radial-gradient(circle closest-side, ${stops.join(', ')}, transparent 100%)`);
  }

  // tonearm angle that puts the needle at a given fraction of the groove band
  function armAngleFor(frac) {
    const d = (R_OUT - clamp(frac, 0, 1) * (R_OUT - R_IN)) / 100 * REC_R;
    // pivot (86,14), record centre (50,50), arm vector (2,58): solve |P + R(θ)v - C| = d
    const k = (5956 - d * d) / 72 / 82.073;
    return (Math.atan2(60, 56) - Math.acos(clamp(k, -1, 1))) * 180 / Math.PI;
  }

  // ================================================================ album bar + tracklist
  let curSegFill = null;
  function renderAlbumBar() {
    const bar = $('albumBar'), label = $('albumLabel');
    bar.textContent = ''; curSegFill = null;
    const on = state.albumMode && state.album.tracks.length > 1;
    bar.classList.toggle('hidden', !on); label.classList.toggle('hidden', !on);
    if (!on) return;
    state.album.tracks.forEach((t, i) => {
      const seg = document.createElement('button');
      seg.className = 'seg' + (i < state.trackIndex ? ' done' : '') + (i === state.trackIndex ? ' current' : '');
      seg.style.flexGrow = String(Math.max(1, t.durationMs));
      seg.title = `${i + 1}. ${t.name}  (${fmt(t.durationMs)})`;
      seg.setAttribute('aria-label', `Play track ${i + 1}: ${t.name}`);
      seg.innerHTML = '<i></i>';
      seg.onclick = () => playAlbumTrack(i);
      bar.append(seg);
      if (i === state.trackIndex) curSegFill = seg.firstChild;
    });
  }

  function renderTracklist() {
    if (tl.mode === 'queue') return;
    const a = state.album, list = $('tlList');
    if (!a) { list.textContent = ''; return; }
    $('tlCover').style.backgroundImage = coverCss(a.cover);
    $('tlTitle').textContent = a.name;
    const total = a.tracks.reduce((s, t) => s + t.durationMs, 0);
    $('tlSub').textContent = `${a.artist} · ${a.tracks.length} ${a.tracks.length === 1 ? 'song' : 'songs'} · ${fmt(total)}`;
    list.innerHTML = a.tracks.map((t, i) =>
      `<li><button data-i="${i}"><span class="n">${i + 1}</span><span class="nm">${esc(t.name)}</span><span class="d">${fmt(t.durationMs)}</span></button></li>`).join('');
  }
  function highlightTracklist() {
    if (tl.mode === 'queue') { highlightQueue(); return; }
    const a = state.album;
    const kind = !a ? 'album' : a.type === 'single' ? (a.tracks.length <= 3 ? 'single' : 'EP') : a.type === 'compilation' ? 'compilation' : 'album';
    $('tlKicker').textContent = state.albumMode ? `Now spinning · ${kind}` : `From the ${kind}`;
    const items = $('tlList').children;
    for (let i = 0; i < items.length; i++) items[i].classList.toggle('current', i === state.trackIndex);
    const cur = items[state.trackIndex];
    if (cur && isTracklistVisible()) cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  $('tlList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b || b.disabled) return;
    if (tl.mode === 'queue') source().play({ contextUri: tl.uri, offsetIndex: Number(b.dataset.i) });
    else playAlbumTrack(Number(b.dataset.i));
  });
  function playAlbumTrack(i) {
    const a = state.album; if (!a) return;
    source().play({ contextUri: a.uri, offsetIndex: i });
  }

  // ================================================================ animation loop
  // The tonearm slopes like a real one: the pivot sits up on its post and the arm angles down
  // until the stylus touches the record. Lifting raises the stylus end. Heights are in cqw.
  const armLayer = $('armLayer'), armShadow = $('armShadow');
  const shCw = $('shCw'), shPivot = $('shPivot'), shTube = $('shTube'), shHead = $('shHead');
  const ARM_PIVOT_H = 4.2, TIP_DOWN = .3, TIP_UP = 2.8, ARM_LEN = 59;
  const SHADOW_K = [.5, .75];   // how far the shadow drifts per unit of height (light from the upper left)
  let armLift = 1;
  const tipHeight = () => TIP_DOWN + (TIP_UP - TIP_DOWN) * armLift;
  function armPoint(x, y, theta, tip) {          // arm-local point → where its shadow lands on the deck
    const r = theta * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), dx = x - 86, dy = y - 14;
    const z = ARM_PIVOT_H - (ARM_PIVOT_H - tip) * (dy / ARM_LEN);
    return `${(86 + dx * c - dy * s + SHADOW_K[0] * z).toFixed(2)} ${(14 + dx * s + dy * c + SHADOW_K[1] * z).toFixed(2)}`;
  }
  const poly = (pts, th, tip) => 'M' + pts.map(([x, y]) => armPoint(x, y, th, tip)).join(' L') + ' Z';
  const record = $('record'), arm = $('arm'), seekFill = $('seekFill'), seekKnob = $('seekKnob'), tNow = $('tNow');
  let angle = 0, speed = 0, armAngle = ARM_REST, last = performance.now(), lastSecond = -1;
  const seekDrag = { active: false, ms: 0 };

  function frame(now) {
    const dt = Math.min(.1, (now - last) / 1000); last = now;
    // platter spins up quicker than it coasts down, like a real one
    speed += ((state.isPlaying ? rpmDeg : 0) - speed) * Math.min(1, dt * (state.isPlaying ? 1.6 : .9));
    if (speed < .05) speed = 0;
    angle = (angle + speed * dt) % 360;
    record.style.transform = `rotate(${angle.toFixed(2)}deg)`;

    const t = state.track;
    const prog = seekDrag.active ? seekDrag.ms : currentProgress();
    const dur = t ? t.durationMs : 0;
    let armTarget = ARM_REST;
    if (armDrag.active) armTarget = armDrag.angle;
    else if (now < armHold.until) armTarget = armHold.angle;
    else if (t && !(state.armParked && !state.isPlaying)) {
      const f = state.albumMode ? (state.cum[state.trackIndex] + prog) / state.albumTotal : (dur ? prog / dur : 0);
      armTarget = armAngleFor(f);
    }
    armAngle = armDrag.active ? armTarget : armAngle + (armTarget - armAngle) * Math.min(1, dt * (seekDrag.active ? 8 : 2.4));
    // lift the stylus off the record when paused / dragging / parked
    const liftTarget = !t || !state.isPlaying || armDrag.active || (state.armParked && !state.isPlaying) ? 1 : 0;
    armLift += (liftTarget - armLift) * Math.min(1, dt * 5);
    const tip = tipHeight();
    const slope = Math.atan((ARM_PIVOT_H - tip) / ARM_LEN) * 180 / Math.PI;
    armLayer.style.transform = `var(--proj) translate(36cqw, -36cqw) translateZ(${ARM_PIVOT_H}cqw) rotateZ(${armAngle.toFixed(3)}deg) rotateX(${(-slope).toFixed(3)}deg) translate(-36cqw, 36cqw)`;
    // shadow: wide under the raised pivot, closing to a contact point under the stylus
    const th = armAngle;
    shCw.setAttribute('d', poly([[82.6, 1.2], [89.4, 1.2], [89.4, 8.2], [82.6, 8.2]], th, tip));
    const pv = armPoint(86, 14, th, tip).split(' ');
    shPivot.setAttribute('cx', pv[0]); shPivot.setAttribute('cy', pv[1]);
    shTube.setAttribute('d', `M${armPoint(86.4, 8, th, tip)} L${armPoint(88.2, 61.5, th, tip)}`);
    shHead.setAttribute('d', poly([[86.2, 60.6], [91, 60.8], [90.6, 73], [86.4, 72.8]], th, tip));
    const sf = armLift > .5 ? 'url(#softShadowUp)' : 'url(#softShadow)';
    if (armShadow.getAttribute('filter') !== sf) armShadow.setAttribute('filter', sf);

    const frac = dur ? prog / dur : 0;
    seekFill.style.width = `${(frac * 100).toFixed(3)}%`;
    seekKnob.style.left = `${(frac * 100).toFixed(3)}%`;
    if (curSegFill) curSegFill.style.width = `${(frac * 100).toFixed(2)}%`;

    const sec = Math.floor(prog / 1000);
    if (sec !== lastSecond) {
      lastSecond = sec;
      tNow.textContent = fmt(prog);
      $('seek').setAttribute('aria-valuenow', String(sec));
      $('seek').setAttribute('aria-valuetext', `${fmt(prog)} of ${fmt(dur)}`);
      if (state.albumMode) {
        const el = state.cum[state.trackIndex] + prog;
        $('albumLabel').innerHTML = `<span>Track <b>${state.trackIndex + 1}</b> of ${state.album.tracks.length}</span><span>${fmt(el)} / ${fmt(state.albumTotal)}</span>`;
      }
    }

    crackle.update(Math.min(1, speed / 200));
    if (state.mode === 'demo') Demo.tick();
    requestAnimationFrame(frame);
  }

  // ================================================================ seek bar (drag or click to scrub)
  (() => {
    const seek = $('seek');
    const msAt = (e) => {
      const r = seek.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1) * (state.track ? state.track.durationMs : 0);
    };
    seek.addEventListener('pointerdown', (e) => {
      if (!state.track) return;
      seekDrag.active = true; seekDrag.ms = msAt(e);
      seek.classList.add('dragging');
      try { seek.setPointerCapture(e.pointerId); } catch {}
    });
    seek.addEventListener('pointermove', (e) => { if (seekDrag.active) seekDrag.ms = msAt(e); });
    const end = (commit) => {
      if (!seekDrag.active) return;
      seekDrag.active = false; seek.classList.remove('dragging');
      if (commit) seekTo(seekDrag.ms);
    };
    seek.addEventListener('pointerup', () => end(true));
    seek.addEventListener('pointercancel', () => end(false));
    seek.addEventListener('keydown', (e) => {
      if (!state.track) return;
      const step = e.shiftKey ? 30000 : 5000;
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); seekTo(currentProgress() + step); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); seekTo(currentProgress() - step); }
    });
  })();

  function seekTo(ms) {
    if (!state.track) return;
    if (!state.track.durationMs) return Promise.resolve(false);
    ms = clamp(ms, 0, state.track.durationMs - 500);
    state.progressMs = ms; state.syncedAt = performance.now();
    if (state.mode === 'spotify') return playerCall('PUT', `/me/player/seek?position_ms=${Math.round(ms)}`);
    return Promise.resolve(true);
  }

  // ================================================================ transport controls
  function togglePlay() {
    if (state.mode === 'idle') { openSetup(); return; }
    const wasPlaying = state.isPlaying;
    if (!state.track && state.mode === 'demo') { Demo.play({ contextUri: Demo.albums[0].uri }); return; }
    state.progressMs = currentProgress(); state.syncedAt = performance.now();
    state.isPlaying = !wasPlaying && !!state.track; setPlayIcon();
    if (state.mode === 'spotify') playerCall('PUT', wasPlaying ? '/me/player/pause' : '/me/player/play');
  }
  function skip(dir) {
    if (state.mode === 'idle') { openSetup(); return; }
    if (state.mode === 'demo') { Demo.step(dir); return; }
    playerCall('POST', dir > 0 ? '/me/player/next' : '/me/player/previous');
  }
  $('playBtn').onclick = togglePlay;
  $('nextBtn').onclick = () => skip(1);
  $('prevBtn').onclick = () => skip(-1);

  // ================================================================ tonearm: drag the needle anywhere on the record
  const armDrag = { active: false, moved: false, angle: ARM_REST, frac: 0, zone: 'rest', endedAt: 0 };
  const armHold = { angle: 0, until: 0 };   // keeps the arm where it was dropped until Spotify confirms
  const ARM_MAX = armAngleFor(1) + 2;

  // pointer position → tonearm-SVG coordinates, undoing the 3D tilt of the plinth
  function toArmSpace(clientX, clientY) {
    const deck = $('deck').getBoundingClientRect(), S = $('turntable').offsetWidth;
    const X = clientX - (deck.left + S / 2), Y = clientY - (deck.top + S / 2 - LIFT * S);
    const P = PERSP_K * S, sA = Math.sin(TILT), cA = Math.cos(TILT);
    const h = (ARM_PIVOT_H + tipHeight()) / 2 / 100 * S;      // height of the arm around where you grab it
    const v = (Y * P - Y * h * cA + h * sA * P) / (P * cA + Y * sA);
    const u = (X * (P - v * sA - h * cA)) / P;
    return [50 + (u / S) * 100, 50 + (v / S) * 100];
  }
  function needleAt(theta) {
    const t = theta * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const x = 86 + 2 * c - 58 * s, y = 14 + 2 * s + 58 * c;
    const r = Math.hypot(x - 50, y - 50) / REC_R * 100;
    return { r, frac: (R_OUT - r) / (R_OUT - R_IN) };
  }
  // what's under the needle: which track and how far into it
  function cueFor(frac) {
    const t = state.track;
    if (state.albumMode) {
      const el = frac * state.albumTotal;
      let i = 0; while (i < state.cum.length - 1 && state.cum[i + 1] <= el) i++;
      return { i, ms: el - state.cum[i], name: state.album.tracks[i].name };
    }
    return { i: state.trackIndex, ms: frac * t.durationMs, name: t.name };
  }

  function updateArmDrag(e) {
    const [x, y] = toArmSpace(e.clientX, e.clientY);
    const theta = clamp(Math.atan2(y - 14, x - 86) * 180 / Math.PI - ARM_VEC_DEG, ARM_REST, ARM_MAX);
    const n = needleAt(theta);
    armDrag.angle = theta;
    armDrag.zone = n.r > R_OUT + 2.5 ? 'rest' : 'record';
    armDrag.frac = clamp(n.frac, 0, 1);
    if (!state.track) return;
    if (armDrag.zone === 'rest') toast('Let go here to lift the needle', 60000);
    else {
      const c = cueFor(armDrag.frac);
      toast(state.albumMode ? `Track ${c.i + 1} · ${c.name} · ${fmt(c.ms)}` : `${c.name} · ${fmt(c.ms)} / ${fmt(state.track.durationMs)}`, 60000);
    }
  }

  (() => {
    const hit = $('armHit');
    hit.addEventListener('pointerdown', (e) => {
      if (state.mode === 'idle') return;
      e.stopPropagation(); e.preventDefault();
      armDrag.active = true; armDrag.moved = false;
      try { hit.setPointerCapture(e.pointerId); } catch {}
      document.body.classList.add('arm-dragging');
      setArmFilter();
      updateArmDrag(e);
    });
    hit.addEventListener('pointermove', (e) => { if (armDrag.active) { armDrag.moved = true; updateArmDrag(e); } });
    const end = (commit) => {
      if (!armDrag.active) return;
      armDrag.active = false; armDrag.endedAt = Date.now();
      document.body.classList.remove('arm-dragging');
      $('toast').classList.remove('show');
      setArmFilter();
      if (!commit || !armDrag.moved || !state.track) return;
      if (armDrag.zone === 'rest') { state.armParked = true; if (state.isPlaying) togglePlay(); return; }
      dropNeedle(armDrag.frac, armDrag.angle);
    };
    hit.addEventListener('pointerup', (e) => { e.stopPropagation(); end(true); });
    hit.addEventListener('pointercancel', () => end(false));
  })();

  async function dropNeedle(frac, angle) {
    const c = cueFor(frac);
    state.armParked = false;
    if (state.albumMode && c.i !== state.trackIndex) {
      // a different song on this album: start it from the spot the needle landed on
      armHold.angle = angle; armHold.until = performance.now() + 4000;
      await source().play({ contextUri: state.album.uri, offsetIndex: c.i, positionMs: c.ms });
      return;
    }
    const wasPlaying = state.isPlaying;
    await seekTo(c.ms);
    if (!wasPlaying) togglePlay();
  }

  // ================================================================ crackle (generated with Web Audio, nothing downloaded)
  const crackle = {
    ctx: null, gain: null, target: -1,
    enabled: store.get(LS.crackle) === '1',
    volume: Number(store.get(LS.vol) ?? .5) || .5,
    ensure() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = this.ctx = new AC();
      const sr = ctx.sampleRate, len = Math.floor(sr * 7.2); // 4 rotations at 33⅓ rpm
      const buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
      let pop = 0, decay = 0;
      for (let i = 0; i < len; i++) {
        let s = (Math.random() * 2 - 1) * .006;                          // surface hiss
        if (Math.random() < 28 / sr) {                                   // small crackles
          pop = (Math.random() * .35 + .06) * (Math.random() < .5 ? -1 : 1);
          decay = Math.exp(-1 / (sr * (.0003 + Math.random() * .0008)));
        } else if (Math.random() < .9 / sr) {                            // the odd louder pop
          pop = (Math.random() * .4 + .45) * (Math.random() < .5 ? -1 : 1);
          decay = Math.exp(-1 / (sr * .0014));
        }
        s += pop * (.7 + .3 * (Math.random() * 2 - 1));
        pop *= decay;
        d[i] = s;
      }
      for (let k = 0; k < 4; k++) {                                      // soft once-per-rotation tick
        const start = Math.floor((k * 1.8 + .35) * sr);
        for (let j = 0; j < sr * .02 && start + j < len; j++) d[start + j] += .12 * Math.sin(2 * Math.PI * 70 * j / sr) * Math.exp(-j / (sr * .005));
      }
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 220;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7500;
      this.gain = ctx.createGain(); this.gain.gain.value = 0;
      src.connect(hp).connect(lp).connect(this.gain).connect(ctx.destination);
      src.start();
    },
    setEnabled(on) {
      this.enabled = on; store.set(LS.crackle, on ? '1' : '0');
      if (on) { this.ensure(); this.ctx && this.ctx.resume(); }
      this.target = -1;
      $('crackleBtn').classList.toggle('active', on);
      $('crackleBtn').setAttribute('aria-pressed', String(on));
      $('crackleToggle').checked = on;
    },
    setVolume(v) { this.volume = v; store.set(LS.vol, String(v)); this.target = -1; },
    update(level) {
      if (!this.gain) return;
      const target = this.enabled ? this.volume * .9 * level : 0;
      if (Math.abs(target - this.target) < .01) return;
      this.target = target;
      this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, .08);
    },
  };
  $('crackleBtn').onclick = () => { crackle.setEnabled(!crackle.enabled); toast(crackle.enabled ? 'Crackle on' : 'Crackle off', 1500); };
  $('crackleToggle').onchange = (e) => crackle.setEnabled(e.target.checked);
  $('crackleVol').value = String(crackle.volume);
  $('crackleVol').oninput = (e) => crackle.setVolume(Number(e.target.value));
  crackle.setEnabled(crackle.enabled);
  // browsers only allow audio after a tap/click, so start it on the first one
  addEventListener('pointerdown', () => { if (crackle.enabled) { crackle.ensure(); crackle.ctx && crackle.ctx.resume(); } }, { once: true });

  // ================================================================ Spotify auth (PKCE — no server needed)
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function randomString(len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(len)), (x) => chars[x % chars.length]).join('');
  }
  const getTokens = () => { try { return JSON.parse(store.get(LS.tokens) || 'null'); } catch { return null; } };

  async function login() {
    const clientId = ($('clientId').value || store.get(LS.client) || '').trim();
    if (!clientId) { openSetup(); toast('Paste your Client ID first'); $('clientId').focus(); return; }
    if (!window.isSecureContext || !crypto.subtle) { toast('Spotify login needs https:// or http://127.0.0.1 — see the README', 6000); return; }
    store.set(LS.client, clientId);
    const verifier = randomString(64);
    store.set(LS.verifier, verifier);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({
      response_type: 'code', client_id: clientId, scope: SCOPES,
      code_challenge_method: 'S256', code_challenge: challenge, redirect_uri: REDIRECT_URI,
    });
    location.href = `https://accounts.spotify.com/authorize?${q}`;
  }

  async function tokenRequest(params) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
    const prev = getTokens() || {};
    const tokens = {
      access: data.access_token,
      refresh: data.refresh_token || prev.refresh,
      scope: data.scope || prev.scope || '',
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
    store.set(LS.tokens, JSON.stringify(tokens));
    return tokens;
  }

  async function handleRedirect() {
    const params = new URLSearchParams(location.search);
    if (!params.has('code') && !params.has('error')) return false;
    history.replaceState(null, '', REDIRECT_URI);
    if (params.has('error')) { toast(`Spotify said: ${params.get('error')}`); return false; }
    try {
      await tokenRequest({
        grant_type: 'authorization_code', code: params.get('code'), redirect_uri: REDIRECT_URI,
        client_id: store.get(LS.client), code_verifier: store.get(LS.verifier),
      });
      store.del(LS.verifier);
      return true;
    } catch (e) { toast(`Login failed: ${e.message}`, 6000); return false; }
  }

  let refreshing = null;
  async function accessToken() {
    const t = getTokens();
    if (!t) return null;
    if (Date.now() < t.expiresAt) return t.access;
    if (!t.refresh) return null;
    refreshing = refreshing || tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: store.get(LS.client) })
      .finally(() => { refreshing = null; });
    try { return (await refreshing).access; } catch { logout(true); return null; }
  }
  const hasLibraryScopes = () => /user-library-read/.test((getTokens() || {}).scope || '');

  function logout(expired) {
    store.del(LS.tokens); store.del(LS.mode);
    stopPolling();
    state.mode = 'idle'; resetLibrary();
    setPlayback({ track: null });
    updateDialog();
    if (expired) toast('Spotify session expired — reconnect in Settings');
  }

  async function api(path, opts = {}) {
    const token = await accessToken();
    if (!token) { if (state.mode === 'spotify') logout(true); throw new Error('not logged in'); }
    const url = path.startsWith('http') ? path : `https://api.spotify.com/v1${path}`;
    const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
    if (res.status === 401 && !opts._retried) {        // token revoked/expired early: refresh once
      const t = getTokens(); if (t) { t.expiresAt = 0; store.set(LS.tokens, JSON.stringify(t)); }
      return api(path, { ...opts, _retried: true });
    }
    return res;
  }
  async function getJSON(path) {
    const res = await api(path);
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  }

  // play / pause / seek etc. — finds a device automatically if none is active
  async function playerCall(method, path, body, deviceId) {
    if (state.mode !== 'spotify') return false;
    const url = deviceId ? `${path}${path.includes('?') ? '&' : '?'}device_id=${encodeURIComponent(deviceId)}` : path;
    let res;
    try {
      res = await api(url, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'Content-Type': 'application/json' } : {} });
    } catch { return false; }
    if (res.ok) { setTimeout(poll, 450); return true; }
    if (res.status === 404 && !deviceId) {
      try {
        const { devices = [] } = await getJSON('/me/player/devices');
        const d = devices.find((x) => x.is_active) || devices.find((x) => !x.is_restricted);
        if (d) return playerCall(method, path, body, d.id);
      } catch {}
      toast('No Spotify device found — open Spotify on your phone or computer first', 5000);
      setTimeout(poll, 300);
      return false;
    }
    const err = (await res.json().catch(() => ({}))).error || {};
    if (res.status === 403) toast(err.reason === 'PREMIUM_REQUIRED' || /premium/i.test(err.message || '') ? 'Playback controls need Spotify Premium' : `Spotify: ${err.message || 'not allowed right now'}`);
    else toast(`Spotify: ${err.message || `error ${res.status}`}`);
    setTimeout(poll, 300);
    return false;
  }

  // ================================================================ sources: Spotify and demo share one interface
  const Spotify = {
    async album(id) {
      const a = await getJSON(`/albums/${id}`);
      const items = [...(a.tracks?.items || [])];
      let next = a.tracks?.next;
      while (next && items.length < 600) { const p = await getJSON(next); items.push(...p.items); next = p.next; }
      return {
        id: a.id, uri: a.uri, name: a.name, artist: (a.artists || []).map((x) => x.name).join(', '),
        cover: pickImage(a.images) ? { url: pickImage(a.images) } : null,
        type: a.album_type, upc: a.external_ids?.upc || null, year: (a.release_date || '').slice(0, 4),
        tracks: items.filter(Boolean).map((t) => ({ id: t.id, uri: t.uri, name: t.name, durationMs: t.duration_ms, number: t.track_number, disc: t.disc_number })),
      };
    },
    async library(kind, next) {
      const data = await getJSON(next || (kind === 'albums' ? '/me/albums?limit=50' : '/me/playlists?limit=50'));
      const items = (data.items || []).filter(Boolean).map((x) => {
        if (kind === 'albums') {
          const a = x.album || x;
          const url = pickImage(a.images, 300);
          return { id: a.id, uri: a.uri, name: a.name, sub: (a.artists || []).map((r) => r.name).join(', '), cover: url ? { url } : null };
        }
        const total = x.items?.total ?? x.tracks?.total;           // `tracks` was renamed `items` in Feb 2026
        const url = pickImage(x.images, 300);
        return { id: x.id, uri: x.uri, name: x.name, sub: [x.owner?.display_name, total != null ? `${total} songs` : ''].filter(Boolean).join(' · '), cover: url ? { url } : null };
      }).filter((it) => it.uri);
      return { items, next: data.next };
    },
    async playlist(uri) {
      const id = uri.split(':').pop();
      const p = await getJSON(`/playlists/${encodeURIComponent(id)}`);
      const img = pickImage(p.images, 300);
      const base = { name: p.name, owner: p.owner?.display_name || '', cover: img ? { url: img } : null };
      const map = (t) => ({ id: t.id || t.uri, uri: t.uri, name: t.name, artist: (t.artists || []).map((a) => a.name).join(', ') || t.show?.name || '', durationMs: t.duration_ms || 0 });
      // Feb 2026: `tracks` → `items`, `track` → `item`; only sent for playlists you own or collaborate on
      const page = p.items && Array.isArray(p.items.items) ? p.items : p.tracks && Array.isArray(p.tracks.items) ? p.tracks : null;
      if (page) {
        const rows = [...page.items];
        let next = page.next;
        while (next && rows.length < 1000) { const pg = await getJSON(next); rows.push(...(pg.items || [])); next = pg.next; }
        return { ...base, tracks: rows.map((r) => r && (r.item || r.track)).filter((t) => t && t.uri).map(map) };
      }
      const q = await getJSON('/me/player/queue');
      return {
        ...base, upNext: true,
        tracks: [q.currently_playing, ...(q.queue || [])].filter(Boolean).map(map),
        note: 'Spotify only shares the full song list for playlists you own or collaborate on, so here’s what’s coming up next instead.',
      };
    },
    async contextName(uri) {
      const id = uri.split(':').pop();
      return (await getJSON(`/playlists/${encodeURIComponent(id)}?fields=name`)).name;
    },
    play({ contextUri, offsetIndex, positionMs }) {
      const body = { context_uri: contextUri };
      if (offsetIndex != null) body.offset = { position: offsetIndex };
      if (positionMs) body.position_ms = Math.round(positionMs);
      return playerCall('PUT', '/me/player/play', body);
    },
  };

  let pollTimer = null, backoffUntil = 0;
  function startPolling() { stopPolling(); poll(); pollTimer = setInterval(poll, POLL_MS); }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
  async function poll() {
    if (state.mode !== 'spotify' || document.hidden || Date.now() < backoffUntil || seekDrag.active) return;
    try {
      const res = await api('/me/player/currently-playing?additional_types=episode');
      if (res.status === 429) { backoffUntil = Date.now() + (Number(res.headers.get('Retry-After')) || 10) * 1000; return; }
      if (res.status === 204 || res.status === 202) { setPlayback({ track: null }); return; }
      if (!res.ok) {
        if (res.status === 403) toast('Spotify refused access — is your account added under User Management in the dashboard?', 6000);
        return;
      }
      const data = await res.json();
      let item = data.item;
      if (!item) {   // some content (and some account states) leave currently-playing empty; ask the full player
        try { const full = await getJSON('/me/player?additional_types=episode'); if (full && full.item) { item = full.item; Object.assign(data, full); } } catch {}
      }
      if (!item) {
        setPlayback(data.is_playing
          ? { track: { id: 'unknown', name: 'Something’s playing', artist: 'Spotify didn’t say what', albumName: '', albumId: null, cover: null, durationMs: 0 }, isPlaying: true, progressMs: 0, context: null }
          : { track: null });
        return;
      }
      const ep = item.type === 'episode';
      const images = ep ? (item.images || item.show?.images || []) : (item.album?.images || []);
      setPlayback({
        track: {
          id: item.id || item.uri, uri: item.uri, name: item.name,
          artist: ep ? (item.show?.name || 'Podcast') : (item.artists || []).map((a) => a.name).join(', '),
          albumName: ep ? (item.show?.publisher || '') : item.album?.name,
          albumId: ep || item.is_local ? null : (item.album?.id || null),
          cover: pickImage(images) ? { url: pickImage(images) } : null,
          durationMs: item.duration_ms || 1, number: item.track_number, disc: item.disc_number,
        },
        isPlaying: data.is_playing, progressMs: data.progress_ms,
        context: data.context ? { type: data.context.type, uri: data.context.uri } : null,
      });
    } catch { /* network blip — next tick will retry */ }
  }

  // ---- demo: a fake record collection so the app can be explored without Spotify
  const Demo = (() => {
    const R = rng(7);
    const defs = [
      ['Soft Static', 'The Paper Lanterns', ['#d9773f', '#2a140a'], 'radial-gradient(circle at 30% 30%, #f3b26b, #d9773f 45%, #7a2f17)',
        ['Late Bloom', 'Paper Moon Motel', 'Soft Static', 'Driftwood', 'Kettle Song', 'Porchlight', 'Goodnight, Telephone']],
      ['Night Roads', 'Mara Quill', ['#4c7fd9', '#0b1530'], 'conic-gradient(from 90deg, #1d2f6b, #4c7fd9, #9cc3ff, #4c7fd9, #1d2f6b)',
        ['Blue Hour Drive', 'Mile Marker 9', 'Sodium Lights', 'Passenger Side', 'Overpass', 'Headlights Off']],
      ['Kitchen Tapes', 'Juniper & Co.', ['#5fa86b', '#0e2213'], 'repeating-radial-gradient(circle, #5fa86b 0 8%, #e8e1c6 8% 11%, #2f6b3a 11% 19%)',
        ['Cardamom', 'Sunday Dough', 'Tin Cup', 'Basil', 'Window Box']],
      ['Rosewater', 'Ines Calder', ['#d79a9a', '#2b1414'], 'linear-gradient(160deg, #f1cfc6, #d79a9a 50%, #8c4a52)',
        ['Rosewater', 'Velvet Hour', 'Ribbon', 'Petals in the Sink', 'Slow Waltz', 'Lace', 'Again, Softly', 'Rosewater (Reprise)']],
      ['Low Tide', 'Harbor Saints', ['#3e8a8a', '#0b1d1d'], 'linear-gradient(180deg, #e9dcc2 0 38%, #3e8a8a 38% 70%, #1d4a4a 70%)',
        ['Low Tide', 'Gulls', 'Salt in the Seams', 'Breakwater', 'Lighthouse Keeper', 'Undertow']],
      ['Ochre', 'Field Recordings Club', ['#c99a3d', '#2a1d08'], 'radial-gradient(circle at 70% 30%, #f0d27a 0 18%, #c99a3d 19% 55%, #6d4a17 56%)',
        ['Ochre', 'Dry Grass', 'Heat Shimmer', 'Dust Devil', 'Harvest Moon']],
      ['Lemonade Stand', 'Kip Lowell', ['#e8c13a', '#2a2008'], 'linear-gradient(135deg, #f6e27a, #e8c13a 50%, #b8862a)',
        ['Lemonade Stand'], 'single'],
    ];
    const albums = defs.map(([name, artist, colors, gradient, names, type = 'album'], ai) => ({
      id: `a${ai}`, uri: `demo:album:a${ai}`, name, artist, type, cover: { gradient, colors },
      tracks: names.map((n, ti) => ({ id: `a${ai}t${ti}`, uri: `demo:track:a${ai}t${ti}`, name: n, number: ti + 1, disc: 1, durationMs: Math.round((150 + R() * 140) * 1000) })),
    }));
    const playlists = [
      ['Sunday Morning', [[2, 0], [3, 1], [0, 4], [5, 3], [2, 3], [3, 4]]],
      ['Late Night Spins', [[1, 0], [4, 2], [1, 2], [3, 6], [4, 5], [1, 5]]],
      ['Road Trip', [[1, 1], [5, 0], [0, 0], [4, 0], [2, 2], [1, 3], [0, 2]]],
    ].map(([name, refs], pi) => ({ id: `p${pi}`, uri: `demo:playlist:p${pi}`, name, refs }));

    let queue = [], qi = 0, context = null;
    const push = (progressMs = 0, isPlaying = true) => {
      const { a, t } = queue[qi];
      setPlayback({
        track: { id: t.id, uri: t.uri, name: t.name, artist: a.artist, albumName: a.name, albumId: a.id, cover: a.cover, durationMs: t.durationMs, number: t.number, disc: 1 },
        isPlaying, progressMs, context,
      });
    };
    return {
      albums,
      album: async (id) => albums.find((a) => a.id === id),
      library: async (kind) => ({
        next: null,
        items: kind === 'albums'
          ? albums.map((a) => ({ id: a.id, uri: a.uri, name: a.name, sub: a.artist, cover: a.cover }))
          : playlists.map((p) => ({ id: p.id, uri: p.uri, name: p.name, sub: `Demo playlist · ${p.refs.length} songs`, cover: albums[p.refs[0][0]].cover })),
      }),
      contextName: async (uri) => (playlists.find((p) => p.uri === uri) || {}).name,
      async playlist(uri) {
        const p = playlists.find((x) => x.uri === uri);
        return {
          name: p.name, owner: 'Demo', cover: albums[p.refs[0][0]].cover,
          tracks: p.refs.map(([ai, ti]) => { const a = albums[ai], t = a.tracks[ti]; return { id: t.id, uri: t.uri, name: t.name, artist: a.artist, durationMs: t.durationMs }; }),
        };
      },
      // made-up pressings so the vinyl panel can be explored offline
      async vinyl(a) {
        await new Promise((r) => setTimeout(r, 500));
        const P = (dis, date, country, label, catno, format = '12" Vinyl') => ({ dis, date, country, label, catno, format, discogs: null, look: parseLook(dis) });
        const table = {
          a0: [P('tangerine translucent', '2024', 'US', 'Paper Moon Records', 'PMR-012'), P('', '2024', 'US', 'Paper Moon Records', 'PMR-011'), P('picture disc', '2025', 'GB', 'Paper Moon Records', 'PMR-012PD')],
          a1: [P('blue marble', '2023', 'US', 'Night Shift', 'NS-004'), P('', '2023', 'US', 'Night Shift', 'NS-003')],
          a3: [P('pink with white splatter', '2022', 'US', 'Calder Music', 'CM-77')],
          a4: [P('sea glass clear', '2021', 'CA', 'Harbor', 'HB-9')],
          a5: [P('', '2020', 'US', 'Field Recordings', 'FRC-1')],
        };
        const pressings = sortPressings(table[a.id] || []);
        return { found: a.id !== 'a6', demo: true, pressings, discogsMaster: null, shops: [] };
      },
      async play({ contextUri, offsetIndex = 0, positionMs = 0 }) {
        const [, type, id] = contextUri.split(':');
        if (type === 'album') { const a = albums.find((x) => x.id === id); queue = a.tracks.map((t) => ({ a, t })); }
        else { const p = playlists.find((x) => x.id === id); queue = p.refs.map(([ai, ti]) => ({ a: albums[ai], t: albums[ai].tracks[ti] })); }
        context = { type, uri: contextUri };
        qi = clamp(offsetIndex, 0, queue.length - 1);
        push(positionMs);
      },
      step(dir) {
        if (!queue.length) return;
        if (dir < 0 && currentProgress() > 3000) { seekTo(0); return; }
        qi = (qi + dir + queue.length) % queue.length;
        push(0, true);
      },
      tick() { if (state.track && state.isPlaying && currentProgress() >= state.track.durationMs) this.step(1); },
    };
  })();

  const source = () => (state.mode === 'demo' ? Demo : Spotify);

  function startDemo() {
    stopPolling();
    state.mode = 'demo'; store.set(LS.mode, 'demo'); resetLibrary();
    Demo.play({ contextUri: Demo.albums[0].uri });
    state.progressMs = 52000;
    updateDialog();
    toast('Demo mode — connect Spotify in Settings for the real thing');
  }

  // ================================================================ vinyl: pressings, special editions, where to buy
  // Pressing data comes from MusicBrainz (free, public, no key). Spotify doesn't know about physical releases.

  // words MusicBrainz editors use in release notes ("red vinyl", "blue marble", "picture disc"…) → colours
  const COLOR_WORDS = [
    ['coke bottle', '#7fae8f'], ['sea glass', '#9cc9bd'], ['seafoam', '#9cd7c3'], ['blood', '#7a1420'], ['mahogany', '#6a2b1f'],
    ['burgundy', '#5e1a28'], ['wine', '#5a1a26'], ['cherry', '#9b1b30'], ['plum', '#5d2a4f'], ['berry', '#7a2350'], ['coral', '#ec7b6a'],
    ['salmon', '#ee9b85'], ['jade', '#3f9a72'], ['forest', '#2c4a2e'], ['sage', '#9caf94'], ['lime', '#9bc53d'], ['lemon', '#f2dc5d'],
    ['honey', '#d9a13a'], ['caramel', '#b4733a'], ['tan', '#c19a6b'], ['sand', '#d8c29a'], ['ivory', '#f1ead8'], ['pearl', '#efe9e1'],
    ['indigo', '#33307a'], ['midnight', '#1b2440'], ['ocean', '#2a6a8a'], ['slate', '#5b6670'], ['charcoal', '#333333'], ['oxblood', '#5a1618'], ['crimson', '#9e1b2f'], ['maroon', '#6b1a1f'],
    ['ruby', '#9b1b30'], ['red', '#b3262a'], ['navy', '#1f2f5a'], ['cobalt', '#2847a8'], ['sapphire', '#24489c'], ['sky', '#8ec5ea'],
    ['blue', '#2f5fb3'], ['turquoise', '#2fb3ad'], ['teal', '#1f8580'], ['aqua', '#4cc3d0'], ['emerald', '#1f7a4f'], ['mint', '#98d8b5'],
    ['olive', '#6b6b2a'], ['green', '#2f8a4c'], ['mustard', '#c9a12a'], ['yellow', '#e8c13a'], ['gold', '#c9a13b'], ['amber', '#d9902a'],
    ['tangerine', '#ec7a2a'], ['orange', '#e0702a'], ['peach', '#f0b48f'], ['magenta', '#c2307f'], ['rose', '#d99aa5'], ['pink', '#e893b4'],
    ['violet', '#7d4fc4'], ['lavender', '#b9a3df'], ['purple', '#6b3fa0'], ['cream', '#ebdfc2'], ['bone', '#e3d9c4'], ['beige', '#d9c7a5'],
    ['white', '#ecebe6'], ['silver', '#b8bcc2'], ['grey', '#7a7a7a'], ['gray', '#7a7a7a'], ['smoke', '#5a5f66'], ['bronze', '#9a6a3a'],
    ['copper', '#b86b3b'], ['brown', '#6b4426'], ['clear', '#d8dde2'], ['black', '#121212'],
  ];
  function parseLook(text) {
    const t = ` ${(text || '').toLowerCase()} `;
    if (!t.trim()) return null;
    if (/pic(ture)?[\s-]*dis[ck]/.test(t)) return { kind: 'picture' };
    const colors = [];
    let rest = t;
    for (const [word, hex] of COLOR_WORDS) {
      const re = new RegExp(`[^a-z]${word}[^a-z]`);
      if (re.test(rest)) { colors.push({ word, hex, at: t.search(re) }); rest = rest.replace(re, ' '); }
    }
    colors.sort((a, b) => a.at - b.at);
    const translucent = /clear|transparent|translucent|see-through|crystal|smoke|glass|coke bottle/.test(t);
    const kind = /splatter|splatter|speckle|spatter/.test(t) ? 'splatter' : /marble|swirl|galaxy|haze|smoke|tie[\s-]?dye|color[\s-]?in[\s-]?colou?r|colou?r[\s-]?in[\s-]?colou?r/.test(t) ? 'marble' : 'color';
    if (!colors.length && !translucent && kind === 'color') return null;
    if (colors.length === 1 && colors[0].word === 'black' && kind === 'color') return null;   // plain black = standard
    // "Gold Edition", "Silver Anniversary"… are names, not colours, unless vinyl is mentioned
    if (colors.every((c) => /gold|silver/.test(c.word)) && !/vinyl|wax|colou?r|lp\b/.test(t)) return null;
    const base = colors[0]?.hex || '#d8dde2';
    const accent = colors[1]?.hex || (kind === 'splatter' ? '#151515' : '#f2efe9');
    return { kind, base, accent, translucent };
  }
  // CSS for a pressing look (also used for the little swatches)
  function lookCss(look, cover) {
    if (!look) return null;
    if (look.kind === 'picture') {
      const art = cover && cover.url ? `url("${cover.url}") center / cover no-repeat` : (cover && cover.gradient) || 'linear-gradient(#444, #222)';
      return { vinyl: art, fx: 'repeating-radial-gradient(circle, rgba(0,0,0,.13) 0 1px, rgba(255,255,255,.05) 1px 2px, transparent 2px 4px)', runout: 'transparent', picture: true };
    }
    const b = look.base, alpha = look.translucent ? 74 : 100;
    const tone = (pct) => `color-mix(in srgb, color-mix(in srgb, ${b} ${pct}%, #000) ${alpha}%, transparent)`;
    const vinyl = `repeating-radial-gradient(circle, ${tone(86)} 0 1px, ${tone(100)} 1px 2px, ${tone(74)} 2px 3px)`;
    let fx = `radial-gradient(circle at 32% 28%, rgba(255,255,255,${look.translucent ? .3 : .14}), transparent 58%)`;
    if (look.kind === 'splatter') {
      const R = rng(hashOf(b + look.accent));
      const spots = Array.from({ length: 22 }, () => {
        const x = (12 + R() * 76).toFixed(1), y = (12 + R() * 76).toFixed(1), r = (.8 + R() * 2.6).toFixed(1);
        return `radial-gradient(circle at ${x}% ${y}%, ${look.accent} 0 ${r}%, transparent ${(+r + .5).toFixed(1)}%)`;
      });
      fx = spots.join(', ') + ', ' + fx;
    } else if (look.kind === 'marble') {
      const a = look.accent;
      fx = `conic-gradient(from 40deg, transparent 0 6%, color-mix(in srgb, ${a} 70%, transparent) 13%, transparent 21% 44%, color-mix(in srgb, ${a} 55%, transparent) 53%, transparent 62% 78%, color-mix(in srgb, ${a} 62%, transparent) 87%, transparent 95%), ` + fx;
    }
    return { vinyl, fx, runout: `color-mix(in srgb, ${b} 50%, #000)` };
  }
  function applyLook(look) {
    const css = lookCss(look, state.album ? state.album.cover : state.track && state.track.cover);
    const st = document.documentElement.style;
    if (!css) ['--vinyl', '--vinyl-fx', '--runout'].forEach((p) => st.removeProperty(p));
    else { st.setProperty('--vinyl', css.vinyl); st.setProperty('--vinyl-fx', css.fx); st.setProperty('--runout', css.runout); }
    document.body.classList.toggle('picture-disc', !!(css && css.picture));
  }
  const swatchBg = (look, cover) => {
    const css = lookCss(look, cover);
    const label = css && css.picture ? '' : 'radial-gradient(circle, var(--c1) 0 22%, transparent 24%), ';
    return css ? `${label}${css.fx}, ${css.vinyl}` : `${label}repeating-radial-gradient(circle, #141414 0 1px, #222 1px 2px)`;
  };
  const pressName = (p) => p.dis ? p.dis.charAt(0).toUpperCase() + p.dis.slice(1) : 'Standard pressing';
  function sortPressings(list) {   // special looks first, then oldest first
    return list.slice().sort((a, b) => (!!b.look - !!a.look) || String(a.date || '9999').localeCompare(String(b.date || '9999')));
  }

  // ---- MusicBrainz (1 request per second, as their rules ask)
  const MB = (() => {
    let nextAt = 0;
    async function get(path, tries = 2) {
      const wait = Math.max(0, nextAt - Date.now()); nextAt = Date.now() + wait + 1100;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const res = await fetch(`https://musicbrainz.org/ws/2/${path}${path.includes('?') ? '&' : '?'}fmt=json`, { headers: { Accept: 'application/json' } });
      if (res.status === 503 && tries > 0) { await new Promise((r) => setTimeout(r, 2000)); return get(path, tries - 1); }
      if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
      return res.json();
    }
    const luc = (s) => String(s).replace(/([+\-!(){}\[\]^"~*?:\\\/]|&&|\|\|)/g, '\\$1');
    const rels = (o) => (o && o.relations) || [];
    async function lookup(album) {
      const artist = (album.artist || '').split(', ')[0];
      let rgId = null;
      if (album.upc) {
        try { const r = await get(`release/?query=${encodeURIComponent(`barcode:${album.upc}`)}&limit=3`); rgId = r.releases?.[0]?.['release-group']?.id || null; } catch {}
      }
      if (!rgId) {
        const clean = album.name.replace(/\s*[(\[][^)\]]*(remaster|deluxe|edition|version|anniversary|expanded|bonus)[^)\]]*[)\]]/gi, '').trim() || album.name;
        const q = `releasegroup:"${luc(clean)}" AND artist:"${luc(artist)}"`;
        const r = await get(`release-group/?query=${encodeURIComponent(q)}&limit=5`);
        const best = (r['release-groups'] || []).find((g) => g.score >= 90);
        rgId = best ? best.id : null;
      }
      if (!rgId) return { found: false, pressings: [], shops: [] };
      const rg = await get(`release-group/${rgId}?inc=url-rels`);
      const rel = await get(`release?release-group=${rgId}&inc=media+url-rels+labels&limit=100`);
      const vinyl = (rel.releases || []).filter((r) => (r.media || []).some((m) => /vinyl/i.test(m.format || '')));
      const shops = new Map();
      const pressings = vinyl.map((r) => {
        rels(r).filter((x) => x.type === 'purchase for mail-order' || x.type === 'amazon asin')
          .forEach((x) => { const u = x.url && x.url.resource; if (u && !shops.has(u)) shops.set(u, x.type); });
        const li = (r['label-info'] || [])[0] || {};
        return {
          dis: r.disambiguation || '', date: (r.date || '').slice(0, 4), country: r.country || '',
          label: (li.label && li.label.name) || '', catno: li['catalog-number'] || '',
          format: [...new Set((r.media || []).map((m) => m.format).filter(Boolean))].join(' + '),
          discogs: (rels(r).find((x) => x.type === 'discogs') || {}).url?.resource || null,
          look: parseLook(r.disambiguation),
        };
      });
      return {
        found: true, mbUrl: `https://musicbrainz.org/release-group/${rgId}`,
        discogsMaster: (rels(rg).find((x) => x.type === 'discogs') || {}).url?.resource || null,
        pressings: sortPressings(pressings),
        shops: [...shops].map(([url, type]) => ({ url, type })),
      };
    }
    return { lookup };
  })();

  Spotify.vinyl = async (album) => {
    const key = `tt.mb.${album.id}`;
    try { const c = JSON.parse(store.get(key) || 'null'); if (c && Date.now() - c.at < 7 * 864e5) return c.data; } catch {}
    const data = await MB.lookup(album);
    store.set(key, JSON.stringify({ at: Date.now(), data }));
    return data;
  };

  const vinyl = { albumId: null, status: 'idle', data: null, choice: -1, showAll: false };
  async function onAlbumForVinyl(a) {
    if (!a) {
      vinyl.albumId = null; vinyl.status = 'idle'; vinyl.data = null; vinyl.choice = -1;
      applyLook(null); renderVinyl(); return;
    }
    if (vinyl.albumId === a.id) return;
    Object.assign(vinyl, { albumId: a.id, status: 'loading', data: null, choice: -1, showAll: false });
    applyLook(null); renderVinyl();
    try {
      const data = await source().vinyl(a);
      if (vinyl.albumId !== a.id) return;
      vinyl.data = data; vinyl.status = 'done';
      const ps = data.pressings || [];
      const saved = store.get(`tt.press.${a.id}`);
      let choice = saved != null ? Number(saved) : ps.findIndex((p) => p.look);   // special edition? show it
      if (!(choice >= 0 && choice < ps.length)) choice = -1;
      vinyl.choice = choice;
      applyLook(choice >= 0 ? ps[choice].look : null);
      if (saved == null && choice >= 0) toast(`Special edition found — spinning the ${pressName(ps[choice]).toLowerCase()}`, 4000);
    } catch {
      if (vinyl.albumId === a.id) vinyl.status = 'error';
    }
    renderVinyl();
  }

  function storeSearches(a) {
    const q = `${(a.artist || '').split(', ')[0]} ${a.name}`.trim(), e = encodeURIComponent;
    return [
      ['Discogs', `https://www.discogs.com/search/?q=${e(q)}&type=all&format_exact=Vinyl`],
      ['Amazon', `https://www.amazon.com/s?k=${e(`${q} vinyl`)}`],
      ['Target', `https://www.target.com/s?searchTerm=${e(`${q} vinyl`)}`],
      ['Walmart', `https://www.walmart.com/search?q=${e(`${q} vinyl`)}`],
      ['Barnes & Noble', `https://www.barnesandnoble.com/s/${e(`${q} vinyl`)}`],
      ['Urban Outfitters', `https://www.urbanoutfitters.com/search?q=${e(`${q} vinyl`)}`],
      ['Bandcamp', `https://bandcamp.com/search?q=${e(q)}&item_type=a`],
      ['eBay', `https://www.ebay.com/sch/i.html?_nkw=${e(`${q} vinyl`)}`],
    ];
  }
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const discogsSell = (u) => {
    const m = /discogs\.com\/(master|release)\/(\d+)/.exec(u || '');
    if (!m) return u;
    return m[1] === 'master' ? `https://www.discogs.com/sell/list?master_id=${m[2]}&format=Vinyl` : `https://www.discogs.com/sell/release/${m[2]}`;
  };
  const link = (href, inner, cls = '') => `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;

  function renderVinyl() {
    const a = state.album, ps = (vinyl.data && vinyl.data.pressings) || [];
    // pill under the album name
    const chosen = vinyl.choice >= 0 ? ps[vinyl.choice] : null;
    $('vinylDot').style.background = swatchBg(chosen && chosen.look, a && a.cover);
    $('vinylPillText').textContent = chosen && chosen.look ? `${pressName(chosen)} · where to buy` : 'Vinyl & where to buy';
    $('vinylBtn').classList.toggle('hidden', !state.track || !a);
    if (!a) { $('vpBody').innerHTML = '<p class="vp-note">This one isn’t part of an album Spotify knows about, so there’s nothing to look up.</p>'; return; }

    $('vpCover').style.backgroundImage = coverCss(a.cover);
    $('vpTitle').textContent = a.name;
    $('vpSub').textContent = [a.artist, a.year].filter(Boolean).join(' · ');
    let h = '<h4>Pressings</h4>';
    if (vinyl.status === 'loading') h += '<p class="vp-note">Flipping through the crates on MusicBrainz…</p>';
    else if (vinyl.status === 'error') h += '<p class="vp-note">Couldn’t reach MusicBrainz right now, so pressings are unknown. The shop searches below still work.</p>';
    else if (!ps.length) {
      h += `<p class="vp-empty"><b>No vinyl pressing found.</b>${vinyl.data && vinyl.data.found
        ? 'MusicBrainz knows this release but lists no vinyl version — it may be digital-only.'
        : 'We couldn’t find this release on MusicBrainz.'} The shop searches below may still turn something up.</p>`;
    } else {
      const radio = (val, checked, disc, title, meta, extra = '') =>
        `<label class="press"><input type="radio" name="press" value="${val}" ${checked ? 'checked' : ''}><span class="press-disc" style="background:${esc(disc)}"></span><span><b>${title}</b><small>${meta}</small></span>${extra}</label>`;
      h += radio(-1, vinyl.choice === -1, swatchBg(null), 'Classic black', 'How the turntable shows it by default');
      const shown = vinyl.showAll ? ps : ps.slice(0, 10);
      shown.forEach((p, i) => {
        const meta = [p.date, p.country, [p.label, p.catno].filter(Boolean).join(' '), p.format].filter(Boolean).map(esc).join(' · ');
        const tag = p.look ? '<span class="tag">Special</span>' : '';
        h += radio(i, vinyl.choice === i, swatchBg(p.look, a.cover), esc(pressName(p)) + tag, meta, p.discogs ? link(discogsSell(p.discogs), 'Discogs') : '');
      });
      if (ps.length > shown.length) h += `<button class="vp-more" id="vpMore">Show all ${ps.length} pressings</button>`;
    }

    h += '<h4>Where to buy</h4>';
    const direct = [];
    if (vinyl.data && vinyl.data.discogsMaster) direct.push(link(discogsSell(vinyl.data.discogsMaster), '<span>Discogs marketplace</span><small>every pressing, new &amp; used</small>', 'vp-link'));
    ((vinyl.data && vinyl.data.shops) || []).slice(0, 6).forEach((s) =>
      direct.push(link(s.url, `<span>${esc(hostOf(s.url))}</span><small>${s.type === 'amazon asin' ? 'exact listing' : 'listed on MusicBrainz'}</small>`, 'vp-link')));
    if (direct.length) h += `<div class="vp-links">${direct.join('')}</div>`;
    h += `<div class="vp-sub">${direct.length ? 'Or search the shops' : 'Search the shops'}</div><div class="vp-shops">${
      storeSearches(a).map(([name, url]) => link(url, `${esc(name)}<small>Search for this record</small>`)).join('')}</div>`;
    h += `<p class="vp-fine">Shop links open a search — stock and prices aren’t checked.${vinyl.data && vinyl.data.demo
      ? ' Pressings here are demo data.'
      : ` Pressing info from ${link(vinyl.data && vinyl.data.mbUrl || 'https://musicbrainz.org', 'MusicBrainz')}, a community-run music database.`}</p>`;
    $('vpBody').innerHTML = h;
    const more = $('vpMore'); if (more) more.onclick = () => { vinyl.showAll = true; renderVinyl(); };
  }
  $('vpBody').addEventListener('change', (e) => {
    if (e.target.name !== 'press' || !state.album) return;
    const i = Number(e.target.value), ps = (vinyl.data && vinyl.data.pressings) || [];
    vinyl.choice = i; store.set(`tt.press.${state.album.id}`, String(i));
    applyLook(i >= 0 && ps[i] ? ps[i].look : null);
    renderVinyl();
  });
  $('vinylBtn').onclick = () => {
    const p = $('vinylPanel');
    if (p.classList.contains('open')) closePanel(p); else { renderVinyl(); openPanel(p); }
  };

  // ================================================================ panels: library + tracklist
  const scrim = $('scrim');
  const dockedQuery = matchMedia('(min-width: 1280px) and (min-aspect-ratio: 1/1)');
  const isDocked = () => dockedQuery.matches && (document.body.classList.contains('has-album') || document.body.classList.contains('tl-queue'));
  const isTracklistVisible = () => isDocked() || $('tracklist').classList.contains('open');

  function openPanel(p) {
    document.querySelectorAll('.panel.open').forEach((x) => x !== p && x.classList.remove('open'));
    p.classList.add('open'); scrim.classList.add('show');
    wake();
  }
  function closePanel(p) {
    p.classList.remove('open');
    if (!document.querySelector('.panel.open')) scrim.classList.remove('show');
  }
  scrim.onclick = () => document.querySelectorAll('.panel.open').forEach(closePanel);
  document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => closePanel(b.closest('.panel')); });

  // ---------------------------------------------------------------- playlist queue in the tracklist panel
  const plCache = new Map();
  async function openQueue() {
    const c = state.context;
    if (!c || c.type !== 'playlist') return;
    Object.assign(tl, { mode: 'queue', uri: c.uri, data: null });
    document.body.classList.add('tl-queue');
    renderQueue();
    if (!isDocked()) openPanel($('tracklist'));
    const req = ++tl.req;
    try {
      let hit = plCache.get(c.uri);
      if (!hit || Date.now() - hit.at > (hit.data.upNext ? 15e3 : 5 * 60e3)) { hit = { at: Date.now(), data: await source().playlist(c.uri) }; plCache.set(c.uri, hit); }
      if (req === tl.req && tl.mode === 'queue') { tl.data = hit.data; renderQueue(); }
    } catch { if (req === tl.req && tl.mode === 'queue') { tl.data = { error: true }; renderQueue(); } }
  }
  function closeQueue() {
    if (tl.mode !== 'queue') return;
    Object.assign(tl, { mode: 'album', uri: null, data: null }); tl.req++;
    document.body.classList.remove('tl-queue');
    if (state.album) { renderTracklist(); highlightTracklist(); } else closePanel($('tracklist'));
  }
  function renderQueue() {
    const d = tl.data, list = $('tlList');
    $('tlKicker').textContent = d && d.upNext ? 'Up next' : 'Playlist';
    $('tlTitle').textContent = (d && d.name) || ctxNames.get(tl.uri) || 'Playlist';
    $('tlCover').style.backgroundImage = d && d.cover ? coverCss(d.cover) : '';
    if (!d) { $('tlSub').textContent = ''; list.innerHTML = '<li class="tl-note">Pulling the songs from Spotify…</li>'; return; }
    if (d.error) { $('tlSub').textContent = ''; list.innerHTML = '<li class="tl-note">Couldn’t load this playlist right now.</li>'; return; }
    $('tlSub').textContent = d.upNext ? 'Your Spotify queue' : [d.owner, `${d.tracks.length} songs`].filter(Boolean).join(' · ');
    list.innerHTML = (d.note ? `<li class="tl-note">${esc(d.note)}</li>` : '') + d.tracks.map((t, i) =>
      `<li><button data-i="${i}" ${d.upNext ? 'disabled' : ''}><span class="n">${i + 1}</span><span class="nm">${esc(t.name)}<small>${esc(t.artist)}</small></span><span class="d">${t.durationMs ? fmt(t.durationMs) : ''}</span></button></li>`).join('');
    highlightQueue();
  }
  function highlightQueue() {
    const d = tl.data, t = state.track;
    if (!d || !d.tracks) return;
    const idx = t ? d.tracks.findIndex((x) => x.uri === t.uri || x.id === t.id) : -1;
    const lis = [...$('tlList').querySelectorAll('li:not(.tl-note)')];
    lis.forEach((li, i) => li.classList.toggle('current', i === idx));
    if (lis[idx] && isTracklistVisible()) lis[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  const ctxEl = $('ctxLine');
  const onCtx = () => {
    if (!ctxEl.classList.contains('link')) return;
    if (tl.mode === 'queue' && isTracklistVisible()) closeQueue();
    else if (tl.mode === 'queue') openPanel($('tracklist'));
    else openQueue();
  };
  ctxEl.addEventListener('click', onCtx);
  ctxEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCtx(); } });
  // the tracklist's × leaves the playlist view and goes back to the album list
  $('tracklist').querySelector('[data-close]').onclick = () => (tl.mode === 'queue' ? closeQueue() : closePanel($('tracklist')));

  $('tracklistBtn').onclick = () => {
    const p = $('tracklist');
    if (p.classList.contains('open')) closePanel(p);
    else { openPanel(p); highlightTracklist(); }
  };

  // ---------------------------------------------------------------- record wall (library)
  const KINDS = ['albums', 'playlists'];
  const lib = { items: {}, loading: {}, query: '', gen: 0, tab: store.get('tt.wallTab') === 'playlists' ? 'playlists' : 'albums' };
  const wallOpen = () => $('library').classList.contains('open');
  function resetLibrary() { lib.items = {}; lib.loading = {}; lib.gen++; if (wallOpen()) renderWall(); }

  $('libraryBtn').onclick = () => {
    const p = $('library');
    if (wallOpen()) { closePanel(p); return; }
    if (state.mode === 'idle') { openSetup(); return; }
    openPanel(p); renderWall();
    KINDS.forEach((k) => { if (!lib.items[k]) loadAll(k); });
  };
  $('libSearch').addEventListener('input', (e) => { lib.query = e.target.value; renderWall(); });
  function setWallTab(tab) {
    lib.tab = tab; store.set('tt.wallTab', tab);
    document.querySelectorAll('.wall-tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $('wallScroll').scrollTop = 0;
    if (wallOpen()) renderWall();
  }
  document.querySelectorAll('.wall-tabs [data-tab]').forEach((b) => { b.onclick = () => setWallTab(b.dataset.tab); });
  document.querySelectorAll('.wall-tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === lib.tab)));

  // load every page so the whole collection ends up on the wall
  async function loadAll(kind) {
    if (lib.loading[kind]) return;
    if (state.mode === 'spotify' && !hasLibraryScopes()) { renderWall(); return; }
    const gen = lib.gen;
    lib.loading[kind] = true; lib.items[kind] = lib.items[kind] || [];
    renderWall();
    let next = null, pages = 0;
    try {
      do {
        const r = await source().library(kind, next);
        if (gen !== lib.gen) return;
        lib.items[kind] = lib.items[kind].concat(r.items);
        next = r.next; pages++;
        if (wallOpen()) renderWall();
      } while (next && pages < 40);
    } catch (e) {
      if (gen !== lib.gen) return;
      toast(e.status === 403 ? 'Spotify refused the library request — try Disconnect, then Connect again' : `Couldn’t load your ${kind}`);
    }
    lib.loading[kind] = false;
    renderWall();
  }

  const hashOf = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const placeholder = (id) => {
    const h = hashOf(id) % 360;
    return `linear-gradient(140deg, hsl(${h} 32% 46%), hsl(${(h + 40) % 360} 38% 24%))`;
  };

  let wallCols = 0;
  function wallLayout() {
    const sc = $('wallScroll'), cs = getComputedStyle(sc);
    const w = sc.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const target = w < 520 ? 96 : w < 900 ? 132 : 158, gap = w < 520 ? 14 : 26;
    return { cols: Math.max(2, Math.floor((w + gap) / (target + gap))), gap };
  }

  function renderWall() {
    const msg = $('wallMsg');
    const secs = document.querySelectorAll('.wall-sec');
    if (state.mode === 'spotify' && !hasLibraryScopes()) {
      msg.innerHTML = 'To put your albums and playlists on the wall, Turntable needs a little more permission from Spotify.<br><button class="btn primary" id="reauthBtn">Reconnect Spotify</button>';
      $('reauthBtn').onclick = login;
      secs.forEach((s) => { s.hidden = true; });
      return;
    }
    const q = lib.query.trim().toLowerCase();
    const { cols, gap } = wallLayout(); wallCols = cols;
    let shown = 0;
    for (const sec of secs) {
      const kind = sec.dataset.kind, all = lib.items[kind], loading = lib.loading[kind];
      const shelves = sec.querySelector('.shelves');
      document.querySelector(`[data-count="${kind}"]`).textContent = all ? `${all.length}${loading ? '…' : ''}` : '';
      if (kind !== lib.tab) { sec.hidden = true; continue; }
      const list = (all || []).map((it, i) => ({ it, i })).filter(({ it }) => !q || `${it.name} ${it.sub}`.toLowerCase().includes(q));
      if (!list.length) {
        sec.hidden = false;
        if (q) { shelves.innerHTML = ''; continue; }
        shelves.innerHTML = `<p class="wall-note">${!all || loading ? 'Flipping through your records…' : `No saved ${kind} yet.`}</p>`;
        continue;
      }
      sec.hidden = false; shown += list.length;
      let html = '';
      for (let r = 0; r < list.length; r += cols) {
        const row = list.slice(r, r + cols);
        html += `<div class="shelf-row" style="--cols:${cols};--gap:${gap}px">
          <div class="row-covers">${row.map((x) => coverHtml(kind, x)).join('')}</div>
          <div class="plank"></div>
          <div class="row-caps">${row.map(({ it, i }) => `<button class="cap" data-kind="${kind}" data-i="${i}" tabindex="-1"><span class="name">${esc(it.name)}</span><span class="sub">${esc(it.sub)}</span></button>`).join('')}</div>
        </div>`;
      }
      shelves.innerHTML = html;
    }
    msg.textContent = q && !shown ? `No records match “${lib.query.trim()}”.` : '';
    markCurrentOnWall();
  }

  function coverHtml(kind, { it, i }) {
    const tilt = ((hashOf(it.id) % 25) - 12) / 10;          // -1.2° … 1.2°, stable per record
    const bg = it.cover && !it.cover.url ? it.cover.gradient : placeholder(it.id);
    const img = it.cover && it.cover.url ? `<img src="${esc(it.cover.url)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '';
    const initial = esc((it.name || '?').trim().charAt(0).toUpperCase());
    return `<button class="rec" data-kind="${kind}" data-i="${i}" data-uri="${esc(it.uri)}" style="--tilt:${tilt}deg" title="Play ${esc(it.name)}" aria-label="Play ${esc(it.name)}">
      <span class="cover" style="background:${esc(bg)}">${it.cover ? '' : initial}${img}</span></button>`;
  }

  function markCurrentOnWall() {
    document.querySelectorAll('.rec.current').forEach((r) => r.classList.remove('current'));
    const uri = state.context && state.context.uri;
    if (uri) document.querySelectorAll(`.rec[data-uri="${CSS.escape(uri)}"]`).forEach((r) => r.classList.add('current'));
  }

  let pulling = false;
  $('wallScroll').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i][data-kind]'); if (!b || pulling) return;
    const it = (lib.items[b.dataset.kind] || [])[Number(b.dataset.i)]; if (!it) return;
    state.armParked = false;
    source().play({ contextUri: it.uri });
    // slide the record out of its sleeve, then head back to the turntable
    const rec = b.classList.contains('rec') ? b : $('wallScroll').querySelector(`.rec[data-kind="${b.dataset.kind}"][data-i="${b.dataset.i}"]`);
    if (!rec || matchMedia('(prefers-reduced-motion: reduce)').matches) { closePanel($('library')); return; }
    pulling = true;
    const disc = document.createElement('span');
    disc.className = 'pull-disc';
    disc.innerHTML = `<i style="background-image:${esc(it.cover ? coverCss(it.cover) : placeholder(it.id))}"></i>`;
    rec.prepend(disc); rec.classList.add('pulling');
    setTimeout(() => {
      closePanel($('library'));
      toast(`Putting on “${it.name}”`, 2200);
      setTimeout(() => { rec.classList.remove('pulling'); disc.remove(); pulling = false; }, 450);
    }, 950);
  });
  new ResizeObserver(() => { if (wallOpen() && wallLayout().cols !== wallCols) renderWall(); }).observe($('wallScroll'));

  // ================================================================ settings dialog
  const dialog = $('setup');
  function updateDialog() {
    const connected = state.mode === 'spotify';
    $('redirectUri').textContent = REDIRECT_URI;
    $('clientId').value = store.get(LS.client) || '';
    $('logoutBtn').classList.toggle('hidden', !connected);
    $('connectBtn').textContent = connected ? 'Reconnect' : 'Connect Spotify';
    $('demoBtn').classList.toggle('hidden', state.mode === 'demo');
    $('spotifyStatus').textContent = connected ? 'Connected.' : state.mode === 'demo' ? 'Not connected — you’re in demo mode.' : 'Not connected.';
    $('setupSteps').open = !connected;
    let msg = '';
    if (location.hostname === 'localhost') msg = 'Spotify no longer accepts "localhost". Open this page at http://127.0.0.1 instead.';
    else if (location.protocol === 'file:') msg = 'Opened as a file — run a local server or host it (see README).';
    else if (location.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(location.hostname))
      msg = 'Spotify needs https:// for addresses other than 127.0.0.1. Host this page (e.g. GitHub Pages) to use it on your phone.';
    $('uriWarn').textContent = msg; $('uriWarn').classList.toggle('hidden', !msg);
  }
  function openSetup() { updateDialog(); if (!dialog.open) dialog.showModal(); }

  $('settingsBtn').onclick = openSetup;
  $('closeBtn').onclick = () => dialog.close();
  $('connectBtn').onclick = login;
  $('demoBtn').onclick = () => { dialog.close(); startDemo(); };
  $('logoutBtn').onclick = () => { logout(false); toast('Disconnected'); };
  $('copyUri').onclick = async () => {
    try { await navigator.clipboard.writeText(REDIRECT_URI); toast('Redirect URI copied'); } catch { toast('Copy failed — select it manually'); }
  };
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  // turntable finishes
  function setFinish(id) {
    document.documentElement.dataset.finish = id; store.set(LS.finish, id);
    document.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s.dataset.finish === id)));
  }
  $('swatches').innerHTML = FINISHES.map(([id, name]) =>
    `<button class="swatch" role="radio" data-finish="${id}" aria-checked="false"><i></i>${name}</button>`).join('');
  $('swatches').setAttribute('role', 'radiogroup');
  $('swatches').addEventListener('click', (e) => { const s = e.target.closest('.swatch'); if (s) setFinish(s.dataset.finish); });
  setFinish(FINISHES.some(([id]) => id === store.get(LS.finish)) ? store.get(LS.finish) : 'walnut');

  // ================================================================ idle mode, keyboard, fullscreen, wake lock
  let idleTimer, pinnedIdle = false;
  function wake() {
    if (pinnedIdle) return;
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (state.isPlaying && !dialog.open && !document.querySelector('.panel.open') && !seekDrag.active) document.body.classList.add('idle');
    }, 6000);
  }
  ['mousemove', 'pointerdown', 'keydown', 'wheel'].forEach((ev) => addEventListener(ev, wake, { passive: true }));
  wake();

  let lastTap = 0;
  $('turntable').addEventListener('pointerup', () => {
    const now = Date.now();
    if (armDrag.active || now - armDrag.endedAt < 400) return;
    if (now - lastTap < 320) {
      pinnedIdle = !pinnedIdle;
      document.body.classList.toggle('idle', pinnedIdle);
      if (!pinnedIdle) wake();
      lastTap = 0;
    } else lastTap = now;
  });

  addEventListener('keydown', (e) => {
    if (dialog.open || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === 'Escape' && e.target.id === 'libSearch') closePanel($('library'));
      return;
    }
    if (e.key === '/' && wallOpen()) { e.preventDefault(); $('libSearch').focus(); return; }
    if (e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') skip(1);
    else if (e.key === 'ArrowLeft') skip(-1);
    else if (e.key === 'f') toggleFullscreen();
    else if (e.key === 'c') $('crackleBtn').click();
    else if (e.key === 'l') $('libraryBtn').click();
    else if (e.key === 'v') $('vinylBtn').click();
    else if (e.key === 't' && document.body.classList.contains('has-album') && !isDocked()) $('tracklistBtn').click();
    else if (e.key === 'Escape') document.querySelectorAll('.panel.open').forEach(closePanel);
  });

  const fsSupported = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  if (!fsSupported) $('fsBtn').classList.add('hidden');
  function toggleFullscreen() {
    if (!fsSupported) return;
    const el = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  }
  $('fsBtn').onclick = toggleFullscreen;

  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock && !document.hidden) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { requestWakeLock(); if (state.mode === 'spotify') poll(); }
  });
  addEventListener('pointerdown', requestWakeLock, { once: true });

  // ================================================================ the room: fill shelves with records
  (function buildRoom() {
    const R = rng(42);
    const palette = ['#7a3b2e', '#c0874f', '#2f4a3e', '#d9c7a5', '#5b6b8a', '#8a4f63', '#3b3a36', '#b5643c', '#6f7d5a', '#e2b65f', '#1f2b38', '#9c8e7a', '#4a2f2a', '#c9a99a', '#efe6d6'];
    const NS = 'http://www.w3.org/2000/svg';
    function spines(g, x0, x1, base, hMin, hMax, skip) {
      let x = x0;
      while (x < x1) {
        if (skip && x + 18 > skip[0] && x < skip[1]) { x = skip[1] + 4; continue; }
        const w = 7 + R() * 10; if (x + w > x1) break;
        const h = hMin + R() * (hMax - hMin);
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', x.toFixed(1)); r.setAttribute('y', (base - h).toFixed(1));
        r.setAttribute('width', w.toFixed(1)); r.setAttribute('height', h.toFixed(1));
        r.setAttribute('fill', palette[Math.floor(R() * palette.length)]);
        g.append(r);
        if (R() < .7) {
          const band = document.createElementNS(NS, 'rect');
          band.setAttribute('x', x.toFixed(1)); band.setAttribute('y', (base - h * (.75 + R() * .1)).toFixed(1));
          band.setAttribute('width', w.toFixed(1)); band.setAttribute('height', (h * .08).toFixed(1));
          band.setAttribute('fill', 'rgba(255,255,255,.22)');
          g.append(band);
        }
        x += w + (R() < .08 ? 14 + R() * 30 : 1);
      }
    }
    spines($('shelfA'), 520, 1060, 330, 118, 160, [728, 896]);
    spines($('shelfB'), 520, 1060, 560, 150, 175);
    [210, 510, 810, 1110].forEach((x) => spines($('cubbies'), x + 6, x + 274, 936, 112, 138));
  })();

  // ================================================================ boot
  renderGrooves();
  requestAnimationFrame(frame);
  (async () => {
    const justLoggedIn = await handleRedirect();
    const params = new URLSearchParams(location.search);
    if (justLoggedIn || getTokens()) {
      state.mode = 'spotify'; store.set(LS.mode, 'spotify');
      onTrackChange();
      startPolling();
      if (justLoggedIn) toast('Connected to Spotify');
    } else if (store.get(LS.mode) === 'demo' || params.has('demo')) {
      startDemo();
    } else {
      onTrackChange();
      openSetup();
    }
  })();
})();
