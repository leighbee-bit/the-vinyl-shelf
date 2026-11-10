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
    finish: 'tt.finish', crackle: 'tt.crackle', vol: 'tt.crackleVol', flip: 'tt.flip',
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
    if (tl.mode === 'queue' && (track && track.id) !== prevId) refreshQueue();
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
  function setRoomCover(url) {      // every scene has the playing record somewhere in it
    document.querySelectorAll('.room-cover').forEach((img) => { if (url) img.setAttribute('href', url); else img.removeAttribute('href'); });
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
    state.sides = state.album ? splitSides(state.album.tracks, state.cum, state.albumTotal) : null;
    state.sidesFrom = null;
    cancelFlip();
    document.body.classList.toggle('has-album', !!state.album);
    if (!state.album) closePanel($('tracklist'));
    renderTracklist();
    refreshAlbumMatch(true);
    onAlbumForVinyl(state.album);
  }

  // ---------------------------------------------------------------- sides: an LP holds ~20 minutes a side
  // Spotify doesn't know where the sides break, so split by running time into 2 sides (4 for a double LP…),
  // keeping whole songs together and the sides as even as possible.
  function splitSides(tracks, cum, total) {
    if (tracks.length < 4) return null;
    const n = Math.min(8, Math.max(2, 2 * Math.ceil(total / (2 * 26 * 60e3))), tracks.length);
    const sides = []; let start = 0;
    for (let k = 1; k <= n; k++) {
      let end = tracks.length;
      if (k < n) {
        const target = total * k / n;
        end = start + 1;
        while (end < tracks.length - (n - k) && Math.abs(cum[end + 1] - target) < Math.abs(cum[end] - target)) end++;
      }
      const base = cum[start], stop = end < tracks.length ? cum[end] : total;
      sides.push({ start, end, base, total: stop - base, letter: String.fromCharCode(65 + k - 1) });
      start = end;
    }
    return sides;
  }
  // swap the running-time guess for the real vinyl sides once MusicBrainz answers
  function applyRealSides(a, sides) {
    if (!sides || !state.album || state.album.id !== a.id || sides.groups.length !== a.tracks.length) return;
    const out = [], g = sides.groups;
    for (let i = 0; i < g.length; i++) {
      if (i && g[i] === g[i - 1]) continue;
      let end = i; while (end < g.length && g[end] === g[i]) end++;
      const base = state.cum[i], stop = end < g.length ? state.cum[end] : state.albumTotal;
      out.push({ start: i, end, base, total: stop - base, letter: String.fromCharCode(65 + out.length) });
    }
    state.sides = out; state.sidesFrom = sides.from;
    refreshAlbumMatch(true);
  }
  const sideIndexOf = (i) => (state.sides ? Math.max(0, state.sides.findIndex((sd) => i >= sd.start && i < sd.end)) : 0);
  // the part of the album the needle travels across right now: the current side, or the whole album
  function needleSpan() {
    if (state.sides && state.trackIndex >= 0) return state.sides[sideIndexOf(state.trackIndex)];
    return { start: 0, end: state.album ? state.album.tracks.length : 0, base: 0, total: state.albumTotal, letter: '' };
  }

  // ---------------------------------------------------------------- flipping the record between sides
  const flip = { pending: null, userNavAt: 0 };
  const flipOn = () => store.get(LS.flip) !== '0';
  const noteUserNav = () => { flip.userNavAt = performance.now(); };
  function sideDone(nextIndex) {
    const a = state.album, sd = state.sides[sideIndexOf(nextIndex)];
    flip.pending = { albumId: a.id, nextIndex, letter: sd.letter, from: state.sides[sideIndexOf(nextIndex) - 1].letter };
    if (state.isPlaying) togglePlay();
    state.armParked = true;
    $('flipText').innerHTML = `Side ${flip.pending.from} is over · <b>Flip to Side ${sd.letter}</b>`;
    $('flipBtn').classList.add('show');
  }
  function cancelFlip() {
    if (!flip.pending) return;
    flip.pending = null;
    $('flipBtn').classList.remove('show');
  }
  function flipSide() {
    const f = flip.pending, a = state.album;
    if (!f || !a || a.id !== f.albumId) { cancelFlip(); return; }
    cancelFlip();
    const platter = document.querySelector('.platter');
    platter.classList.remove('flipping'); void platter.offsetWidth; platter.classList.add('flipping');
    $('label').dataset.side = f.letter;
    noteUserNav();
    setTimeout(() => {
      state.armParked = false;
      source().play({ contextUri: a.uri, offsetIndex: f.nextIndex });
    }, 900);
    setTimeout(() => platter.classList.remove('flipping'), 1300);
  }
  // stop just before the last song of a side runs out. A timer, not the animation loop, so it still
  // works when this tab is in the background (browsers slow timers there to ~1/s, hence the 1.5s margin).
  function watchSideEnd() {
    if (!flipOn() || flip.pending || !state.albumMode || !state.sides || !state.isPlaying || seekDrag.active || armDrag.active) return;
    const si = sideIndexOf(state.trackIndex), sd = state.sides[si];
    if (si >= state.sides.length - 1 || state.trackIndex !== sd.end - 1) return;
    const dur = state.track.durationMs;
    if (dur && dur - currentProgress() < 1500) sideDone(sd.end);
  }
  setInterval(watchSideEnd, 250);

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
    const prevIdx = state.trackIndex;
    state.trackIndex = idx; state.albumMode = albumMode;
    if (flip.pending && ((idx !== flip.pending.nextIndex - 1 && idx !== flip.pending.nextIndex) || !albumMode)) cancelFlip();
    // Spotify slipped onto the next side before we could pause: stop at the top of it and offer the flip
    if (albumMode && state.sides && flipOn() && !flip.pending && idx > 0 && prevIdx === idx - 1 && state.isPlaying
        && sideIndexOf(idx) !== sideIndexOf(prevIdx) && performance.now() - flip.userNavAt > 5000 && currentProgress() < 15000) {
      sideDone(idx);
      seekTo(0);
    }
    $('label').dataset.side = albumMode && state.sides ? state.sides[sideIndexOf(idx)].letter : '';
    renderGrooves(); renderAlbumBar(); highlightTracklist(); renderUpNext();
  }

  // groove gaps on the record line up with the real track breaks when an album is playing
  function renderGrooves() {
    let fracs = [.21, .43, .63, .82];
    if (state.albumMode) { const sp = needleSpan(); fracs = state.cum.slice(sp.start + 1, sp.end).map((c) => (c - sp.base) / sp.total); }
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
      seg.className = 'seg' + (i < state.trackIndex ? ' done' : '') + (i === state.trackIndex ? ' current' : '')
        + (state.sides && i > 0 && state.sides.some((sd) => sd.start === i) ? ' side-start' : '');
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
    if (tl.mode === 'queue') return;
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
    if (tl.mode === 'queue') source().skipAhead(Number(b.dataset.i));
    else playAlbumTrack(Number(b.dataset.i));
  });
  function playAlbumTrack(i) {
    const a = state.album; if (!a) return;
    noteUserNav(); cancelFlip();
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
      const sp = state.albumMode ? needleSpan() : null;
      const f = sp ? (state.cum[state.trackIndex] - sp.base + prog) / sp.total : (dur ? prog / dur : 0);
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
        const side = state.sides ? `Side <b>${state.sides[sideIndexOf(state.trackIndex)].letter}</b> · ` : '';
        $('albumLabel').innerHTML = `<span>${side}Track <b>${state.trackIndex + 1}</b> of ${state.album.tracks.length}</span><span>${fmt(el)} / ${fmt(state.albumTotal)}</span>`;
      }
    }

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
    if (!wasPlaying && flip.pending) { flipSide(); return; }
    if (!state.track && state.mode === 'demo') { Demo.play({ contextUri: Demo.albums[0].uri }); return; }
    state.progressMs = currentProgress(); state.syncedAt = performance.now();
    state.isPlaying = !wasPlaying && !!state.track; setPlayIcon();
    if (state.mode === 'spotify') playerCall('PUT', wasPlaying ? '/me/player/pause' : '/me/player/play');
  }
  function skip(dir) {
    if (state.mode === 'idle') { openSetup(); return; }
    noteUserNav(); cancelFlip();
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
      const sp = needleSpan(), el = sp.base + frac * sp.total;
      let i = sp.start; while (i < sp.end - 1 && state.cum[i + 1] <= el) i++;
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
    noteUserNav(); cancelFlip();
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
      this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, target > 0 ? .3 : .06);   // ease in, cut quickly
    },
  };
  // a song is sounding: Spotify says playing, and we're not past its end (the next poll may not have landed yet)
  const soundingNow = () => state.isPlaying && !!state.track && !flip.pending
    && (!state.track.durationMs || state.track.durationMs < 2 || currentProgress() < state.track.durationMs + 1500);
  // a timer, not the animation loop, drives the crackle: browsers pause animation in background tabs and
  // covered windows, which used to leave the crackle running after Spotify stopped
  setInterval(() => crackle.update(soundingNow() ? 1 : 0), 250);
  $('crackleBtn').onclick = () => { crackle.setEnabled(!crackle.enabled); toast(crackle.enabled ? 'Crackle on' : 'Crackle off', 1500); };
  $('crackleToggle').onchange = (e) => crackle.setEnabled(e.target.checked);
  $('flipToggle').checked = flipOn();
  $('flipToggle').onchange = (e) => { store.set(LS.flip, e.target.checked ? '1' : '0'); if (!e.target.checked) cancelFlip(); };
  $('flipBtn').onclick = flipSide;
  $('crackleVol').value = String(crackle.volume);
  $('crackleVol').oninput = (e) => crackle.setVolume(Number(e.target.value));
  crackle.setEnabled(crackle.enabled);
  // Browsers only allow sound after someone clicks, taps or presses a key on the page, so a fresh window can't
  // start the crackle by itself. Start it on the first interaction of any kind (mouse, touch, keyboard, TV remote),
  // and while it's waiting on music that's playing, show a small "tap to start the crackle" button.
  const crackleWaiting = () => crackle.enabled && (!crackle.ctx || crackle.ctx.state !== 'running');
  function unlockCrackle() {
    if (!crackleWaiting()) return;
    crackle.ensure();
    if (crackle.ctx) crackle.ctx.resume().then(renderCrackleHint, () => {});
  }
  ['pointerdown', 'pointerup', 'touchend', 'keydown'].forEach((ev) => addEventListener(ev, unlockCrackle, { capture: true, passive: true }));
  function renderCrackleHint() {
    const show = crackleWaiting() && soundingNow() && !document.hidden;
    $('crackleHint').classList.toggle('show', show);
    $('crackleHint').tabIndex = show ? 0 : -1;
  }
  $('crackleHint').textContent = matchMedia('(hover: none)').matches ? 'Tap to start the crackle' : new URLSearchParams(location.search).has('tv') ? 'Press any key to start the crackle' : 'Click to start the crackle';
  $('crackleHint').onclick = unlockCrackle;
  setInterval(renderCrackleHint, 500);
  crackle.ctx && crackle.ctx.resume().catch(() => {}); // some browsers allow it straight away (e.g. a site you use a lot)

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
          return { id: a.id, uri: a.uri, name: a.name, sub: (a.artists || []).map((r) => r.name).join(', '), cover: url ? { url } : null, type: a.album_type, n: a.total_tracks };
        }
        const total = x.items?.total ?? x.tracks?.total;           // `tracks` was renamed `items` in Feb 2026
        const url = pickImage(x.images, 300);
        return { id: x.id, uri: x.uri, name: x.name, sub: [x.owner?.display_name, total != null ? `${total} songs` : ''].filter(Boolean).join(' · '), cover: url ? { url } : null };
      }).filter((it) => it.uri);
      return { items, next: data.next };
    },
    // header for the queue view: the playlist's name, owner and cover (works for any playlist)
    async playlistInfo(uri) {
      const id = uri.split(':').pop();
      const p = await getJSON(`/playlists/${encodeURIComponent(id)}?fields=name,images,owner(display_name)`);
      const img = pickImage(p.images, 300);
      return { name: p.name, owner: p.owner?.display_name || '', cover: img ? { url: img } : null };
    },
    // Spotify's live queue: what's playing plus what comes next (shuffle, songs you queued, etc.)
    async queue() {
      const q = await getJSON('/me/player/queue');
      const map = (t) => ({ id: t.id || t.uri, uri: t.uri, name: t.name, artist: (t.artists || []).map((a) => a.name).join(', ') || t.show?.name || '', durationMs: t.duration_ms || 0 });
      return { now: q.currently_playing ? map(q.currently_playing) : null, next: (q.queue || []).filter((t) => t && t.uri).map(map) };
    },
    // Spotify has no "jump to queue item" call, so skip forward n times (like tapping next)
    async skipAhead(n) {
      for (let i = 0; i < n; i++) { if (!(await playerCall('POST', '/me/player/next'))) return; }
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
    // in a background tab we only keep asking while the crackle is on, so it can stop when Spotify stops
    if (state.mode !== 'spotify' || (document.hidden && !crackle.enabled) || Date.now() < backoffUntil || seekDrag.active) return;
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
          ? albums.map((a) => ({ id: a.id, uri: a.uri, name: a.name, sub: a.artist, cover: a.cover, type: a.type || 'album', n: a.tracks.length }))
          : playlists.map((p) => ({ id: p.id, uri: p.uri, name: p.name, sub: `Demo playlist · ${p.refs.length} songs`, cover: albums[p.refs[0][0]].cover })),
      }),
      contextName: async (uri) => (playlists.find((p) => p.uri === uri) || {}).name,
      async playlistInfo(uri) {
        const p = playlists.find((x) => x.uri === uri);
        return { name: p.name, owner: 'Demo', cover: albums[p.refs[0][0]].cover };
      },
      async queue() {
        const row = ({ a, t }) => ({ id: t.id, uri: t.uri, name: t.name, artist: a.artist, durationMs: t.durationMs });
        if (!queue.length) return { now: null, next: [] };
        const next = [];
        for (let i = 1; i < Math.min(queue.length, 20); i++) next.push(row(queue[(qi + i) % queue.length]));
        return { now: row(queue[qi]), next };
      },
      async skipAhead(n) { for (let i = 0; i < n; i++) this.step(1); },
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
        const sides = a.id === 'a0' ? { groups: [0, 0, 0, 1, 1, 1, 1], from: '2024 US' } : null;     // real side breaks for one demo record
        return { found: a.id !== 'a6', demo: true, pressings, discogsMaster: null, shops: [], sides };
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
      // real side breaks: a vinyl pressing with the same number of songs as Spotify's album, whose tracklist
      // positions say which side each song is on ("A1", "B3", "ONE 2"…)
      let sides = null;
      const want = (album.tracks || []).length;
      const count = (r) => (r.media || []).reduce((n, m) => n + (m['track-count'] || 0), 0);
      const cands = vinyl.filter((r) => want >= 4 && count(r) === want)
        .sort((a, b) => (a.status === 'Official' ? 0 : 1) - (b.status === 'Official' ? 0 : 1) || String(a.date || '9').localeCompare(String(b.date || '9')))
        .slice(0, 3);
      for (const r of cands) {
        try {
          const full = await get(`release/${r.id}?inc=recordings`);
          const keys = (full.media || []).flatMap((m) => (m.tracks || []).map((t) => String(t.number || '').trim().replace(/[\s.\-]*\d+$/, '').toUpperCase()));
          if (keys.length !== want || keys.some((k) => !k)) continue;          // plain 1, 2, 3… says nothing about sides
          const groups = []; let g = -1, prev = null, seen = new Set(), ok = true;
          for (const k of keys) { if (k !== prev) { if (seen.has(k)) { ok = false; break; } seen.add(k); g++; prev = k; } groups.push(g); }
          if (!ok || g < 1) continue;
          sides = { groups, from: [r.date ? r.date.slice(0, 4) : '', r.country === 'XW' || r.country === 'XE' ? '' : r.country || ''].filter(Boolean).join(' ') || 'a' };
          break;
        } catch {}
      }
      return {
        found: true, mbUrl: `https://musicbrainz.org/release-group/${rgId}`, sides, sidesChecked: want >= 4,
        discogsMaster: (rels(rg).find((x) => x.type === 'discogs') || {}).url?.resource || null,
        pressings: sortPressings(pressings),
        shops: [...shops].map(([url, type]) => ({ url, type })),
      };
    }
    return { lookup };
  })();

  Spotify.vinyl = async (album) => {
    const key = `tt.mb2.${album.id}`;     // v2: also stores side breaks
    const needSides = (album.tracks || []).length >= 4;
    try { const c = JSON.parse(store.get(key) || 'null'); if (c && Date.now() - c.at < 7 * 864e5 && (c.data.sidesChecked || !c.data.found || !needSides)) return c.data; } catch {}
    const data = await MB.lookup(album);
    store.set(key, JSON.stringify({ at: Date.now(), data }));
    return data;
  };

  // ================================================================ your collection: full-album spins + Discogs
  // "Full spin": you heard at least 80% of an album's songs (each past its halfway point) within a 6-hour window.
  const Spins = (() => {
    const SESSION = 6 * 3600e3;
    let cache = null, cacheKey = null;
    const DEMO_SEED = { a1: 4, a4: 3, a2: 2, a0: 1 };
    function load() {
      const k = state.mode === 'demo' ? 'tt.spins.demo' : 'tt.spins';
      if (cacheKey === k) return cache;
      try { cache = JSON.parse(store.get(k) || 'null'); } catch { cache = null; }
      cacheKey = k;
      if (!cache) {
        cache = {};
        if (state.mode === 'demo') for (const [id, n] of Object.entries(DEMO_SEED)) {
          const a = Demo.albums.find((x) => x.id === id);
          cache[id] = { spins: n, heard: {}, last: Date.now() - n * 864e5, name: a.name, artist: a.artist, cover: a.cover, uri: a.uri, year: a.year || '', n: a.tracks.length };
        }
      }
      return cache;
    }
    const save = () => store.set(cacheKey, JSON.stringify(cache));
    function check() {
      const t = state.track, a = state.album;
      if (!t || !a || !state.isPlaying || !(state.trackIndex >= 0) || a.tracks.length < 4) return;   // singles & short EPs don't count
      if (currentProgress() < Math.min(t.durationMs * .5, 240e3)) return;
      const all = load(), now = Date.now();
      const r = all[a.id] || (all[a.id] = { spins: 0, heard: {} });
      Object.assign(r, { name: a.name, artist: a.artist, cover: a.cover || null, uri: a.uri, year: a.year || '', upc: a.upc || null, n: a.tracks.length });
      const tid = a.tracks[state.trackIndex].id;
      if (r.heard[tid]) return;
      for (const k in r.heard) if (now - r.heard[k] > SESSION) delete r.heard[k];
      r.heard[tid] = now;
      if (Object.keys(r.heard).length >= Math.ceil(a.tracks.length * .8)) {
        r.spins++; r.last = now; r.heard = {};
        save(); onFullSpin(a, r);
      } else save();
    }
    return { check, all: load, get: (id) => load()[id] || null };
  })();
  setInterval(Spins.check, 2000);

  const nth = (n) => `${n}${[, 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1) && n % 10] || 'th'}`;
  function onFullSpin(a, r) {
    const own = Discogs.match(a);
    const times = r.spins === 1 ? 'first full spin' : `${nth(r.spins)} full spin`;
    toast(own.owned || r.spins < 2 ? `“${a.name}” · your ${times}. Press N to jot a note` : `“${a.name}” · your ${times}. Worth owning? Press V for pressings`, 5000);
    renderVinyl();
    if (wallOpen() && lib.tab === 'vinyl') renderWall();
  }

  // Discogs: your vinyl collection and wantlist. Public collections need only a username;
  // private ones need a personal access token (kept in this browser, sent only to api.discogs.com).
  const Discogs = (() => {
    const CFG = 'tt.discogs', DATA = 'tt.discogsData';
    const read = (k) => { try { return JSON.parse(store.get(k) || 'null'); } catch { return null; } };
    let data = read(DATA), index = null, syncing = false;
    const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    const normArtist = (s) => fold(String(s || '').split(', ')[0].replace(/\s*\(\d+\)$/, '').replace(/\*$/, ''))
      .replace(/^the\s+/, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
    const normTitle = (s) => fold(s).replace(/\s*[(\[][^)\]]*(remaster|deluxe|edition|version|anniversary|expanded|bonus|mono|stereo|reissue)[^)\]]*[)\]]/g, '')
      .replace(/\s+-\s+.*(remaster|edition|version).*$/, '').replace(/^the\s+/, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
    const keyOf = (artist, title) => `${normArtist(artist)}|${normTitle(title)}`;

    const DEMO = (() => {
      const it = (id, title, artist, year, cover) => ({ id, title, artist, year, cover, fmt: 'LP, Album' });
      const A = (i) => Demo.albums[i];
      return {
        user: 'demo', at: Date.now(),
        owned: [it(1, A(0).name, A(0).artist, 2024, A(0).cover), it(2, A(3).name, A(3).artist, 2022, A(3).cover),
          it(3, 'Coastline Hymns', 'Willa Grey', 2019, { gradient: 'linear-gradient(150deg,#d9c39a,#6f8f8a 60%,#2d3e44)' })],
        wants: [it(4, A(4).name, A(4).artist, 2021, A(4).cover), it(5, 'Paper Weather', 'The Low Fields', 2018, { gradient: 'linear-gradient(150deg,#e3b3a0,#8e5a6a 60%,#3b2433)' })],
      };
    })();
    const current = () => (state.mode === 'demo' ? DEMO : data);
    let indexFor = null;
    function getIndex() {
      const d = current();
      if (indexFor === d && index) return index;
      index = new Map(); indexFor = d;
      if (!d) return index;
      for (const [list, flag] of [[d.owned, 'owned'], [d.wants, 'wanted']]) for (const r of list || []) {
        const k = keyOf(r.artist, r.title), e = index.get(k) || {};
        if (!e[flag]) e[flag] = r;
        index.set(k, e);
      }
      return index;
    }
    function match(a) {
      if (!a) return {};
      return getIndex().get(keyOf(a.artist || a.sub, a.name)) || {};
    }

    async function get(url, token, tries = 3) {
      const res = await fetch(url, { headers: token ? { Authorization: `Discogs token=${token}` } : {} });
      if (res.status === 429 && tries > 0) { await new Promise((r) => setTimeout(r, 4000)); return get(url, token, tries - 1); }
      if (!res.ok) { const e = new Error(`Discogs ${res.status}`); e.status = res.status; throw e; }
      return res.json();
    }
    const mapItem = (r) => {
      const b = r.basic_information || {};
      const cover = b.cover_image && !/spacer\.gif/.test(b.cover_image) ? { url: b.cover_image } : null;
      return {
        id: b.id, master: b.master_id || null, title: b.title || '', year: b.year || '',
        artist: (b.artists || []).map((x) => x.name.replace(/\s*\(\d+\)$/, '').replace(/\*$/, '')).join(', '),
        cover, fmt: (b.formats || []).map((f) => [f.name, ...(f.descriptions || [])].join(', ')).join(' + '),
        vinyl: (b.formats || []).some((f) => /vinyl/i.test(f.name || '')),
      };
    };
    async function pages(path, field, token, onPage) {
      const out = [];
      let url = `https://api.discogs.com${path}${path.includes('?') ? '&' : '?'}per_page=100`;
      for (let p = 0; url && p < 60; p++) {
        if (p && !token) await new Promise((r) => setTimeout(r, 1100));   // 25 requests/minute without a token
        const d = await get(url, token);
        out.push(...(d[field] || []).map(mapItem));
        onPage && onPage(out.length, d.pagination && d.pagination.items);
        url = d.pagination && d.pagination.urls && d.pagination.urls.next;
      }
      return out;
    }
    async function sync({ quiet = false } = {}) {
      const cfg = read(CFG);
      if (!cfg || !cfg.user || syncing) return;
      syncing = true; renderDiscogsStatus(); if (wallOpen()) renderWall();
      const u = encodeURIComponent(cfg.user);
      try {
        const owned = await pages(`/users/${u}/collection/folders/0/releases?sort=added&sort_order=desc`, 'releases', cfg.token,
          (n, total) => renderDiscogsStatus(`Syncing… ${n}${total ? ` of ${total}` : ''} records`));
        let wants = [], wantsHidden = false;
        try { wants = await pages(`/users/${u}/wants`, 'wants', cfg.token); } catch (e) { if (e.status === 403 || e.status === 401) wantsHidden = true; else throw e; }
        data = { user: cfg.user, at: Date.now(), owned: owned.filter((r) => r.vinyl), wants: wants.filter((r) => r.vinyl), skipped: owned.length - owned.filter((r) => r.vinyl).length, wantsHidden };
        store.set(DATA, JSON.stringify(data));
        if (!quiet) toast(`Synced ${data.owned.length} records from Discogs`);
      } catch (e) {
        const why = e.status === 404 ? `Discogs doesn’t know the user “${cfg.user}”.`
          : e.status === 401 || e.status === 403 ? 'That Discogs collection is private. Add a personal access token in Settings.'
          : 'Couldn’t reach Discogs right now.';
        toast(why, 6000);
        if (data) data.error = why; else data = null;
        renderDiscogsStatus(why);
        syncing = false; if (wallOpen()) renderWall();
        return;
      }
      syncing = false;
      renderDiscogsStatus(); renderVinyl();
      if (wallOpen()) renderWall();
    }
    function setConfig(user, token) {
      user = (user || '').trim().replace(/^.*discogs\.com\/(user\/)?/i, '').replace(/\/.*$/, '');
      if (!user) { clear(); return false; }
      const prev = read(CFG) || {};
      store.set(CFG, JSON.stringify({ user, token: (token || '').trim() || null }));
      if (prev.user !== user) { data = null; store.del(DATA); }
      return true;
    }
    function clear() { store.del(CFG); store.del(DATA); data = null; renderDiscogsStatus(); renderVinyl(); if (wallOpen()) renderWall(); }
    return {
      match, sync, setConfig, clear, keyOf,
      config: () => read(CFG),
      data: current,
      isSyncing: () => syncing,
      connected: () => state.mode === 'demo' || !!read(CFG),
      maybeAutoSync() { const c = read(CFG); if (c && (!data || data.user !== c.user || Date.now() - data.at > 12 * 3600e3)) sync({ quiet: true }); },
    };
  })();

  // Last.fm: your listening history from before this app existed. Spotify can send every play to Last.fm
  // ("scrobbling"), so years of history are there. We read your top albums and estimate how many times
  // you've played each one through: album scrobbles ÷ songs on the album.
  const LastFm = (() => {
    const CFG = 'tt.lastfm', DATA = 'tt.lastfmData';
    const read = (k) => { try { return JSON.parse(store.get(k) || 'null'); } catch { return null; } };
    let data = read(DATA), busy = false, index = null, indexFor = null;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const DEMO = (() => {
      const A = (i) => Demo.albums[i];
      return {
        user: 'demo', at: Date.now(), albums: [
          { name: 'Glass Orchard', artist: 'Wren Hollis', plays: 108, tracks: 11, est: 9, cover: { gradient: 'linear-gradient(150deg,#cfe0b8,#7f9c6a 55%,#2f3f2a)' } },
          { name: A(5).name, artist: A(5).artist, plays: 54, tracks: A(5).tracks.length, est: Math.floor(54 / A(5).tracks.length), cover: A(5).cover },
          { name: 'Paper Weather', artist: 'The Low Fields', plays: 47, tracks: 9, est: 5, cover: { gradient: 'linear-gradient(150deg,#e3b3a0,#8e5a6a 60%,#3b2433)' } },
          { name: A(1).name, artist: A(1).artist, plays: 62, tracks: A(1).tracks.length, est: Math.floor(62 / A(1).tracks.length), cover: A(1).cover },
        ],
      };
    })();
    const current = () => (state.mode === 'demo' ? DEMO : data);
    function lookup(a) {
      const d = current(); if (!d || !a) return null;
      if (indexFor !== d) { index = new Map(d.albums.map((x) => [Discogs.keyOf(x.artist, x.name), x])); indexFor = d; }
      return index.get(Discogs.keyOf(a.artist || a.sub, a.name)) || null;
    }
    async function call(params, key) {
      const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${new URLSearchParams({ ...params, api_key: key, format: 'json' })}`);
      const j = await res.json().catch(() => ({}));
      if (j.error || !res.ok) { const e = new Error(j.message || `Last.fm ${res.status}`); e.code = j.error; throw e; }
      return j;
    }
    const bestImage = (imgs) => { const u = [...(imgs || [])].reverse().map((i) => i['#text']).find((u) => u && !/2a96cbd8b46e442fc41c2b86b821562f/.test(u)); return u ? { url: u } : null; };
    async function importHistory({ quiet = false } = {}) {
      const c = read(CFG);
      if (!c || !c.user || !c.key || busy) return;
      busy = true; renderLastFmStatus('Reading your top albums…');
      try {
        const top = await call({ method: 'user.gettopalbums', user: c.user, period: 'overall', limit: 150 }, c.key);
        const list = (top.topalbums?.album || []).filter((a) => Number(a.playcount) >= 8).slice(0, 120);
        const albums = [];
        for (let i = 0; i < list.length; i++) {
          const a = list[i], artist = a.artist?.name || '';
          let n = 0;
          try {
            const info = await call({ method: 'album.getinfo', artist, album: a.name, autocorrect: 1 }, c.key);
            const t = info.album?.tracks?.track; n = Array.isArray(t) ? t.length : t ? 1 : 0;
          } catch {}
          const plays = Number(a.playcount);
          albums.push({ name: a.name, artist, plays, tracks: n, est: n >= 4 ? Math.floor(plays / n) : 0, cover: bestImage(a.image) });
          if (i % 5 === 4) renderLastFmStatus(`Counting songs per album… ${i + 1} of ${list.length}`);
          await sleep(220);                          // stay well under Last.fm's rate limit
        }
        data = { user: c.user, at: Date.now(), albums };
        store.set(DATA, JSON.stringify(data));
        const n = albums.filter((x) => x.est >= 3).length;
        if (!quiet) toast(`Imported your Last.fm history — ${n} albums you’ve played through 3+ times`, 5000);
      } catch (e) {
        const why = e.code === 6 ? `Last.fm doesn’t know the user “${c.user}”.` : e.code === 10 || e.code === 26 ? 'That Last.fm API key isn’t valid.' : e.code === 17 ? 'That Last.fm profile hides its listening history.' : 'Couldn’t reach Last.fm right now.';
        busy = false; renderLastFmStatus(why); toast(why, 6000);
        return;
      }
      busy = false; renderLastFmStatus(); renderVinyl();
      if (wallOpen()) renderWall();
    }
    function setConfig(user, key) {
      user = (user || '').trim().replace(/^.*last\.fm\/user\//i, '').replace(/\/.*$/, ''); key = (key || '').trim();
      if (!user || !key) return false;
      const prev = read(CFG) || {};
      store.set(CFG, JSON.stringify({ user, key }));
      if (prev.user !== user) { data = null; store.del(DATA); }
      return true;
    }
    function clear() { store.del(CFG); store.del(DATA); data = null; renderLastFmStatus(); renderVinyl(); if (wallOpen()) renderWall(); }
    return {
      lookup, importHistory, setConfig, clear, data: current, config: () => read(CFG), isBusy: () => busy,
      maybeAutoImport() { const c = read(CFG); if (c && (!data || data.user !== c.user || Date.now() - data.at > 7 * 864e5)) importHistory({ quiet: true }); },
    };
  })();

  function renderLastFmStatus(msg) {
    const el = $('lastfmStatus'); if (!el) return;
    const c = LastFm.config(), d = LastFm.data();
    $('lastfmClear').classList.toggle('hidden', !c);
    $('lastfmImport').textContent = c ? 'Import again' : 'Import history';
    if (msg) { el.textContent = msg; return; }
    if (state.mode === 'demo') { el.textContent = 'Demo mode — showing made-up listening history.'; return; }
    if (!c) { el.textContent = 'Bring in years of listening so “Worth owning” is filled from day one.'; return; }
    if (!d) { el.textContent = `Connected as ${c.user}. Not imported yet.`; return; }
    const n = d.albums.filter((x) => x.est >= 3).length;
    el.textContent = `${d.albums.length} top albums from ${d.user} · ${n} played through 3+ times · imported ${new Date(d.at).toLocaleDateString()}`;
  }

  function renderDiscogsStatus(msg) {
    const el = $('discogsStatus'); if (!el) return;
    const c = Discogs.config(), d = Discogs.data();
    $('discogsClear').classList.toggle('hidden', !c);
    $('discogsSync').textContent = c ? 'Sync now' : 'Connect Discogs';
    if (msg) { el.textContent = msg; return; }
    if (state.mode === 'demo') { el.textContent = 'Demo mode — showing a made-up collection.'; return; }
    if (!c) { el.textContent = 'Add your Discogs username to see which records you own and what’s on your wishlist.'; return; }
    if (Discogs.isSyncing()) { el.textContent = 'Syncing…'; return; }
    if (!d) { el.textContent = `Connected as ${c.user}. Not synced yet.`; return; }
    const ago = Math.round((Date.now() - d.at) / 60e3);
    el.textContent = `${d.owned.length} records on your shelf · ${d.wantsHidden ? 'wishlist is private' : `${d.wants.length} on your wishlist`} · synced ${ago < 1 ? 'just now' : ago < 60 ? `${ago} min ago` : ago < 1440 ? `${Math.round(ago / 60)} h ago` : `${Math.round(ago / 1440)} d ago`}`
      + (d.skipped ? ` · ${d.skipped} CDs/tapes hidden` : '');
  }

  const vinyl = { albumId: null, status: 'idle', data: null, choice: -1, showAll: false, browse: null };
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
      applyRealSides(a, data.sides);
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
      ['Barnes & Noble', `https://www.barnesandnoble.com/search?q=${e(`${q} vinyl`)}`],
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

  // collection line at the top of the vinyl panel: owned / wishlist / spin count
  function ownHtml(a) {
    const own = Discogs.match(a), sp = Spins.get(a.id), bits = [];
    if (own.owned) bits.push(`<span class="own-tag owned">On your shelf</span>`);
    else if (own.wanted) bits.push(`<span class="own-tag wanted">On your wishlist</span>`);
    if (sp && sp.spins) bits.push(`<span class="own-spins">${sp.spins === 1 ? 'Played front to back once' : `Played front to back ${sp.spins} times`}</span>`);
    const lf = LastFm.lookup(a);
    if (lf && lf.est >= 1) bits.push(`<span class="own-spins">≈${lf.est} full plays on Last.fm (${lf.plays} scrobbles)</span>`);
    let h = bits.length ? `<div class="vp-own">${bits.join('')}</div>` : '';
    const wanted = own.wanted || (String(a.id).startsWith('dg:') && (((Discogs.data() || {}).wants) || []).find((w) => `dg:${w.id}` === a.id));
    const pr = wanted ? Prices.get(wanted.id) : null;
    if (pr && pr.cur) {
      const c = pr.cur;
      h += `<div class="vp-price${pr.drop ? ' drop' : ''}">${c.v != null
        ? `<b>${pr.drop ? 'Price drop · ' : ''}From ${Prices.money(c.v)}</b> on Discogs · ${c.n} for sale${pr.low != null && pr.low !== c.v ? ` · lowest we’d seen before: ${Prices.money(pr.low)}` : ''}`
        : `<b>None for sale</b> on Discogs right now`} ${link(`https://www.discogs.com/sell/release/${wanted.id}`, 'See listings')}</div>`;
    }
    const notes = Notes.forAlbum(a.id);
    if (notes.length) h += `<h4>Your notes</h4><ul class="notes">${notesHtml(notes, false)}</ul>`;
    return h;
  }

  function renderVinyl() {
    const a = state.album;
    // pill under the album name
    const ps0 = (vinyl.data && vinyl.data.pressings) || [];
    const chosen = vinyl.choice >= 0 ? ps0[vinyl.choice] : null;
    const own = a ? Discogs.match(a) : {};
    $('vinylDot').style.background = swatchBg(chosen && chosen.look, a && a.cover);
    $('vinylPillText').textContent = own.owned ? (chosen && chosen.look ? `On your shelf · ${pressName(chosen)}` : 'On your shelf · pressings')
      : own.wanted ? 'On your wishlist · where to buy'
      : chosen && chosen.look ? `${pressName(chosen)} · where to buy` : 'Vinyl & where to buy';
    $('vinylBtn').classList.toggle('owned', !!own.owned);
    $('vinylBtn').classList.toggle('hidden', !state.track || !a);
    $('noteBtn').classList.toggle('hidden', !state.track);
    $('shareBtn').classList.toggle('hidden', !state.track);
    if (typeof renderRatePill === 'function' && $('rateBtn')) try { renderRatePill(); } catch {}

    const b = vinyl.browse;                    // looking at a record from the wall, not the one playing
    const shown = b ? b.album : a;
    if (!shown) { $('vpBody').innerHTML = '<p class="vp-note">This one isn’t part of an album Spotify knows about, so there’s nothing to look up.</p>'; return; }
    $('vpCover').style.backgroundImage = shown.cover ? coverCss(shown.cover) : '';
    $('vpTitle').textContent = shown.name;
    $('vpSub').textContent = [shown.artist, shown.year].filter(Boolean).join(' · ');
    $('vpBody').innerHTML = ownHtml(shown) + (b ? '' : sidesHtml()) + vinylBodyHtml(shown, b || vinyl, !b);
    const more = $('vpMore'); if (more) more.onclick = () => { (b || vinyl).showAll = true; renderVinyl(); };
  }

  function sidesHtml() {
    if (!state.sides || !state.album) return '';
    const parts = state.sides.map((sd) => `<span><b>Side ${sd.letter}</b> ${sd.end - sd.start === 1 ? `song ${sd.start + 1}` : `songs ${sd.start + 1}–${sd.end}`} · ${fmt(sd.total)}</span>`).join('');
    const src = state.sidesFrom ? `From the ${state.sidesFrom === 'a' ? '' : `${esc(state.sidesFrom)} `}vinyl tracklist on MusicBrainz.` : 'Estimated from running times — no matching vinyl tracklist found yet.';
    return `<h4>Sides</h4><div class="vp-sides">${parts}</div><p class="vp-fine" style="margin-top:6px">${src}</p>`;
  }

  // pressings + where to buy. `interactive`: radio buttons choose what the turntable shows (only for the album playing)
  function vinylBodyHtml(a, v, interactive) {
    const ps = (v.data && v.data.pressings) || [];
    let h = '<h4>Pressings</h4>';
    if (v.status === 'loading') h += '<p class="vp-note">Flipping through the crates on MusicBrainz…</p>';
    else if (v.status === 'error') h += '<p class="vp-note">Couldn’t reach MusicBrainz right now, so pressings are unknown. The shop searches below still work.</p>';
    else if (!ps.length) {
      h += `<p class="vp-empty"><b>No vinyl pressing found.</b>${v.data && v.data.found
        ? 'MusicBrainz knows this release but lists no vinyl version — it may be digital-only.'
        : 'We couldn’t find this release on MusicBrainz.'} The shop searches below may still turn something up.</p>`;
    } else {
      const row = (val, checked, disc, title, meta, extra = '') => interactive
        ? `<label class="press"><input type="radio" name="press" value="${val}" ${checked ? 'checked' : ''}><span class="press-disc" style="background:${esc(disc)}"></span><span><b>${title}</b><small>${meta}</small></span>${extra}</label>`
        : `<div class="press"><span class="press-disc" style="background:${esc(disc)}"></span><span><b>${title}</b><small>${meta}</small></span>${extra}</div>`;
      if (interactive) h += row(-1, v.choice === -1, swatchBg(null), 'Classic black', 'How the turntable shows it by default');
      const list = v.showAll ? ps : ps.slice(0, 10);
      list.forEach((p, i) => {
        const meta = [p.date, p.country, [p.label, p.catno].filter(Boolean).join(' '), p.format].filter(Boolean).map(esc).join(' · ');
        const tag = p.look ? '<span class="tag">Special</span>' : '';
        h += row(i, v.choice === i, swatchBg(p.look, a.cover), esc(pressName(p)) + tag, meta, p.discogs ? link(discogsSell(p.discogs), 'Discogs') : '');
      });
      if (ps.length > list.length) h += `<button class="vp-more" id="vpMore">Show all ${ps.length} pressings</button>`;
    }

    h += '<h4>Where to buy</h4>';
    const direct = [];
    if (v.data && v.data.discogsMaster) direct.push(link(discogsSell(v.data.discogsMaster), '<span>Discogs marketplace</span><small>every pressing, new &amp; used</small>', 'vp-link'));
    else if (a.dgMaster) direct.push(link(`https://www.discogs.com/sell/list?master_id=${a.dgMaster}&format=Vinyl`, '<span>Discogs marketplace</span><small>every pressing, new &amp; used</small>', 'vp-link'));
    ((v.data && v.data.shops) || []).slice(0, 6).forEach((s) =>
      direct.push(link(s.url, `<span>${esc(hostOf(s.url))}</span><small>${s.type === 'amazon asin' ? 'exact listing' : 'listed on MusicBrainz'}</small>`, 'vp-link')));
    direct.push(localStoresLink());
    h += `<div class="vp-links">${direct.join('')}</div>`;
    h += `<div class="vp-sub">${direct.length ? 'Or search the shops' : 'Search the shops'}</div><div class="vp-shops">${
      storeSearches(a).map(([name, url]) => link(url, `${esc(name)}<small>Search for this record</small>`)).join('')}</div>`;
    h += `<p class="vp-fine">Shop links open a search — stock and prices aren’t checked.${v.data && v.data.demo
      ? ' Pressings here are demo data.'
      : ` Pressing info from ${link(v.data && v.data.mbUrl || 'https://musicbrainz.org', 'MusicBrainz')}, a community-run music database.`}</p>`;
    return h;
  }

  // ================================================================ listening notes (a diary of what you spun)
  const Notes = (() => {
    const key = () => (state.mode === 'demo' ? 'tt.notes.demo' : 'tt.notes');
    function all() {
      let list = null;
      try { list = JSON.parse(store.get(key()) || 'null'); } catch {}
      if (!list && state.mode === 'demo') {
        const a = Demo.albums[1];
        list = [{ id: 'n0', albumId: a.id, name: a.name, artist: a.artist, cover: a.cover, track: a.tracks[2].name, at: Date.now() - 3 * 864e5,
          text: 'Late drive home, windows down. Side B is the whole point of this record.' }];
      }
      return list || [];
    }
    const save = (list) => store.set(key(), JSON.stringify(list.slice(0, 500)));
    return {
      all,
      forAlbum: (id) => all().filter((n) => n.albumId === id),
      add(n) { const list = all(); list.unshift({ id: `n${Date.now().toString(36)}`, at: Date.now(), ...n }); save(list); },
      remove(id) { save(all().filter((n) => n.id !== id)); },
    };
  })();
  const noteDate = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

  function openNote() {
    const a = state.album, t = state.track;
    if (!t) return;
    $('noteCover').style.background = a && a.cover ? `${coverCss(a.cover)} center/cover` : placeholder(t.albumName || t.name);
    $('noteAlbum').textContent = a ? a.name : (t.albumName || t.name);
    $('noteWhen').textContent = `${noteDate(Date.now())} · while “${t.name}” played`;
    $('noteText').value = '';
    $('noteDlg').showModal();
    setTimeout(() => $('noteText').focus(), 30);
  }
  $('noteBtn').onclick = openNote;
  $('noteSave').addEventListener('click', (e) => {
    e.preventDefault();
    const text = $('noteText').value.trim(), t = state.track, a = state.album;
    $('noteDlg').close();
    if (!text || !t) return;
    Notes.add({ albumId: a ? a.id : t.albumId || t.id, name: a ? a.name : (t.albumName || t.name), artist: a ? a.artist : t.artist, cover: a ? a.cover : t.cover, track: t.name, text });
    toast('Note saved to your listening diary');
    renderVinyl();
    if (wallOpen() && lib.tab === 'vinyl') renderWall();
  });
  $('noteText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('noteSave').click(); } });
  const notesHtml = (list, withAlbum) => list.map((n) => `<li class="note" data-note="${esc(n.id)}">
      ${withAlbum ? `<span class="note-cover" style="background:${esc(n.cover ? `${coverCss(n.cover)} center/cover` : placeholder(n.albumId))}"></span>` : ''}
      <div><div class="note-meta">${withAlbum ? `<b>${esc(n.name)}</b> · ` : ''}${esc(noteDate(n.at))}${n.track ? ` · “${esc(n.track)}”` : ''}</div>
      <p>${esc(n.text)}</p></div>
      <button class="note-del" data-del-note="${esc(n.id)}" aria-label="Delete note" title="Delete note">×</button></li>`).join('');
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-del-note]'); if (!b) return;
    e.stopPropagation();
    Notes.remove(b.dataset.delNote);
    renderVinyl();
    if (wallOpen()) renderWall();
  });

  // ================================================================ price watch: your Discogs wishlist
  // Discogs shares the lowest current price and how many copies are listed, but not a "usual" price,
  // so we keep our own history and flag a drop when it's cheaper than anything we've seen before.
  const Prices = (() => {
    const KEY = 'tt.prices';
    const CURRENCIES = { GB: 'GBP', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', FI: 'EUR', CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', CH: 'CHF', SE: 'SEK', MX: 'MXN', BR: 'BRL', ZA: 'ZAR' };
    const region = (navigator.language || 'en-US').split('-')[1] || '';
    const currency = CURRENCIES[region.toUpperCase()] || (/^(de|fr|es|it|nl|pt|fi)\b/.test(navigator.language || '') ? 'EUR' : 'USD');
    const money = (v, cur = currency) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: v >= 100 || cur === 'JPY' ? 0 : 2 }).format(v); } catch { return `${v} ${cur}`; } };
    const read = () => { try { return JSON.parse(store.get(KEY) || '{}') || {}; } catch { return {}; } };
    let db = read(), running = false;
    const DEMO = { 4: { cur: { v: 21.5, n: 14, at: Date.now() }, low: 27, drop: true }, 5: { cur: { v: 34, n: 3, at: Date.now() }, low: 34 } };
    // info for one release: { cur: {v, n, at}, low (lowest before now), drop }
    function get(id) {
      if (state.mode === 'demo') return DEMO[id] || null;
      const r = db[id]; if (!r || !r.hist || !r.hist.length) return null;
      const cur = r.hist[r.hist.length - 1], before = r.hist.slice(0, -1).map((h) => h.v).filter((v) => v != null);
      const low = before.length ? Math.min(...before) : null;
      return { cur, low, drop: cur.v != null && low != null && cur.v <= low * .9 };
    }
    async function check(wants) {
      if (running || state.mode !== 'spotify' && state.mode !== 'idle') return;
      const cfg = Discogs.config(); if (!cfg) return;
      const due = wants.filter((w) => { const r = db[w.id]; return !r || Date.now() - (r.at || 0) > 6 * 3600e3; })
        .sort((a, b) => ((db[a.id] || {}).at || 0) - ((db[b.id] || {}).at || 0)).slice(0, 40);
      if (!due.length) return;
      running = true;
      const drops = [];
      for (const w of due) {
        try {
          const res = await fetch(`https://api.discogs.com/marketplace/stats/${w.id}?curr_abbr=${currency}`, { headers: cfg.token ? { Authorization: `Discogs token=${cfg.token}` } : {} });
          if (res.status === 429) break;
          if (res.ok) {
            const s = await res.json();
            const r = db[w.id] || (db[w.id] = { hist: [] });
            const v = s.lowest_price && s.lowest_price.currency === currency ? s.lowest_price.value : null;
            r.at = Date.now();
            r.hist.push({ v, n: s.num_for_sale || 0, at: r.at });
            r.hist = r.hist.slice(-30);
            const g = get(w.id); if (g && g.drop) drops.push(`${w.title} (${money(g.cur.v)})`);
            store.set(KEY, JSON.stringify(db));
          }
        } catch {}
        await new Promise((r) => setTimeout(r, cfg.token ? 1100 : 2600));      // Discogs: 25/min without a token, 60 with
      }
      running = false;
      if (drops.length) toast(`Price drop on your wishlist: ${drops.slice(0, 2).join(', ')}${drops.length > 2 ? ` and ${drops.length - 2} more` : ''}`, 7000);
      if (wallOpen() && lib.tab === 'vinyl') renderWall();
      renderVinyl();
    }
    return { get, check, money, currency };
  })();

  // ================================================================ record stores near you
  function localStoresLink() {
    const apple = /iPhone|iPad|Macintosh/.test(navigator.userAgent);
    const url = apple ? 'https://maps.apple.com/?q=record%20store' : 'https://www.google.com/maps/search/record+stores+near+me';
    return link(url, `<span>Record stores near you</span><small>opens ${apple ? 'Apple' : 'Google'} Maps · call ahead to ask</small>`, 'vp-link local');
  }

  // ================================================================ "What should I play?" — a record you haven't spun in a while
  const pick = { shown: new Set(), current: null };
  function lastPlayedOf(name, artist) {
    const k = Discogs.keyOf(artist, name);
    let last = 0;
    for (const r of Object.values(Spins.all())) {
      if (Discogs.keyOf(r.artist, r.name) !== k) continue;
      last = Math.max(last, r.last || 0, ...Object.values(r.heard || {}));
    }
    return last;
  }
  async function pickCandidates() {
    const out = [], seen = new Set();
    const add = (c) => { const k = Discogs.keyOf(c.artist, c.name); if (seen.has(k)) return; seen.add(k); out.push(c); };
    for (const r of ((Discogs.data() || {}).owned || [])) {
      const album = { id: `dg:${r.id}`, name: r.title, artist: r.artist, cover: r.cover, year: r.year ? String(r.year) : '' };
      if (state.mode === 'demo' && !findOnSpotify(album)) continue;      // the demo can only play its own albums
      add({ kind: 'owned', name: r.title, artist: r.artist, cover: r.cover, album });
    }
    if (state.mode !== 'idle' && !lib.items.albums && !lib.loading.albums) await loadAll('albums');
    for (const it of lib.items.albums || []) if (it.type !== 'single' && !(it.n && it.n < 4)) add({ kind: 'saved', name: it.name, artist: it.sub, cover: it.cover, uri: it.uri });
    return out;
  }
  async function pickOne() {
    const body = $('pickBody');
    if (!$('pickDlg').open) { body.innerHTML = '<p class="pick-note">Flipping through your crates…</p>'; $('pickDlg').showModal(); }
    const all = await pickCandidates();
    const cur = state.album ? Discogs.keyOf(state.album.artist, state.album.name) : '';
    let pool = all.filter((c) => Discogs.keyOf(c.artist, c.name) !== cur && !pick.shown.has(Discogs.keyOf(c.artist, c.name)));
    if (!pool.length && all.length) { pick.shown.clear(); pool = all.filter((c) => Discogs.keyOf(c.artist, c.name) !== cur); }
    if (!pool.length) {
      body.innerHTML = `<p class="pick-note">${state.mode === 'idle' ? 'Connect Spotify (or try the demo) first.' : 'Save some albums on Spotify or connect your Discogs collection, and I’ll pick from those.'}</p>`;
      return;
    }
    // weight by how long it's been: records you haven't played in ages come up most; owned vinyl gets a nudge
    const now = Date.now();
    const weights = pool.map((c) => {
      c.last = lastPlayedOf(c.name, c.artist);
      const days = c.last ? (now - c.last) / 864e5 : 120;
      return (days < 2 ? .1 : Math.min(days, 180) + 10) * (c.kind === 'owned' ? 1.6 : 1);
    });
    let r = Math.random() * weights.reduce((a, b) => a + b, 0), i = 0;
    while (i < pool.length - 1 && (r -= weights[i]) > 0) i++;
    const c = pick.current = pool[i];
    pick.shown.add(Discogs.keyOf(c.artist, c.name));
    const ago = c.last ? Math.round((now - c.last) / 864e5) : null;
    const why = c.last == null || !c.last ? 'You haven’t played this one here yet'
      : ago < 1 ? 'Played earlier today' : ago < 14 ? `Last played ${ago} day${ago === 1 ? '' : 's'} ago` : ago < 60 ? `Last played ${Math.round(ago / 7)} weeks ago` : `Last played ${Math.round(ago / 30)} months ago`;
    const bg = c.cover && c.cover.url ? `url("${c.cover.url.replace(/"/g, '%22')}") center/cover` : c.cover && c.cover.gradient ? c.cover.gradient : placeholder(c.name);
    body.innerHTML = `<div class="pick-card">
        <div class="pick-sleeve"><span class="pick-disc"></span><span class="pick-cover" style="background:${esc(bg)}"></span></div>
        <div class="pick-meta"><div class="kicker">${c.kind === 'owned' ? 'From your shelf' : 'From your saved albums'}</div>
          <h3>${esc(c.name)}</h3><p>${esc(c.artist)}</p><small>${esc(why)}</small></div>
      </div>
      <div class="row"><button class="btn primary" id="pickPlay">Put it on</button><button class="btn" id="pickAgain">Another</button></div>`;
    $('pickPlay').onclick = () => playPick(c);
    $('pickAgain').onclick = pickOne;
    $('pickPlay').focus();
  }
  function playPick(c) {
    $('pickDlg').close();
    noteUserNav(); cancelFlip(); state.armParked = false;
    if (c.kind === 'saved') { source().play({ contextUri: c.uri }); toast(`Putting on “${c.name}”`, 2200); return; }
    const uri = findOnSpotify(c.album);
    if (uri) { source().play({ contextUri: uri }); toast(`Putting on “${c.name}”`, 2200); } else playOwned(c.album);
  }
  $('pickBtn').onclick = () => { if (state.mode === 'idle') { openSetup(); return; } pickOne(); };
  $('pickClose').onclick = () => $('pickDlg').close();
  $('pickDlg').addEventListener('click', (e) => { if (e.target === $('pickDlg')) $('pickDlg').close(); });

  // ================================================================ "Now spinning" share card (1080×1920, for Stories)
  async function makeShareCard() {
    const W = 1080, H = 1920, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const c1 = css.getPropertyValue('--c1').trim() || '#7a5238', c2 = css.getPropertyValue('--c2').trim() || '#1d140f';
    const a = state.album, t = state.track, cover = (a && a.cover) || (t && t.cover);
    // background: the album's colours, a warm glow, a little grain
    let bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, c2); bg.addColorStop(1, '#0d0907'); g.fillStyle = bg; g.fillRect(0, 0, W, H);
    let glow = g.createRadialGradient(W * .5, H * .38, 40, W * .5, H * .38, W * .95); glow.addColorStop(0, c1); glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = .55; g.fillStyle = glow; g.fillRect(0, 0, W, H); g.globalAlpha = 1;
    for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * .035})`; g.fillRect(Math.random() * W, Math.random() * H, 2, 2); }

    const img = await new Promise((res) => {
      if (!cover || !cover.url) return res(null);
      const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => res(null); im.src = cover.url;
    });
    const drawCover = (x, y, s) => {
      if (img) { g.drawImage(img, x, y, s, s); return; }
      const cols = (cover && cover.colors) || [c1, c2];
      const gr = g.createLinearGradient(x, y, x + s, y + s); gr.addColorStop(0, cols[0]); gr.addColorStop(1, cols[1] || c2);
      g.fillStyle = gr; g.fillRect(x, y, s, s);
    };

    // the record, slid halfway out of its sleeve, in the pressing that's on the turntable
    const S = 700, sx = 110, sy = 400, R = S * .47, rx = sx + S * .5 + 250, ry = sy + S / 2;
    const ps = (vinyl.data && vinyl.data.pressings) || [], look = vinyl.choice >= 0 && ps[vinyl.choice] ? ps[vinyl.choice].look : null;
    g.save();
    g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 50; g.shadowOffsetY = 18;
    g.beginPath(); g.arc(rx, ry, R, 0, Math.PI * 2); g.fillStyle = look && look.base ? look.base : '#121212'; g.fill();
    g.restore();
    g.save(); g.beginPath(); g.arc(rx, ry, R, 0, Math.PI * 2); g.clip();
    if (look && look.kind === 'picture') drawCover(rx - R, ry - R, R * 2);
    if (look && look.kind === 'splatter') for (let i = 0; i < 70; i++) { g.fillStyle = look.accent; g.beginPath(); g.arc(rx + (Math.random() - .5) * 2 * R, ry + (Math.random() - .5) * 2 * R, 4 + Math.random() * 18, 0, 7); g.fill(); }
    if (look && look.kind === 'marble') { const m = g.createRadialGradient(rx - R * .3, ry - R * .2, 10, rx, ry, R); m.addColorStop(0, look.accent); m.addColorStop(.6, 'rgba(0,0,0,0)'); g.fillStyle = m; g.fillRect(rx - R, ry - R, R * 2, R * 2); }
    for (let r = R * .38; r < R * .97; r += 3.2) { g.strokeStyle = `rgba(255,255,255,${.025 + Math.random() * .03})`; g.lineWidth = 1; g.beginPath(); g.arc(rx, ry, r, 0, 7); g.stroke(); }
    const sheen = g.createLinearGradient(rx - R, ry - R, rx + R, ry + R); sheen.addColorStop(.35, 'rgba(255,255,255,0)'); sheen.addColorStop(.5, 'rgba(255,255,255,.12)'); sheen.addColorStop(.65, 'rgba(255,255,255,0)');
    g.fillStyle = sheen; g.fillRect(rx - R, ry - R, R * 2, R * 2);
    if (!look || look.kind !== 'picture') { g.save(); g.beginPath(); g.arc(rx, ry, R * .34, 0, 7); g.clip(); drawCover(rx - R * .34, ry - R * .34, R * .68); g.restore(); }
    g.fillStyle = '#0a0a0a'; g.beginPath(); g.arc(rx, ry, 9, 0, 7); g.fill();
    g.restore();
    // the sleeve
    g.save(); g.shadowColor = 'rgba(0,0,0,.7)'; g.shadowBlur = 60; g.shadowOffsetY = 26; g.fillStyle = '#222'; g.fillRect(sx, sy, S, S); g.restore();
    drawCover(sx, sy, S);
    const shine = g.createLinearGradient(sx, sy, sx + S, sy + S); shine.addColorStop(0, 'rgba(255,255,255,.16)'); shine.addColorStop(.4, 'rgba(255,255,255,0)');
    g.fillStyle = shine; g.fillRect(sx, sy, S, S);

    // words
    const wrap = (text, x, y, maxW, lh, maxLines) => {
      const words = String(text).split(/\s+/); let line = '', lines = 0;
      for (let i = 0; i < words.length; i++) {
        const test = line ? `${line} ${words[i]}` : words[i];
        if (g.measureText(test).width > maxW && line) {
          if (++lines === maxLines) { while (g.measureText(`${line}…`).width > maxW) line = line.slice(0, -1); g.fillText(`${line}…`, x, y); return y + lh; }
          g.fillText(line, x, y); y += lh; line = words[i];
        } else line = test;
      }
      g.fillText(line, x, y); return y + lh;
    };
    const font = (w, px) => `${w} ${px}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif`;
    let y = 1260;
    g.fillStyle = '#e7c891'; g.font = font(800, 34); g.letterSpacing = '8px';
    g.fillText('NOW SPINNING', 110, y); g.letterSpacing = '0px';
    y += 96; g.fillStyle = '#fff'; g.font = font(800, 84);
    y = wrap(a ? a.name : t ? t.name : 'Nothing playing', 110, y, W - 220, 96, 2);
    g.fillStyle = 'rgba(255,255,255,.72)'; g.font = font(500, 50);
    y = wrap(a ? a.artist : t ? t.artist : '', 110, y + 6, W - 220, 62, 1);
    const extra = [];
    if (a && t && state.albumMode && state.sides) extra.push(`Side ${state.sides[sideIndexOf(state.trackIndex)].letter} · “${t.name}”`);
    else if (t && a && t.name !== a.name) extra.push(`“${t.name}”`);
    const sp = a ? Spins.get(a.id) : null, own = a ? Discogs.match(a) : {};
    if (sp && sp.spins > 1) extra.push(`${nth(sp.spins)} time front to back`);
    if (own.owned) extra.push('On my shelf');
    else if (look) extra.push(`${pressName(ps[vinyl.choice])} pressing`);
    g.fillStyle = 'rgba(255,255,255,.55)'; g.font = font(500, 40);
    for (const line of extra.slice(0, 3)) { y = wrap(line, 110, y + 18, W - 220, 50, 1); }
    // footer: wordmark + the turntable's finish
    const fin = css.getPropertyValue('--pl-a').trim() || '#b98f55';
    g.fillStyle = fin; g.beginPath(); g.arc(134, H - 150, 24, 0, 7); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#fff'; g.font = font(800, 40); g.fillText('The Vinyl Shelf', 180, H - 136);
    return new Promise((res) => cv.toBlob((b) => res(b), 'image/png'));
  }
  let shareUrl = null;
  async function openShare() {
    if (!state.track) return;
    $('shareImg').removeAttribute('src'); $('shareDlg').showModal();
    let blob = null;
    try { blob = await makeShareCard(); } catch {}
    if (!blob) { $('shareDlg').close(); toast('Couldn’t make the card for this one'); return; }
    if (shareUrl) URL.revokeObjectURL(shareUrl);
    shareUrl = URL.createObjectURL(blob);
    $('shareImg').src = shareUrl; $('shareSave').href = shareUrl;
    const name = `now-spinning-${(state.album ? state.album.name : state.track.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'record'}.png`;
    $('shareSave').download = name;
    const file = new File([blob], name, { type: 'image/png' });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    $('shareGo').classList.toggle('hidden', !canShare);
    $('shareGo').onclick = async () => { try { await navigator.share({ files: [file] }); } catch {} };
  }
  $('shareBtn').onclick = openShare;
  $('shareClose').onclick = () => $('shareDlg').close();
  $('shareDlg').addEventListener('click', (e) => { if (e.target === $('shareDlg')) $('shareDlg').close(); });

  // open the vinyl panel for any album (from the "My vinyl" shelves)
  async function openVinylFor(album) {
    if (state.album && album.id === state.album.id) { vinyl.browse = null; renderVinyl(); openPanel($('vinylPanel')); return; }
    const b = vinyl.browse = { album, status: 'loading', data: null, showAll: false };
    renderVinyl(); openPanel($('vinylPanel'));
    try { b.data = await source().vinyl(album); b.status = 'done'; } catch { b.status = 'error'; }
    if (vinyl.browse === b) renderVinyl();
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
    if (p.classList.contains('open') && !vinyl.browse) closePanel(p); else { vinyl.browse = null; renderVinyl(); openPanel(p); }
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
  // Shows Spotify's live queue (shuffle, songs you added, etc.), refreshed on every song change and every 10s.
  const plInfo = new Map();
  let queueTimer = null;
  async function openQueue() {
    const c = state.context;
    if (!c || c.type !== 'playlist') return;
    Object.assign(tl, { mode: 'queue', uri: c.uri, data: null, info: plInfo.get(c.uri) || null });
    document.body.classList.add('tl-queue');
    renderQueue();
    if (!isDocked()) openPanel($('tracklist'));
    if (!tl.info) {
      const uri = c.uri;
      source().playlistInfo(uri).then((info) => { plInfo.set(uri, info); if (tl.mode === 'queue' && tl.uri === uri) { tl.info = info; renderQueue(); } }).catch(() => {});
    }
    refreshQueue();
    clearInterval(queueTimer);
    queueTimer = setInterval(() => { if (isTracklistVisible() && !document.hidden) refreshQueue(); }, 10e3);
  }
  async function refreshQueue() {
    if (tl.mode !== 'queue') return;
    const req = ++tl.req;
    try {
      const data = await source().queue();
      if (req === tl.req && tl.mode === 'queue') { tl.data = data; renderQueue(); }
    } catch { if (req === tl.req && tl.mode === 'queue' && !tl.data) { tl.data = { error: true }; renderQueue(); } }
  }
  function closeQueue() {
    if (tl.mode !== 'queue') return;
    clearInterval(queueTimer); queueTimer = null;
    Object.assign(tl, { mode: 'album', uri: null, data: null, info: null }); tl.req++;
    document.body.classList.remove('tl-queue');
    if (state.album) { renderTracklist(); highlightTracklist(); } else closePanel($('tracklist'));
  }
  function renderQueue() {
    const d = tl.data, info = tl.info, list = $('tlList');
    $('tlKicker').textContent = 'Playlist queue';
    $('tlTitle').textContent = (info && info.name) || ctxNames.get(tl.uri) || 'Playlist';
    $('tlCover').style.backgroundImage = info && info.cover ? coverCss(info.cover) : '';
    $('tlSub').textContent = info && info.owner ? `${info.owner} · live from Spotify` : 'Live from Spotify';
    if (!d) { list.innerHTML = '<li class="tl-note">Checking your Spotify queue…</li>'; return; }
    if (d.error) { list.innerHTML = '<li class="tl-note">Couldn’t load your queue right now.</li>'; return; }
    const row = (t, i, label) =>
      `<li${i === 0 ? ' class="current"' : ''}><button data-i="${i}"${i === 0 ? ' disabled' : ''}><span class="n">${label}</span><span class="nm">${esc(t.name)}<small>${esc(t.artist)}</small></span><span class="d">${t.durationMs ? fmt(t.durationMs) : ''}</span></button></li>`;
    let html = '';
    if (d.now) html += '<li class="tl-note tl-head">Now playing</li>' + row(d.now, 0, '♪');
    html += d.next.length ? '<li class="tl-note tl-head">Next up</li>' + d.next.map((t, i) => row(t, i + 1, i + 1)).join('')
      : '<li class="tl-note">Nothing queued after this song.</li>';
    list.innerHTML = html;
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
  const lib = { items: {}, loading: {}, query: '', gen: 0, tab: ['playlists', 'vinyl', 'trending'].includes(store.get('tt.wallTab')) ? store.get('tt.wallTab') : 'albums' };
  const wallOpen = () => $('library').classList.contains('open');
  function resetLibrary() { lib.items = {}; lib.loading = {}; lib.gen++; trend.data = null; trend.at = 0; if (wallOpen()) renderWall(); }

  $('libraryBtn').onclick = () => {
    const p = $('library');
    if (wallOpen()) { closePanel(p); return; }
    if (state.mode === 'idle') { openSetup(); return; }
    openPanel(p); renderWall();
    KINDS.forEach((k) => { if (!lib.items[k]) loadAll(k); });
    Discogs.maybeAutoSync(); LastFm.maybeAutoImport();
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
      if (kind === 'vinyl') { shown += renderVinylShelves(sec, shelves, q, cols, gap); continue; }
      if (kind === 'trending') { shown += renderTrending(sec, shelves, q, cols, gap); continue; }
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
      shelves.innerHTML = shelfRows(kind, list, cols, gap);
    }
    msg.textContent = q && !shown ? `No records match “${lib.query.trim()}”.` : '';
    markCurrentOnWall();
  }

  function shelfRows(kind, list, cols, gap) {
    let html = '';
    for (let r = 0; r < list.length; r += cols) {
      const row = list.slice(r, r + cols);
      html += `<div class="shelf-row" style="--cols:${cols};--gap:${gap}px">
        <div class="row-covers">${row.map((x) => coverHtml(kind, x)).join('')}</div>
        <div class="plank"></div>
        <div class="row-caps">${row.map(({ it, i }) => `<button class="cap" data-kind="${kind}" data-i="${i}" tabindex="-1"><span class="name">${esc(it.name)}</span><span class="sub">${esc(it.sub)}</span></button>`).join('')}</div>
      </div>`;
    }
    return html;
  }

  // "Trending": what everyone is rating — most-rated albums, the highest rated, and the most-liked reviews
  const trend = { data: null, at: 0, busy: false };
  function loadTrending() {
    if (trend.busy) return;
    trend.busy = true;
    Reviews.trending().then((d) => { trend.data = d || { mostRated: [], topRated: [], popular: [] }; }, () => { trend.data = { error: true }; })
      .finally(() => { trend.busy = false; trend.at = Date.now(); if (wallOpen() && lib.tab === 'trending') renderWall(); });
  }
  const avgLabel = (avg) => (avg / 2).toFixed(1);
  function likeBtn(r, idx, where) {
    if (r.mine) return `<span class="like-count" title="Likes on your review">♥ ${r.likes || 0}</span>`;
    return `<button class="like-btn${r.liked ? ' on' : ''}" data-like="${idx}" data-where="${where}" aria-pressed="${!!r.liked}" aria-label="Like ${esc(r.name)}’s review">♥ <span>${r.likes || 0}</span></button>`;
  }
  async function toggleLike(r, btn) {
    if (state.mode !== 'demo' && !Reviews.signedIn()) { toast('Sign in to like reviews (Settings → Profile & reviews)', 3500); return; }
    const on = !r.liked;
    r.liked = on; r.likes = Math.max(0, (r.likes || 0) + (on ? 1 : -1));
    const paint = () => { btn.classList.toggle('on', r.liked); btn.setAttribute('aria-pressed', String(r.liked)); btn.querySelector('span').textContent = r.likes; };
    paint(); btn.disabled = true;
    const ok = await Reviews.like(r.id, on);
    btn.disabled = false;
    if (!ok) { r.liked = !on; r.likes = Math.max(0, r.likes + (on ? -1 : 1)); paint(); toast('Couldn’t save that like — try again'); }
    else trend.at = 0; // re-rank next time Trending is drawn
  }
  function renderTrending(sec, shelves, q, cols, gap) {
    sec.hidden = lib.tab !== 'trending';
    if (sec.hidden) return 0;
    if (!Reviews.remoteOn && state.mode !== 'demo') {
      shelves.innerHTML = '<p class="wall-note">Trending shows what everyone is rating once community reviews are switched on for this app.</p>'; return 1;
    }
    if (!trend.busy && (!trend.data || Date.now() - trend.at > 60000)) loadTrending();
    const t = trend.data;
    if (!t) { shelves.innerHTML = '<p class="wall-note">Checking what’s trending…</p>'; return 1; }
    if (t.missing) { shelves.innerHTML = '<p class="wall-note">Trending needs one more database step: run <b>supabase/trending.sql</b> in your Supabase SQL Editor.</p>'; return 1; }
    if (t.error) { shelves.innerHTML = '<p class="wall-note">Couldn’t load what’s trending right now.</p>'; return 1; }
    const match = (a) => !q || `${a.name} ${a.artist}`.toLowerCase().includes(q);
    const shelfOf = (kind, list, badge) => {
      lib.items[kind] = list.filter((st) => match(st.album)).map((st) => ({ id: st.album.id, uri: '', name: st.album.name, sub: st.album.artist, cover: st.album.cover, badge: badge(st), album: st.album }));
      return lib.items[kind].map((it, i) => ({ it, i }));
    };
    const group = (kind, title, blurb, list, empty) => {
      if (q && !list.length) return '';
      return `<div class="vgroup"><h3 class="vgroup-title">${title}<small>${blurb}</small></h3>${list.length ? shelfRows(kind, list, cols, gap) : `<p class="wall-note">${empty}</p>`}</div>`;
    };
    const most = shelfOf('trendMost', t.mostRated, (st) => `★ ${avgLabel(st.avg)} · ${st.ratings}`);
    const top = shelfOf('trendTop', t.topRated, (st) => `★ ${avgLabel(st.avg)}`);
    const revs = lib.items.trendReviews = t.popular.filter((r) => match(r.album) || `${r.name} ${r.body}`.toLowerCase().includes(q));
    let html = group('trendMost', 'Most rated', 'The albums people are rating most this week, then of all time · ★ average · number of ratings',
      most, 'No ratings yet. Rate what’s playing to start the chart.');
    html += group('trendTop', 'Highest rated', 'The best-loved albums by average rating · tap one for its reviews',
      top, 'Albums show up here once a couple of people have rated them.');
    if (revs.length || !q) html += `<div class="vgroup"><h3 class="vgroup-title">Popular reviews<small>The reviews getting the most ♥ this week · tap one to read the rest</small></h3>${
      revs.length ? `<ul class="notes diary rv-feed trend-reviews">${revs.map((r, i) => `<li class="note" data-trend-rv="${i}" role="button" tabindex="0">
          <span class="trend-rank">${i + 1}</span>
          <span class="note-cover" style="background:${esc(r.album.cover ? `${coverCss(r.album.cover)} center/cover` : placeholder(r.album.name))}"></span>
          <div><div class="note-meta"><b>${esc(r.name)}</b> on <b>${esc(r.album.name)}</b> · ${esc(r.album.artist)} · ${esc(noteDate(r.at))}</div>
          ${r.rating ? starsHtml(r.rating) : ''}<p>${esc(r.body)}</p>${likeBtn(r, i, 'trend')}</div></li>`).join('')}</ul>`
        : '<p class="wall-note">No written reviews yet. Write one with the ★ button under the album.</p>'}</div>`;
    shelves.innerHTML = html;
    return most.length + top.length + revs.length || (q ? 0 : 1);
  }

  // "My vinyl": albums you keep playing but don't own, your Discogs shelf, and your wishlist
  function renderVinylShelves(sec, shelves, q, cols, gap) {
    sec.hidden = lib.tab !== 'vinyl';
    const d = Discogs.data(), connected = Discogs.connected();
    const match = (it) => !q || `${it.name} ${it.sub}`.toLowerCase().includes(q);
    const fromDg = (r, kind) => ({
      id: `dg:${r.id}`, uri: '', name: r.title, sub: [r.artist, r.year || ''].filter(Boolean).join(' · '), cover: r.cover,
      album: { id: `dg:${r.id}`, name: r.title, artist: r.artist, year: r.year ? String(r.year) : '', cover: r.cover, dgMaster: r.master }, kind,
    });
    // albums tracked here, topped up with Last.fm estimates (whichever count is higher)
    const byKey = new Map();
    for (const [id, r] of Object.entries(Spins.all())) {
      byKey.set(Discogs.keyOf(r.artist, r.name), { id, uri: r.uri, name: r.name, artist: r.artist, cover: r.cover, n: r.spins, approx: false, last: r.last || 0,
        album: { id, name: r.name, artist: r.artist, year: r.year, cover: r.cover, upc: r.upc } });
    }
    for (const x of (LastFm.data() || {}).albums || []) {
      if (x.est < 3) continue;
      const k = Discogs.keyOf(x.artist, x.name), e = byKey.get(k);
      if (e) { if (x.est > e.n) { e.n = x.est; e.approx = true; } if (!e.cover && x.cover) e.cover = x.cover; continue; }
      const id = `lf:${k}`;
      byKey.set(k, { id, uri: '', name: x.name, artist: x.artist, cover: x.cover, n: x.est, approx: true, last: 0, album: { id, name: x.name, artist: x.artist, cover: x.cover } });
    }
    const worth = [...byKey.values()]
      .filter((e) => e.n >= 2 && !Discogs.match(e).owned)
      .sort((a, b) => b.n - a.n || b.last - a.last)
      .map((e) => ({ id: e.id, uri: e.uri, name: e.name, sub: e.artist, cover: e.cover, badge: `${e.approx ? '≈' : ''}${e.n}× front to back`, wanted: !!Discogs.match(e).wanted, album: e.album }));
    lib.items.worth = worth;
    lib.items.owned = ((d && d.owned) || []).map((r) => fromDg(r, 'owned'));
    lib.items.wants = ((d && d.wants) || []).map((r) => {
      const it = fromDg(r, 'wants'), pr = Prices.get(r.id);
      if (pr && pr.cur && pr.cur.v != null) { it.badge = `${pr.drop ? '↓ ' : 'from '}${Prices.money(pr.cur.v)}`; it.drop = pr.drop; }
      return it;
    });
    if (d && d.wants && d.wants.length && !sec.hidden) Prices.check(d.wants.map((w) => ({ id: w.id, title: w.title })));
    for (const it of lib.items.owned) { const sp = Object.values(Spins.all()).find((r) => Discogs.keyOf(r.artist, r.name) === Discogs.keyOf(it.album.artist, it.name)); if (sp && sp.spins) it.badge = `${sp.spins}× front to back`; }
    document.querySelector('[data-count="vinyl"]').textContent = d ? String(lib.items.owned.length) : '';
    if (sec.hidden) return 0;

    const group = (kind, title, blurb, all, empty) => {
      const list = all.map((it, i) => ({ it, i })).filter(({ it }) => match(it));
      if (q && !list.length) return '';
      return `<div class="vgroup"><h3 class="vgroup-title">${title}<small>${blurb}</small></h3>${
        list.length ? shelfRows(kind, list, cols, gap) : `<p class="wall-note">${empty}</p>`}</div>`;
    };
    let html = '', n = 0;
    const lfOn = !!LastFm.data();
    html += group('worth', 'Worth owning', `Albums you keep playing start to finish that aren’t on your shelf yet${lfOn ? ' · ≈ estimated from Last.fm' : ''}`,
      worth, LastFm.isBusy() ? 'Importing your Last.fm history…' : 'Play albums start to finish and the ones you keep coming back to will show up here.');
    if (!lfOn && !LastFm.config() && state.mode !== 'demo')
      html += `<p class="wall-note vlf">Have years of listening on Last.fm? <button class="linkish" id="vLastfm">Import it</button> to fill this shelf now.</p>`;
    n += worth.length;
    if (!connected) {
      html += `<div class="vconnect"><b>Bring in your record collection</b><p>Connect Discogs to see the records you own here, mark them on your wall, and keep owned albums out of “Worth owning”.</p><button class="btn primary" id="vConnect">Connect Discogs</button></div>`;
    } else if (!d) {
      html += `<p class="wall-note">${Discogs.isSyncing() ? 'Pulling your collection from Discogs…' : 'Your Discogs collection hasn’t synced yet.'}</p>`;
    } else {
      html += group('owned', 'On your shelf', `From your Discogs collection${d.user !== 'demo' ? ` (${esc(d.user)})` : ''} · tap one to play it`,
        lib.items.owned, 'No vinyl in your Discogs collection yet.');
      html += group('wants', 'Wishlist', `From your Discogs wantlist · lowest Discogs price, ↓ when it drops · tap one for pressings and shops`,
        lib.items.wants, d.wantsHidden ? 'Your Discogs wantlist is private — add a personal access token in Settings to see it.' : 'Nothing on your Discogs wantlist.');
      n += lib.items.owned.length + lib.items.wants.length;
    }
    // your ratings, as a shelf with the stars on each sleeve
    lib.items.rated = Reviews.allMine().map((r) => ({ id: `rv:${r.key}`, uri: '', name: r.name, sub: r.artist, cover: r.cover,
      badge: r.rating ? `★ ${starLabel(r.rating)}` : 'Reviewed', album: { id: r.spotifyId || `rv:${r.key}`, name: r.name, artist: r.artist, cover: r.cover } }));
    if (lib.items.rated.length || !q) html += group('rated', 'Your ratings', 'Albums you’ve rated or reviewed · tap one to read or edit',
      lib.items.rated, 'Rate what’s playing with the ★ button under the album, or press W.');
    if (Reviews.remoteOn || state.mode === 'demo') html += `<div class="vgroup"><h3 class="vgroup-title">Latest reviews<small>What other listeners are saying</small></h3><div id="rvFeed"><p class="wall-note">Loading…</p></div></div>`;
    const notes = Notes.all().filter((n) => !q || `${n.name} ${n.artist} ${n.text}`.toLowerCase().includes(q));
    html += `<div class="vgroup"><h3 class="vgroup-title">Listening diary<small>Notes you’ve written while records played · press N to add one</small></h3>${
      notes.length ? `<ul class="notes diary">${notesHtml(notes.slice(0, 60), true)}</ul>` : '<p class="wall-note">No notes yet. Tap “Note” under the album while something plays.</p>'}</div>`;
    shelves.innerHTML = html;
    const vc = $('vConnect'); if (vc) vc.onclick = () => { openSetup(); setTimeout(() => $('discogsUser').focus(), 50); };
    if ($('rvFeed')) Reviews.recent().then((list) => {
      const box = $('rvFeed'); if (!box) return;
      lib.items.feed = list || [];
      box.innerHTML = list && list.length ? `<ul class="notes diary rv-feed">${list.map((r, i) => `<li class="note" data-feed="${i}" role="button" tabindex="0">
          <span class="note-cover" style="background:${esc(r.album.cover ? `${coverCss(r.album.cover)} center/cover` : placeholder(r.album.name))}"></span>
          <div><div class="note-meta"><b>${esc(r.name)}</b> on <b>${esc(r.album.name)}</b> · ${esc(r.album.artist)} · ${esc(noteDate(r.at))}</div>
          ${r.rating ? starsHtml(r.rating) : ''}${r.body ? `<p>${esc(r.body)}</p>` : ''}</div></li>`).join('')}</ul>`
        : '<p class="wall-note">No reviews yet. Rate what’s playing to start things off.</p>';
    }).catch(() => { const box = $('rvFeed'); if (box) box.innerHTML = '<p class="wall-note">Couldn’t load reviews right now.</p>'; });
    const vl = $('vLastfm'); if (vl) vl.onclick = () => { openSetup(); setTimeout(() => $('lastfmUser').focus(), 50); };
    return n || (q ? 0 : 1);
  }

  function coverHtml(kind, { it, i }) {
    const tilt = ((hashOf(it.id) % 25) - 12) / 10;          // -1.2° … 1.2°, stable per record
    const bg = it.cover && !it.cover.url ? it.cover.gradient : placeholder(it.id);
    const img = it.cover && it.cover.url ? `<img src="${esc(it.cover.url)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '';
    const initial = esc((it.name || '?').trim().charAt(0).toUpperCase());
    const own = kind === 'albums' ? Discogs.match({ name: it.name, artist: it.sub }) : kind === 'worth' ? { wanted: it.wanted } : {};
    const sticker = own.owned ? '<span class="sticker owned" title="On your shelf">✓</span>' : own.wanted ? '<span class="sticker wanted" title="On your wishlist">♥</span>' : '';
    const badge = it.badge ? `<span class="rec-badge${it.drop ? ' drop' : ''}">${esc(it.badge)}</span>` : '';
    const verb = kind === 'worth' || kind === 'wants' ? 'Pressings for' : ['rated', 'trendMost', 'trendTop'].includes(kind) ? 'Reviews for' : 'Play';
    return `<button class="rec" data-kind="${kind}" data-i="${i}" data-uri="${esc(it.uri)}" style="--tilt:${tilt}deg" title="${verb} ${esc(it.name)}" aria-label="${verb} ${esc(it.name)}">
      <span class="cover" style="background:${esc(bg)}">${it.cover ? '' : initial}${img}${badge}</span>${sticker}</button>`;
  }

  function markCurrentOnWall() {
    document.querySelectorAll('.rec.current').forEach((r) => r.classList.remove('current'));
    const uri = state.context && state.context.uri;
    if (uri) document.querySelectorAll(`.rec[data-uri="${CSS.escape(uri)}"]`).forEach((r) => r.classList.add('current'));
  }

  // a Discogs record → a Spotify album you've saved or spun
  function findOnSpotify(a) {
    const k = Discogs.keyOf(a.artist, a.name);
    const saved = (lib.items.albums || []).find((x) => Discogs.keyOf(x.sub, x.name) === k);
    if (saved) return saved.uri;
    const spun = Object.values(Spins.all()).find((r) => r.uri && Discogs.keyOf(r.artist, r.name) === k);
    if (spun) return spun.uri;
    if (state.mode === 'demo') { const d = Demo.albums.find((x) => Discogs.keyOf(x.artist, x.name) === k); return d ? d.uri : null; }
    return null;
  }
  async function playOwned(a) {
    if (state.mode !== 'spotify') { toast(`“${a.name}” isn’t in the demo’s Spotify`); return; }
    try {
      const artist = (a.artist || '').split(', ')[0];
      const r = await getJSON(`/search?type=album&limit=5&q=${encodeURIComponent(`album:${a.name} artist:${artist}`)}`);
      const k = Discogs.keyOf(a.artist, a.name);
      const hit = (r.albums?.items || []).filter(Boolean).find((x) => Discogs.keyOf((x.artists || []).map((y) => y.name).join(', '), x.name) === k) || (r.albums?.items || [])[0];
      if (!hit) { toast(`Couldn’t find “${a.name}” on Spotify`); return; }
      state.armParked = false;
      source().play({ contextUri: hit.uri });
      closePanel($('library'));
      toast(`Putting on “${hit.name}”`, 2200);
    } catch { toast(`Couldn’t search Spotify for “${a.name}”`); }
  }

  let pulling = false;
  $('wallScroll').addEventListener('click', (e) => {
    const lk = e.target.closest('[data-like]');
    if (lk) { const r = (lib.items.trendReviews || [])[Number(lk.dataset.like)]; if (r) toggleLike(r, lk); return; }
    const tr = e.target.closest('[data-trend-rv]');
    if (tr) { const r = (lib.items.trendReviews || [])[Number(tr.dataset.trendRv)]; if (r) openReviews(r.album); return; }
    const f = e.target.closest('[data-feed]');
    if (f) { const r = (lib.items.feed || [])[Number(f.dataset.feed)]; if (r) openReviews(r.album); return; }
    const b = e.target.closest('[data-i][data-kind]'); if (!b || pulling) return;
    const it = (lib.items[b.dataset.kind] || [])[Number(b.dataset.i)]; if (!it) return;
    if (b.dataset.kind === 'worth' || b.dataset.kind === 'wants') { openVinylFor(it.album); return; }
    if (['rated', 'trendMost', 'trendTop'].includes(b.dataset.kind)) { openReviews(it.album); return; }
    let uri = it.uri;
    if (b.dataset.kind === 'owned') {
      uri = findOnSpotify(it.album);
      if (!uri) { playOwned(it.album); return; }
    }
    state.armParked = false;
    source().play({ contextUri: uri });
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
    const dc = Discogs.config() || {};
    $('discogsUser').value = dc.user || ''; $('discogsToken').value = dc.token || '';
    renderDiscogsStatus();
    renderProfile();
    const lc = LastFm.config() || {};
    $('lastfmUser').value = lc.user || ''; $('lastfmKey').value = lc.key || '';
    renderLastFmStatus();
  }
  function openSetup() { updateDialog(); if (!dialog.open) dialog.showModal(); }

  $('settingsBtn').onclick = openSetup;
  $('discogsSync').onclick = () => {
    if (state.mode === 'demo') { toast('Demo mode uses a made-up collection — connect Spotify first'); return; }
    if (!Discogs.setConfig($('discogsUser').value, $('discogsToken').value)) { toast('Enter your Discogs username'); return; }
    Discogs.sync();
  };
  $('lastfmImport').onclick = () => {
    if (state.mode === 'demo') { toast('Demo mode uses made-up history — connect Spotify first'); return; }
    if (!LastFm.setConfig($('lastfmUser').value, $('lastfmKey').value)) { toast('Enter your Last.fm username and API key'); return; }
    LastFm.importHistory();
  };
  $('lastfmClear').onclick = () => { LastFm.clear(); $('lastfmUser').value = ''; $('lastfmKey').value = ''; toast('Last.fm disconnected'); };
  $('discogsClear').onclick = () => { Discogs.clear(); $('discogsUser').value = ''; $('discogsToken').value = ''; toast('Discogs disconnected'); };
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
      if ((state.isPlaying || document.body.classList.contains('tv')) && !dialog.open && !document.querySelector('.panel.open') && !seekDrag.active) document.body.classList.add('idle');
    }, document.body.classList.contains('tv') ? 3000 : 6000);
  }
  ['mousemove', 'pointerdown', 'keydown', 'wheel'].forEach((ev) => addEventListener(ev, wake, { passive: true }));
  wake();

  // the deck's own Start·Stop button
  $('startStop').addEventListener('pointerup', (e) => e.stopPropagation());
  $('startStop').onclick = (e) => { e.stopPropagation(); togglePlay(); };

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
    if (dialog.open || $('noteDlg').open || $('pickDlg').open || $('shareDlg').open || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === 'Escape' && e.target.id === 'libSearch') closePanel($('library'));
      return;
    }
    if (e.key === '/' && wallOpen()) { e.preventDefault(); $('libSearch').focus(); return; }
    if (e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Enter' && document.body.classList.contains('tv') && !(e.target instanceof Element && e.target.closest('button, a, [role=button], [tabindex]'))) { e.preventDefault(); togglePlay(); }
    else if (e.key === 'MediaPlayPause' || e.key === 'MediaPlay' || e.key === 'MediaPause') { e.preventDefault(); if ((e.key === 'MediaPlay') !== state.isPlaying || e.key === 'MediaPlayPause') togglePlay(); }
    else if (e.key === 'MediaTrackNext') skip(1);
    else if (e.key === 'MediaTrackPrevious') skip(-1);
    else if (e.key === 'ArrowRight') skip(1);
    else if (e.key === 'ArrowLeft') skip(-1);
    else if (e.key === 'f') toggleFullscreen();
    else if (e.key === 'c') $('crackleBtn').click();
    else if (e.key === 'l') $('libraryBtn').click();
    else if (e.key === 'v') $('vinylBtn').click();
    else if (e.key === 'n' && state.track) { e.preventDefault(); openNote(); }
    else if (e.key === 'r') $('pickBtn').click();
    else if (e.key === 'w' && state.album) { e.preventDefault(); openReviews(state.album); }
    else if (e.key === 's' && state.track) openShare();
    else if (e.key === 't' && document.body.classList.contains('has-album') && !isDocked()) $('tracklistBtn').click();
    else if ((e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || e.key === 'Backspace') && document.body.classList.contains('tv')
      && !document.querySelector('.panel.open') && !(document.fullscreenElement || document.webkitFullscreenElement)) { e.preventDefault(); exitTv(); }
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

  // ================================================================ TV mode (?tv): big-screen layout for TVs, casting and mirroring
  const tvMode = new URLSearchParams(location.search).has('tv');
  if (tvMode) {
    document.body.classList.add('tv');
    // clock in the corner
    const clock = () => { $('tvClock').textContent = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
    clock(); setInterval(clock, 15e3);
    // fullscreen needs a click or key press first
    const hint = $('tvHint');
    if (fsSupported) { hint.classList.add('show'); setTimeout(() => hint.classList.remove('show'), 9000); } else hint.remove();
    const goFull = () => {
      hint.classList.remove('show');
      if (fsSupported && !(document.fullscreenElement || document.webkitFullscreenElement)) { try { toggleFullscreen(); } catch {} }
    };
    addEventListener('pointerdown', goFull, { once: true });
    const goFullKey = (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta', 'Escape', 'Backspace', 'GoBack', 'BrowserBack'].includes(e.key)) return;   // those mean "get me out"
      removeEventListener('keydown', goFullKey); goFull();
    };
    addEventListener('keydown', goFullKey);
    // leaving full screen (Esc) shows the way out of TV mode
    const onFs = () => {
      if (document.fullscreenElement || document.webkitFullscreenElement) return;
      wake(); toast('Press Esc again or Exit TV mode to leave TV mode', 5000);
    };
    document.addEventListener('fullscreenchange', onFs); document.addEventListener('webkitfullscreenchange', onFs);
    // dim after a few minutes paused, so a still picture doesn't burn into the screen
    let pausedSince = 0;
    setInterval(() => {
      if (state.isPlaying || flip.pending) pausedSince = 0;
      else if (!pausedSince) pausedSince = Date.now();
      document.body.classList.toggle('tv-dim', !!pausedSince && Date.now() - pausedSince > 4 * 60e3);
    }, 5000);
    addEventListener('keydown', () => document.body.classList.remove('tv-dim'));
    addEventListener('pointermove', () => document.body.classList.remove('tv-dim'));
  }
  // TV mode lives in the address (?tv), so a bookmark on the TV opens straight into it.
  // Leaving swaps the address without ?tv (replace, so Back doesn't land you in TV mode again).
  const urlWith = (q) => { const str = q.toString().replace(/=(&|$)/g, '$1'); return `${location.pathname}${str ? `?${str}` : ''}${location.hash}`; };
  function exitTv() {
    const q = new URLSearchParams(location.search); q.delete('tv');
    if (document.fullscreenElement || document.webkitFullscreenElement) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch {} }
    location.replace(urlWith(q));
  }
  $('tvBtn').textContent = tvMode ? 'Exit TV mode' : 'Open TV mode';
  $('tvBtn').onclick = () => {
    if (tvMode) { exitTv(); return; }
    const q = new URLSearchParams(location.search); q.set('tv', '');
    location.href = urlWith(q);
  };
  $('tvExit').onclick = exitTv;
  // "Up next" line (TV mode): the next song on the album
  function renderUpNext() {
    const el = $('upNext'), a = state.album, i = state.trackIndex;
    let txt = '';
    if (state.albumMode && a && i >= 0 && i < a.tracks.length - 1) {
      const sd = state.sides ? state.sides[sideIndexOf(i)] : null;
      txt = sd && i === sd.end - 1 && flipOn() ? `Then flip to Side ${state.sides[sideIndexOf(i + 1)].letter}` : `Up next · ${a.tracks[i + 1].name}`;
    }
    el.textContent = txt; el.classList.toggle('hidden', !txt);
  }

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
    else crackle.update(soundingNow() ? 1 : 0);
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

  // ================================================================ ratings & reviews
  // Your own reviews always live on this device first (so rating works offline and without an account).
  // If config.js has a Supabase project, signed-in reviews are also shared, and everyone's show up per album.
  const Reviews = (() => {
    const CFG = window.TVS_CONFIG || {};
    const remoteOn = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
    const lkey = () => (state.mode === 'demo' ? 'tt.reviews.demo' : 'tt.reviews');
    let sb = null, session = null, profile = null, loading = null;
    const keyOf = (a) => Discogs.keyOf(a.artist || a.sub, a.name);
    const localAll = () => { try { return JSON.parse(store.get(lkey()) || '{}') || {}; } catch { return {}; } };
    const localSet = (all) => store.set(lkey(), JSON.stringify(all));
    const coverUrl = (c) => (c && c.url && /^https:\/\//.test(c.url) ? c.url : null);

    // ---- demo: a few made-up listeners so the community side can be explored
    const PEOPLE = ['Maya R.', 'jules', 'Theo', 'crate_digger', 'Priya', 'sam w.', 'Noor', 'Ben K.'];
    const LINES = [
      'Side B is where it really opens up. Best on a rainy afternoon.',
      'The pressing I have is a little noisy but the songs carry it.',
      'Took me three listens. Now I can’t stop.',
      'Front to back, no skips. The closer gets me every time.',
      'Pretty but a bit samey in the middle.',
      'Bought this after hearing one song in a coffee shop. Zero regrets.',
      'The bass on vinyl is so much warmer than streaming.',
      'Good, not great. The singles are the highlights.',
    ];
    function demoFor(a) {
      const h = hashOf(keyOf(a)), n = 2 + (h % 4), out = [];
      for (let i = 0; i < n; i++) {
        const k = (h >>> (i * 3)) + i * 7;
        out.push({ id: `d:${keyOf(a)}:${i}`, name: PEOPLE[k % PEOPLE.length], rating: 5 + ((k >> 2) % 6), body: (k % 5) === 0 ? '' : LINES[(k >> 1) % LINES.length], at: Date.now() - ((k % 40) + 1) * 864e5 });
      }
      return out;
    }

    const demoLiked = new Set();
    const demoLikes = (r) => (hashOf(r.id) % 38) + 1 + (demoLiked.has(r.id) ? 1 : 0);
    const withDemoLikes = (r) => ({ ...r, likes: demoLikes(r), liked: demoLiked.has(r.id) });
    function demoTrending() {
      const stats = Demo.albums.map((a) => {
        const rs = demoFor(a), h = hashOf(keyOf(a));
        return { album: { id: a.id, name: a.name, artist: a.artist, cover: a.cover }, avg: rs.reduce((n, r) => n + r.rating, 0) / rs.length,
          ratings: rs.length * (3 + (h % 9)), recent: (h >>> 5) % 12, reviews: rs };
      });
      return {
        mostRated: [...stats].sort((x, y) => y.recent - x.recent || y.ratings - x.ratings),
        topRated: [...stats].sort((x, y) => y.avg - x.avg || y.ratings - x.ratings),
        popular: stats.flatMap((st) => st.reviews.filter((r) => r.body).map((r) => ({ ...withDemoLikes(r), album: st.album })))
          .sort((x, y) => y.likes - x.likes).slice(0, 20),
      };
    }
    const albumOf = (r) => ({ id: r.spotify_album_id || `rv:${r.album_key}`, name: r.album_name, artist: r.artist, cover: r.cover_url ? { url: r.cover_url } : null });
    const statOf = (r) => ({ album: albumOf(r), avg: Number(r.avg_rating) || 0, ratings: Number(r.ratings) || 0, recent: Number(r.recent) || 0 });
    const missingView = (e) => /PGRST205|42P01|does not exist|schema cache/i.test(`${e.code} ${e.message}`);
    async function likedSet(ids) {
      if (!sb || !session || !ids.length) return new Set();
      const { data } = await sb.from('review_likes').select('review_id').eq('user_id', session.user.id).in('review_id', ids);
      return new Set((data || []).map((x) => x.review_id));
    }

    // ---- Supabase, loaded only when it's configured and needed
    async function client() {
      if (!remoteOn) return null;
      if (sb) return sb;
      if (!loading) loading = (async () => {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
          s.onload = res; s.onerror = rej; document.head.append(s);
        });
        const c = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
          auth: { persistSession: true, detectSessionInUrl: true, flowType: 'implicit', storageKey: 'tt.sb' },
        });
        session = (await c.auth.getSession()).data.session;
        c.auth.onAuthStateChange((_e, s) => {
          const was = session && session.user.id; session = s;
          if ((s && s.user.id) !== was) onSignedInChange();
        });
        sb = c;
        if (session) await onSignedInChange(true);
        return c;
      })();
      try { return await loading; } catch { loading = null; return null; }
    }
    async function onSignedInChange(quiet) {
      profile = null;
      if (session) {
        let res = await sb.from('profiles').select('display_name').eq('id', session.user.id).maybeSingle();
        if (res.error) { await new Promise((r) => setTimeout(r, 800)); res = await sb.from('profiles').select('display_name').eq('id', session.user.id).maybeSingle(); }
        profile = res.data || null;
        // the name typed before signing in: this browser's copy, or the one saved on the account (works when the link opens elsewhere)
        const meta = (session.user.user_metadata || {}).display_name;
        const pending = store.get('tt.pendingName') || (typeof meta === 'string' ? meta.trim().slice(0, 40) : '');
        if (!profile && pending && !res.error) {
          const { data: made } = await sb.from('profiles').upsert({ id: session.user.id, display_name: pending }).select('display_name').single();
          profile = made;
        }
        if (profile) { store.del('tt.pendingName'); await syncMine(); }
        if (!quiet) toast(profile ? `Signed in as ${profile.display_name}` : 'Signed in — add a display name in Settings to share reviews', 4000);
      }
      renderProfile(); refreshReviewUI();
    }
    // on sign-in: bring your shared reviews here, and share the ones you wrote on this device
    async function syncMine() {
      if (!sb || !session || !profile) return;
      const { data, error } = await sb.from('reviews').select('album_key, spotify_album_id, album_name, artist, cover_url, rating, body, updated_at').eq('user_id', session.user.id);
      if (error) return;
      const all = localAll(), remote = new Map(data.map((r) => [r.album_key, r]));
      for (const r of data) {
        const l = all[r.album_key], at = Date.parse(r.updated_at);
        if (!l || l.at < at) all[r.album_key] = { rating: r.rating, body: r.body || '', at, name: r.album_name, artist: r.artist, cover: r.cover_url ? { url: r.cover_url } : null, spotifyId: r.spotify_album_id };
      }
      localSet(all);
      const up = Object.entries(all).filter(([k, l]) => !remote.has(k) || Date.parse(remote.get(k).updated_at) < l.at);
      for (const [k, l] of up) await push(k, l);
    }
    async function push(key, l) {
      if (!sb || !session || !profile) return false;
      const { error } = await sb.from('reviews').upsert({
        user_id: session.user.id, album_key: key, spotify_album_id: l.spotifyId || null, album_name: l.name.slice(0, 300), artist: (l.artist || '').slice(0, 300),
        cover_url: coverUrl(l.cover), rating: l.rating || null, body: (l.body || '').slice(0, 2000) || null, updated_at: new Date(l.at).toISOString(),
      }, { onConflict: 'user_id,album_key' });
      return !error;
    }

    return {
      remoteOn, keyOf,
      signedIn: () => !!(session && profile),
      session: () => session, profile: () => profile, client,
      mine: (a) => localAll()[keyOf(a)] || null,
      allMine: () => Object.entries(localAll()).map(([key, r]) => ({ key, ...r })).sort((a, b) => b.at - a.at),
      async save(a, rating, body) {
        const key = keyOf(a), all = localAll();
        const l = all[key] = { rating: rating || null, body: (body || '').trim().slice(0, 2000), at: Date.now(), name: a.name, artist: a.artist, cover: a.cover && a.cover.url ? { url: a.cover.url } : a.cover || null, spotifyId: /^[A-Za-z0-9]{22}$/.test(a.id || '') ? a.id : null };
        localSet(all);
        if (!remoteOn || state.mode === 'demo') return 'local';
        await client();
        return (await push(key, l)) ? 'shared' : session ? 'local-failed' : 'local';
      },
      async remove(a) {
        const key = keyOf(a), all = localAll(); delete all[key]; localSet(all);
        if (sb && session) await sb.from('reviews').delete().eq('user_id', session.user.id).eq('album_key', key);
      },
      // everyone's reviews for one album (newest first)
      async forAlbum(a) {
        if (state.mode === 'demo') return demoFor(a).map(withDemoLikes);
        if (!remoteOn) return null;
        const c = await client(); if (!c) return null;
        const pop = await c.from('review_popularity').select('id, rating, body, updated_at, user_id, display_name, likes')
          .eq('album_key', keyOf(a)).order('likes', { ascending: false }).order('updated_at', { ascending: false }).limit(60);
        if (!pop.error) {
          const liked = await likedSet(pop.data.map((r) => r.id));
          return pop.data.map((r) => ({ id: r.id, name: r.display_name || 'Someone', rating: r.rating, body: r.body || '', at: Date.parse(r.updated_at),
            mine: !!session && r.user_id === session.user.id, likes: Number(r.likes) || 0, liked: liked.has(r.id) }));
        }
        const { data, error } = await c.from('reviews').select('id, rating, body, updated_at, user_id, profiles(display_name)')
          .eq('album_key', keyOf(a)).order('updated_at', { ascending: false }).limit(60);
        if (error) throw error;
        return data.map((r) => ({ id: r.id, name: (r.profiles && r.profiles.display_name) || 'Someone', rating: r.rating, body: r.body || '', at: Date.parse(r.updated_at), mine: !!session && r.user_id === session.user.id }));
      },
      // the latest reviews from everyone, for the record wall
      async recent() {
        if (state.mode === 'demo') {
          return Demo.albums.slice(0, 5).map((a, i) => ({ ...demoFor(a)[0], at: Date.now() - (i + 1) * 3600e3 * 7, album: { id: a.id, name: a.name, artist: a.artist, cover: a.cover } }));
        }
        if (!remoteOn) return null;
        const c = await client(); if (!c) return null;
        const { data, error } = await c.from('reviews').select('id, rating, body, updated_at, album_name, artist, cover_url, spotify_album_id, profiles(display_name)')
          .order('updated_at', { ascending: false }).limit(20);
        if (error) throw error;
        return data.map((r) => ({ id: r.id, name: (r.profiles && r.profiles.display_name) || 'Someone', rating: r.rating, body: r.body || '', at: Date.parse(r.updated_at),
          album: { id: r.spotify_album_id || `rv:${r.id}`, name: r.album_name, artist: r.artist, cover: r.cover_url ? { url: r.cover_url } : null } }));
      },
      // the Trending page: most-rated albums, highest-rated albums and the most-liked reviews
      async trending() {
        if (state.mode === 'demo') return demoTrending();
        if (!remoteOn) return null;
        const c = await client(); if (!c) return null;
        const [most, top, pop] = await Promise.all([
          c.from('album_stats').select('*').gt('ratings', 0).order('recent', { ascending: false }).order('ratings', { ascending: false }).order('last_at', { ascending: false }).limit(24),
          c.from('album_stats').select('*').gte('ratings', 2).order('avg_rating', { ascending: false }).order('ratings', { ascending: false }).limit(24),
          c.from('review_popularity').select('*').not('body', 'is', null).order('recent_likes', { ascending: false }).order('likes', { ascending: false }).order('updated_at', { ascending: false }).limit(20),
        ]);
        const err = most.error || top.error || pop.error;
        if (err) { if (missingView(err)) return { missing: true }; throw err; }
        // with only a few ratings so far, rank everything that has one
        const topRows = top.data.length ? top.data : [...most.data].sort((x, y) => Number(y.avg_rating) - Number(x.avg_rating));
        const liked = await likedSet(pop.data.map((r) => r.id));
        return {
          mostRated: most.data.map(statOf), topRated: topRows.map(statOf),
          popular: pop.data.map((r) => ({ id: r.id, name: r.display_name || 'Someone', rating: r.rating, body: r.body || '', at: Date.parse(r.updated_at),
            likes: Number(r.likes) || 0, liked: liked.has(r.id), mine: !!session && r.user_id === session.user.id, album: albumOf(r) })),
        };
      },
      // like or unlike someone's review; returns false when it couldn't be saved
      async like(id, on) {
        if (state.mode === 'demo') { if (on) demoLiked.add(id); else demoLiked.delete(id); return true; }
        if (!sb || !session || !profile) return false;
        const q = on ? sb.from('review_likes').insert({ review_id: id })
          : sb.from('review_likes').delete().eq('review_id', id).eq('user_id', session.user.id);
        const { error } = await q;
        return !error || (on && error.code === '23505'); // already liked counts as liked
      },
      async sendLink(email, name) {
        const c = await client(); if (!c) throw new Error('Community reviews aren’t set up');
        store.set('tt.pendingName', name);
        const { error } = await c.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}${location.pathname}`, data: { display_name: name } } });
        if (error) throw error;
      },
      // the code from the email, typed into this tab, signs in without opening the link
      async verifyCode(email, code) {
        const c = await client(); if (!c) throw new Error('Community reviews aren’t set up');
        const { error } = await c.auth.verifyOtp({ email, token: code, type: 'email' });
        if (error) throw error;
      },
      async setName(name) {
        if (!sb || !session) return false;
        const { data, error } = await sb.from('profiles').upsert({ id: session.user.id, display_name: name }).select('display_name').single();
        if (error) return false;
        const first = !profile; profile = data;
        if (first) await syncMine();
        return true;
      },
      async signOut() { if (sb) await sb.auth.signOut(); session = null; profile = null; renderProfile(); refreshReviewUI(); },
    };
  })();

  // ---- star helpers. Ratings are stored as half-stars (1–10) and shown as 0.5–5 stars.
  const starsHtml = (r, cls = '') => `<span class="stars ${cls}" style="--v:${(r || 0) / 2}" role="img" aria-label="${(r || 0) / 2} out of 5 stars"></span>`;
  const starLabel = (r) => `${r / 2}`.replace(/\.0$/, '');
  function starInput(value, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'star-input'; wrap.tabIndex = 0; wrap.setAttribute('role', 'slider');
    wrap.setAttribute('aria-label', 'Your rating'); wrap.setAttribute('aria-valuemin', '0'); wrap.setAttribute('aria-valuemax', '5');
    let v = value || 0;
    const paint = (x) => { wrap.style.setProperty('--v', x / 2); wrap.setAttribute('aria-valuenow', String(v / 2)); wrap.setAttribute('aria-valuetext', v ? `${starLabel(v)} stars` : 'Not rated'); };
    const set = (x) => { v = clamp(x, 0, 10); paint(v); onChange(v); };
    wrap.innerHTML = '<span class="stars big"></span>' + Array.from({ length: 10 }, (_, i) => `<button type="button" data-v="${i + 1}" tabindex="-1" aria-hidden="true"></button>`).join('');
    wrap.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) set(Number(b.dataset.v) === v ? 0 : Number(b.dataset.v)); });
    wrap.addEventListener('pointerover', (e) => { const b = e.target.closest('button[data-v]'); if (b) paint(Number(b.dataset.v)); });
    wrap.addEventListener('pointerleave', () => paint(v));
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); set(v + 1); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); set(v - 1); }
    });
    paint(v);
    return wrap;
  }

  // ---- the reviews panel (works for the album playing, or any album from the wall)
  const rv = { album: null, req: 0 };
  $('rvBody').addEventListener('click', (e) => {
    const lk = e.target.closest('[data-like]'); if (!lk) return;
    const r = (rv.others || [])[Number(lk.dataset.like)]; if (r) toggleLike(r, lk);
  });
  function openReviews(album) {
    if (!album) return;
    rv.album = album;
    renderReviews();
    openPanel($('reviewsPanel'));
  }
  function renderReviews() {
    const a = rv.album; if (!a) return;
    const req = ++rv.req;
    $('rvCover').style.backgroundImage = a.cover ? coverCss(a.cover) : '';
    $('rvTitle').textContent = a.name;
    $('rvSub').textContent = [a.artist, a.year].filter(Boolean).join(' · ');
    const mine = Reviews.mine(a);
    let draft = { rating: mine ? mine.rating || 0 : 0, body: mine ? mine.body || '' : '' };
    const who = state.mode === 'demo' ? 'Demo mode — saved on this device only.'
      : Reviews.signedIn() ? `Shown publicly as <b>${esc(Reviews.profile().display_name)}</b>.`
      : Reviews.remoteOn ? 'Only on this device until you sign in (Settings → Profile &amp; reviews).'
      : 'Saved on this device.';
    const body = $('rvBody');
    body.innerHTML = `<h4>Your review</h4>
      <div class="rv-mine"><div id="rvStars"></div>
        <textarea id="rvText" rows="4" maxlength="2000" placeholder="What do you think of this record?">${esc(draft.body)}</textarea>
        <div class="row"><button class="btn primary" id="rvSave">${mine ? 'Update review' : 'Save review'}</button>${mine ? '<button class="btn" id="rvDelete">Delete</button>' : ''}</div>
        <p class="vp-fine">${who}</p></div>
      <h4>From other listeners</h4><div id="rvCommunity"><p class="vp-note">Loading reviews…</p></div>`;
    $('rvStars').append(starInput(draft.rating, (v) => { draft.rating = v; }));
    $('rvSave').onclick = async () => {
      draft.body = $('rvText').value;
      if (!draft.rating && !draft.body.trim()) { toast('Pick a star rating or write a few words first'); return; }
      $('rvSave').disabled = true;
      const res = await Reviews.save(a, draft.rating, draft.body);
      toast(res === 'shared' ? 'Review shared' : res === 'local-failed' ? 'Saved here — couldn’t reach the review server, will retry next sign-in' : 'Review saved');
      refreshReviewUI();
    };
    const del = $('rvDelete');
    if (del) del.onclick = async () => { await Reviews.remove(a); toast('Review deleted'); refreshReviewUI(); };
    // community
    Reviews.forAlbum(a).then((list) => {
      if (req !== rv.req) return;
      const box = $('rvCommunity');
      if (list == null) { box.innerHTML = '<p class="vp-note">Only you can see your reviews for now. Reviews from other listeners show up here once community reviews are switched on.</p>'; return; }
      const others = list.filter((r) => !r.mine && !(state.mode === 'demo' && false));
      const rated = list.filter((r) => r.rating);
      const avg = rated.length ? rated.reduce((s, r) => s + r.rating, 0) / rated.length : 0;
      let h = rated.length ? `<div class="rv-avg">${starsHtml(Math.round(avg), 'big')}<span><b>${(avg / 2).toFixed(1)}</b> from ${rated.length} rating${rated.length === 1 ? '' : 's'}</span></div>` : '';
      rv.others = others;
      h += others.length ? `<ul class="notes rv-list">${others.map((r, i) => `<li class="note"><div><div class="note-meta"><b>${esc(r.name)}</b> · ${esc(noteDate(r.at))}</div>
          ${r.rating ? starsHtml(r.rating) : ''}${r.body ? `<p>${esc(r.body)}</p>` : ''}${r.likes != null && r.body ? likeBtn(r, i, 'panel') : ''}</div></li>`).join('')}</ul>`
        : '<p class="vp-note">No one else has reviewed this one yet. Be the first.</p>';
      box.innerHTML = h;
    }).catch(() => { if (req === rv.req) $('rvCommunity').innerHTML = '<p class="vp-note">Couldn’t load reviews right now.</p>'; });
  }
  // keep the pill, the panel and the wall in step after a change
  function refreshReviewUI() {
    renderRatePill();
    if ($('reviewsPanel').classList.contains('open')) renderReviews();
    trend.at = 0;
    if (wallOpen() && (lib.tab === 'vinyl' || lib.tab === 'trending')) renderWall();
  }
  function renderRatePill() {
    const a = state.album, mine = a ? Reviews.mine(a) : null;
    $('rateBtn').classList.toggle('hidden', !a);
    $('rateText').textContent = mine && mine.rating ? starLabel(mine.rating) : mine ? 'Reviewed' : 'Rate';
    $('rateBtn').classList.toggle('rated', !!(mine && mine.rating));
  }
  $('rateBtn').onclick = () => { if (state.album) openReviews(state.album); };

  // ---- settings: profile / sign-in
  const emailSender = () => ((window.TVS_CONFIG || {}).emailSender || 'Supabase Auth');
  let codeFor = ''; // the email a sign-in code was just sent to
  let sentUntil = 0, sentTimer = 0; // after sending, the button reads "Sent" and waits 10 seconds
  function renderProfile() {
    const st = $('profileStatus'), form = $('profileForm');
    if (state.mode === 'demo') { st.textContent = 'Demo mode — reviews are saved on this device, and other listeners’ reviews are made up.'; form.classList.add('hidden'); return; }
    if (!Reviews.remoteOn) { st.textContent = 'Your ratings and reviews are saved on this device. Sharing reviews with other listeners isn’t switched on for this app yet.'; form.classList.add('hidden'); return; }
    form.classList.remove('hidden');
    const s = Reviews.session(), p = Reviews.profile();
    $('profileEmailWrap').classList.toggle('hidden', !!s);
    $('profileCodeWrap').classList.toggle('hidden', !!s || !codeFor);
    if (s) codeFor = '';
    $('profileOut').classList.toggle('hidden', !s);
    const wait = s ? 0 : Math.ceil((sentUntil - Date.now()) / 1000);
    $('profileGo').textContent = s ? 'Save name' : wait > 0 ? `Sent · ${wait}s` : codeFor ? 'Send a new code' : 'Email me a sign-in link';
    $('profileGo').classList.toggle('primary', !!s || !codeFor);
    $('profileGo').classList.toggle('sent', wait > 0);
    $('profileGo').disabled = wait > 0;
    if (s) { st.innerHTML = p ? `Signed in as <b>${esc(p.display_name)}</b> (${esc(s.user.email || '')}). Your reviews are shared.` : `Signed in as ${esc(s.user.email || '')}. Pick a display name to share your reviews.`; $('profileName').value = p ? p.display_name : ''; }
    else st.innerHTML = `Sign in to share your reviews and read other listeners’. We’ll email you a link and a code — no password. Look for an email from <b>${esc(emailSender())}</b>.`;
  }
  $('profileGo').onclick = async () => {
    const name = $('profileName').value.trim();
    if (!name) { toast('Pick a display name'); return; }
    if (Reviews.session()) { toast(await Reviews.setName(name) ? 'Name saved' : 'Couldn’t save your name'); renderProfile(); refreshReviewUI(); return; }
    const email = $('profileEmail').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Enter your email address'); return; }
    $('profileGo').disabled = true;
    try {
      await Reviews.sendLink(email, name); codeFor = email;
      sentUntil = Date.now() + 10000; clearInterval(sentTimer);
      sentTimer = setInterval(() => { renderProfile(); if (Date.now() >= sentUntil) clearInterval(sentTimer); }, 250);
      renderProfile();
      toast(`Sent to ${email}. Look for an email from ${emailSender()} (check spam too).`, 8000);
      $('profileCode').value = ''; $('profileCode').focus();
    } catch (e) { toast(`Couldn’t send the link: ${e.message || 'try again'}`, 6000); $('profileGo').disabled = false; }
  };
  async function submitCode() {
    const code = $('profileCode').value.replace(/\D/g, '');
    if (code.length < 6) { toast('Enter the code from the email'); return; }
    $('profileCodeGo').disabled = true;
    try { await Reviews.verifyCode(codeFor, code); }
    catch (e) { toast(/expired|invalid/i.test(e.message || '') ? 'That code didn’t work — it may have expired. Send a new one.' : `Couldn’t sign in: ${e.message || 'try again'}`, 6000); }
    $('profileCodeGo').disabled = false;
  }
  $('profileCodeGo').onclick = submitCode;
  $('profileCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitCode(); } });
  $('profileOut').onclick = async () => { await Reviews.signOut(); toast('Signed out'); };
  // finish a sign-in link, or restore an earlier session
  if (Reviews.remoteOn && (/access_token=|error_description=/.test(location.hash) || store.get('tt.sb'))) Reviews.client().then(renderProfile);

  // ================================================================ background scenes: Home, Vinyl room, Party, Skyline
  const SCENES = [['home', 'Home', 'linear-gradient(160deg,#fbe8c6 0 22%,#5c4838 22% 70%,#30241c 70%)'],
    ['vinyl', 'Vinyl room', 'linear-gradient(160deg,#2f3a33 0 30%,#b98a5c 30% 34%,#3a463e 34% 70%,#5a3b28 70%)'],
    ['party', 'Party', 'conic-gradient(from 200deg at 50% 10%,#ff4fa3,#3a1f4a 18%,#4fc3ff 30%,#0b0710 45%,#ff4fa3 60%,#0b0710 75%)'],
    ['skyline', 'Skyline', 'linear-gradient(180deg,#0b1330 0,#2a2a5a 55%,#6b4a6e 72%,#141118 72%)']];
  function setScene(id) {
    if (!SCENES.some(([s]) => s === id)) id = 'home';
    document.querySelectorAll('.room[data-scene]').forEach((r) => r.classList.toggle('on', r.dataset.scene === id));
    document.body.dataset.scene = id; store.set('tt.scene', id);
    document.querySelectorAll('.scene-opt').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.scene === id)));
  }
  $('scenes').innerHTML = SCENES.map(([id, name, bg]) =>
    `<button class="scene-opt" role="radio" data-scene="${id}" aria-checked="false"><i style="background:${bg}"></i>${name}</button>`).join('');
  $('scenes').setAttribute('role', 'radiogroup');
  $('scenes').addEventListener('click', (e) => { const b = e.target.closest('.scene-opt'); if (b) setScene(b.dataset.scene); });
  setScene(store.get('tt.scene') || 'home');

  (function buildScenes() {
    const R = rng(7), NS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs, parent) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); parent.append(n); return n; };
    const covers = ['#c0874f', '#2f4a3e', '#d9c7a5', '#5b6b8a', '#8a4f63', '#e2b65f', '#1f2b38', '#c9a99a', '#b5643c', '#6f7d5a', '#efe6d6', '#7a3b2e', '#3c6e8f', '#d4573b', '#9bb59a'];
    // vinyl room: a pegboard of face-out records, and crates on the floor
    const wall = $('vrWallRecords');
    for (let row = 0; row < 3; row++) for (let col = 0; col < 11; col++) {
      const x = 110 + col * 128, y = 180 + row * 145;
      if (x > 690 && x < 900 && row < 2) continue;                // room for the record that's playing
      el('rect', { x, y, width: 112, height: 112, fill: covers[Math.floor(R() * covers.length)], opacity: (.75 + R() * .25).toFixed(2) }, wall);
      if (R() < .5) el('circle', { cx: x + 56, cy: y + 56, r: 18 + R() * 26, fill: covers[Math.floor(R() * covers.length)], opacity: .8 }, wall);
      el('rect', { x: x - 4, y: y + 112, width: 120, height: 5, fill: '#1b130d' }, wall);
    }
    const crates = $('vrCrates');
    for (let i = 0; i < 6; i++) {
      const x = 70 + i * 250, y = 760;
      for (let k = 0; k < 14; k++) el('rect', { x: x + 8 + k * 14, y: y - 40 - R() * 30, width: 11, height: 110, fill: covers[Math.floor(R() * covers.length)] }, crates);
      el('rect', { x, y, width: 220, height: 130, rx: 4, fill: 'url(#vrCrate)' }, crates);
      el('rect', { x: x + 70, y: y + 30, width: 80, height: 18, rx: 9, fill: '#5a3b26' }, crates);
    }
    // party: bulbs on the string, sparkles off the mirror ball
    const bulbs = $('ptBulbs'), cols = ['#ffd27a', '#ff6fb1', '#7fd6ff', '#b6ff8a'];
    for (let i = 0; i <= 32; i++) {
      const x = i * 50, y = 44 + 26 * Math.sin((i / 32) * Math.PI * 4) ** 2;
      el('circle', { cx: x, cy: y + 10, r: 7, fill: cols[i % cols.length], class: 'pt-bulb', style: `animation-delay:${(R() * 3).toFixed(2)}s` }, bulbs);
    }
    const sp = $('ptSparkles');
    for (let i = 0; i < 70; i++) {
      el('circle', { cx: (R() * 1600).toFixed(0), cy: (140 + R() * 620).toFixed(0), r: (1.5 + R() * 3).toFixed(1), fill: '#fff', class: 'pt-sparkle', style: `animation-delay:${(R() * 4).toFixed(2)}s` }, sp);
    }
    // skyline: stars, then buildings with lit windows
    const stars = $('skStars');
    for (let i = 0; i < 90; i++) el('circle', { cx: (R() * 1360).toFixed(0), cy: (R() * 300).toFixed(0), r: (R() * 1.6 + .4).toFixed(1), fill: '#fff', opacity: (.3 + R() * .6).toFixed(2), class: R() < .3 ? 'sk-twinkle' : '' , style: `animation-delay:${(R() * 5).toFixed(2)}s` }, stars);
    const city = $('skCity');
    for (const [layer, shade, hMin, hMax] of [[0, '#2a2547', 140, 300], [1, '#191632', 180, 400], [2, '#0f0d22', 120, 260]]) {
      let x = -20;
      while (x < 1380) {
        const w = 50 + R() * 110, h = hMin + R() * (hMax - hMin), top = 700 - h;
        el('rect', { x: x.toFixed(0), y: top.toFixed(0), width: w.toFixed(0), height: h.toFixed(0), fill: shade }, city);
        if (layer && R() < .25) el('rect', { x: (x + w / 2 - 2).toFixed(0), y: (top - 40).toFixed(0), width: 4, height: 40, fill: shade }, city);
        if (layer) for (let wy = top + 14; wy < 690; wy += 22) for (let wx = x + 10; wx < x + w - 12; wx += 18) {
          if (R() < .32) el('rect', { x: wx.toFixed(0), y: wy.toFixed(0), width: 8, height: 11, fill: R() < .8 ? '#ffd98f' : '#bfe0ff', opacity: (.45 + R() * .5).toFixed(2), class: R() < .06 ? 'sk-win' : '', style: `animation-delay:${(R() * 20).toFixed(1)}s` }, city);
        }
        x += w + (layer === 2 ? 30 + R() * 60 : 4);
      }
    }
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
      Discogs.maybeAutoSync();
      if (justLoggedIn) toast('Connected to Spotify');
    } else if (store.get(LS.mode) === 'demo' || params.has('demo')) {
      startDemo();
    } else {
      onTrackChange();
      openSetup();
    }
  })();
})();
