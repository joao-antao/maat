/*
 * Metronome
 *
 * Timing: setTimeout/setInterval alone drift by many milliseconds, which you
 * can hear. Instead, a small timer wakes up every 25 ms and schedules the
 * next ~100 ms of clicks on the Web Audio clock, which is sample-accurate.
 * The pendulum and beat dots are drawn from that same clock, so sound and
 * picture stay in sync.
 */
(() => {
  'use strict';

  const MIN_BPM = 30;
  const MAX_BPM = 250;
  const MIN_BEATS = 1;
  const MAX_BEATS = 12;
  const LOOKAHEAD_MS = 25;     // how often the scheduler wakes up
  const SCHEDULE_AHEAD = 0.1;  // seconds of audio scheduled in advance
  const MAX_ANGLE = 22;        // pendulum swing in degrees
  const STORAGE_KEY = 'metronome-settings';

  const TEMPO_NAMES = [
    [40, 'Grave'], [60, 'Largo'], [66, 'Larghetto'], [76, 'Adagio'],
    [108, 'Andante'], [120, 'Moderato'], [156, 'Allegro'],
    [176, 'Vivace'], [200, 'Presto'], [Infinity, 'Prestissimo'],
  ];
  const ACCENT_ORDER = ['strong', 'normal', 'mute'];
  const ACCENT_LABEL = { strong: 'accented', normal: 'normal', mute: 'silent' };

  /*
   * Subdivisions. Each one is a rhythm that fills exactly one beat, written as
   * note values: 4 = quarter, 8 = eighth, 16 = sixteenth (optionally dotted).
   * The click times are worked out from the note lengths and stretched or
   * squeezed to fill the beat, which also handles tuplets (3 eighths in the
   * space of 2, 5 or 6 sixteenths in the space of 4). To add your own rhythm,
   * add a line here; its icon is drawn automatically.
   */
  const N = (v, dot = false) => ({ v, dot });
  const SUBDIVISIONS = [
    { id: 'quarter', name: 'Quarter notes', notes: [N(4)] },
    { id: 'eighths', name: 'Eighth notes', notes: [N(8), N(8)] },
    { id: 'triplets', name: 'Eighth-note triplets', notes: [N(8), N(8), N(8)], tuplet: 3 },
    { id: 'sixteenths', name: 'Sixteenth notes', notes: [N(16), N(16), N(16), N(16)] },
    { id: 'quintuplets', name: 'Quintuplets', notes: Array(5).fill(N(16)), tuplet: 5 },
    { id: 'sextuplets', name: 'Sextuplets', notes: Array(6).fill(N(16)), tuplet: 6 },
    { id: 'shuffle', name: 'Triplet shuffle', notes: [N(4), N(8)], tuplet: 3 },
    { id: 'dotted', name: 'Dotted eighth and sixteenth', notes: [N(8, true), N(16)] },
    { id: 'gallop', name: 'Eighth and two sixteenths', notes: [N(8), N(16), N(16)] },
    { id: 'reverse-gallop', name: 'Two sixteenths and eighth', notes: [N(16), N(16), N(8)] },
    { id: 'syncopated', name: 'Sixteenth, eighth, sixteenth', notes: [N(16), N(8), N(16)] },
  ];

  const NOTE_LENGTH = { 4: 1, 8: 0.5, 16: 0.25 };
  SUBDIVISIONS.forEach((sub) => {
    const lengths = sub.notes.map((note) => NOTE_LENGTH[note.v] * (note.dot ? 1.5 : 1));
    const total = lengths.reduce((a, b) => a + b, 0);
    let position = 0;
    // offsets: where each click falls, as a fraction of the beat (0 = on the beat)
    sub.offsets = lengths.map((len) => {
      const at = position / total;
      position += len;
      return at;
    });
  });

  const subById = (id) => SUBDIVISIONS.find((s) => s.id === id) || SUBDIVISIONS[0];
  const LEGACY_SUBS = { 1: 'quarter', 2: 'eighths', 3: 'triplets', 4: 'sixteenths' };

  const $ = (id) => document.getElementById(id);
  const els = {
    arm: $('arm'),
    weight: $('weight'),
    bpm: $('bpm-value'),
    tempoName: $('tempo-name'),
    slider: $('bpm-slider'),
    slower: $('slower'),
    faster: $('faster'),
    beats: $('beats'),
    beatsValue: $('beats-value'),
    fewerBeats: $('fewer-beats'),
    moreBeats: $('more-beats'),
    subs: $('subdivisions'),
    subName: $('sub-name'),
    volume: $('volume'),
    toggle: $('toggle'),
    tap: $('tap'),
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- Settings ---------- */

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function defaultAccents(n) {
    return Array.from({ length: n }, (_, i) => (i === 0 ? 'strong' : 'normal'));
  }

  function resizeAccents(list, n) {
    return Array.from({ length: n }, (_, i) =>
      ACCENT_ORDER.includes(list[i]) ? list[i] : 'normal');
  }

  function loadSettings() {
    const defaults = { bpm: 100, beats: 4, sub: 'quarter', volume: 0.8, accents: defaultAccents(4) };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || typeof saved !== 'object') return defaults;
      const beats = clamp(Math.round(Number(saved.beats)) || 4, MIN_BEATS, MAX_BEATS);
      const volume = Number(saved.volume);
      return {
        bpm: clamp(Math.round(Number(saved.bpm)) || defaults.bpm, MIN_BPM, MAX_BPM),
        beats,
        sub: subById(LEGACY_SUBS[saved.sub] || saved.sub).id,
        volume: Number.isFinite(volume) ? clamp(volume, 0, 1) : defaults.volume,
        accents: Array.isArray(saved.accents)
          ? resizeAccents(saved.accents, beats)
          : defaultAccents(beats),
      };
    } catch {
      return defaults;
    }
  }

  function saveSettings() {
    try {
      const { bpm, beats, sub, volume, accents } = state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ bpm, beats, sub, volume, accents }));
    } catch {
      /* Storage can be unavailable (private mode); settings just won't persist. */
    }
  }

  const state = { ...loadSettings(), running: false };

  /* ---------- Audio ---------- */

  let audioCtx = null;
  let masterGain = null;

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = state.volume;
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  // A short, woody click: a sine burst with a fast exponential decay.
  function playClick(time, kind) {
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();
    const freq = { strong: 1600, normal: 1050, sub: 750 }[kind];
    const peak = kind === 'sub' ? 0.35 : 1;

    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(peak, time + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);

    osc.connect(env).connect(masterGain);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  /* ---------- Scheduler ---------- */

  let beatStartTime = 0;  // audio time at which the current beat starts
  let currentBeat = 0;    // position in the bar
  let noteIndex = 0;      // position in the subdivision rhythm
  let beatCount = 0;      // total beats since start; drives pendulum direction
  const queue = [];       // beats scheduled but not yet drawn
  let lastBeat = null;

  function scheduleNote(beat, index, time) {
    const accent = state.accents[beat] || 'normal';
    if (accent === 'mute') {
      // A silent beat also silences its subdivisions.
    } else if (index === 0) {
      playClick(time, accent);
    } else {
      playClick(time, 'sub');
    }
    if (index === 0) queue.push({ time, beat, count: beatCount++ });
  }

  function scheduler() {
    if (!state.running) return;
    const horizon = audioCtx.currentTime + SCHEDULE_AHEAD;

    for (;;) {
      const offsets = subById(state.sub).offsets;
      const beatLength = 60 / state.bpm;

      // Finished this beat's rhythm: move to the next beat.
      if (noteIndex >= offsets.length) {
        beatStartTime += beatLength;
        noteIndex = 0;
        currentBeat = (currentBeat + 1) % state.beats;
      }

      const time = beatStartTime + offsets[noteIndex] * beatLength;
      if (time >= horizon) break;
      scheduleNote(currentBeat, noteIndex, time);
      noteIndex += 1;
    }
  }

  // Run the timer in a Web Worker so it keeps going when the tab is in the
  // background (main-thread timers get throttled there).
  let worker = null;
  let fallbackTimer = null;
  try {
    const src = `let id = null;
      onmessage = (e) => {
        if (e.data === 'start') { clearInterval(id); id = setInterval(() => postMessage('tick'), ${LOOKAHEAD_MS}); }
        if (e.data === 'stop') { clearInterval(id); id = null; }
      };`;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = scheduler;
  } catch {
    worker = null;
  }

  function startTimer() {
    if (worker) worker.postMessage('start');
    else fallbackTimer = setInterval(scheduler, LOOKAHEAD_MS);
  }

  function stopTimer() {
    if (worker) worker.postMessage('stop');
    clearInterval(fallbackTimer);
  }

  /* ---------- Drawing ---------- */

  let rafId = 0;

  function setArm(angle) {
    els.arm.style.transform = `rotate(${angle}deg)`;
  }

  function highlightBeat(index) {
    const dots = els.beats.children;
    for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('active', i === index);
  }

  function draw() {
    if (!state.running) return;
    const now = audioCtx.currentTime;

    while (queue.length && queue[0].time <= now) {
      lastBeat = queue.shift();
      highlightBeat(lastBeat.beat);
    }

    // The pendulum reaches the end of its swing exactly on each beat.
    if (lastBeat && !reduceMotion.matches) {
      const beatLength = 60 / state.bpm;
      const progress = Math.min((now - lastBeat.time) / beatLength, 1);
      const side = lastBeat.count % 2 === 0 ? 1 : -1;
      setArm(MAX_ANGLE * side * Math.cos(Math.PI * progress));
    }

    rafId = requestAnimationFrame(draw);
  }

  /* ---------- Start / stop ---------- */

  function start() {
    ensureAudio();
    state.running = true;
    currentBeat = 0;
    noteIndex = 0;
    beatCount = 0;
    queue.length = 0;
    lastBeat = null;
    beatStartTime = audioCtx.currentTime + 0.08;

    els.arm.classList.remove('resting');
    if (!reduceMotion.matches) setArm(MAX_ANGLE);

    scheduler();
    startTimer();
    rafId = requestAnimationFrame(draw);

    els.toggle.textContent = 'Stop';
    els.toggle.setAttribute('aria-pressed', 'true');
  }

  function stop() {
    state.running = false;
    stopTimer();
    cancelAnimationFrame(rafId);
    queue.length = 0;

    els.arm.classList.add('resting');
    setArm(0);
    highlightBeat(-1);

    els.toggle.textContent = 'Start';
    els.toggle.setAttribute('aria-pressed', 'false');
  }

  function toggle() {
    if (state.running) stop();
    else start();
  }

  /* ---------- Controls ---------- */

  function tempoName(bpm) {
    return TEMPO_NAMES.find(([limit]) => bpm < limit)[1];
  }

  function setBpm(value) {
    const bpm = clamp(Math.round(value), MIN_BPM, MAX_BPM);
    state.bpm = bpm;
    els.bpm.textContent = bpm;
    els.slider.value = bpm;
    els.tempoName.textContent = tempoName(bpm);
    // Like a real metronome: weight high on the rod = slow, low = fast.
    const y = 40 + ((bpm - MIN_BPM) / (MAX_BPM - MIN_BPM)) * 160;
    els.weight.style.transform = `translate(100px, ${y}px)`;
    saveSettings();
  }

  function renderBeats() {
    els.beats.replaceChildren(...state.accents.map((accent, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'beat';
      dot.dataset.accent = accent;
      dot.setAttribute('aria-label', `Beat ${i + 1}, ${ACCENT_LABEL[accent]}`);
      dot.addEventListener('click', () => cycleAccent(i));
      return dot;
    }));
    els.beatsValue.textContent = state.beats;
    els.fewerBeats.disabled = state.beats <= MIN_BEATS;
    els.moreBeats.disabled = state.beats >= MAX_BEATS;
  }

  function cycleAccent(i) {
    const next = ACCENT_ORDER[(ACCENT_ORDER.indexOf(state.accents[i]) + 1) % ACCENT_ORDER.length];
    state.accents[i] = next;
    const dot = els.beats.children[i];
    dot.dataset.accent = next;
    dot.setAttribute('aria-label', `Beat ${i + 1}, ${ACCENT_LABEL[next]}`);
    saveSettings();
  }

  function setBeats(n) {
    const beats = clamp(n, MIN_BEATS, MAX_BEATS);
    if (beats === state.beats) return;
    state.beats = beats;
    state.accents = resizeAccents(state.accents, beats);
    if (currentBeat >= beats) currentBeat = 0;
    renderBeats();
    saveSettings();
  }

  /*
   * Draws a rhythm in music notation as a small SVG: noteheads with stems up,
   * beams for groups of eighths and sixteenths, a flag on an unbeamed eighth,
   * augmentation dots, and the tuplet number (with a bracket when unbeamed).
   */
  function noteIcon(sub) {
    const HEAD_Y = 31;
    const STEM_TOP = 11;
    const STEM_DX = 3.7;
    const gap = sub.notes.length > 4 ? 10 : 11;
    const last = sub.notes.length - 1;

    const xs = [];
    let x = 6;
    sub.notes.forEach((note) => { xs.push(x); x += gap + (note.dot ? 4 : 0); });
    const width = xs[last] + 10;
    const stemX = (i) => xs[i] + STEM_DX;
    const beamed = sub.notes.length > 1 && sub.notes.every((note) => note.v >= 8);

    const beam = (x1, x2, y) => {
      const left = Math.min(x1, x2) - 0.6;
      return `<rect x="${left}" y="${y}" width="${Math.abs(x2 - x1) + 1.2}" height="2.6"/>`;
    };

    const parts = [];
    sub.notes.forEach((note, i) => {
      parts.push(`<ellipse cx="${xs[i]}" cy="${HEAD_Y}" rx="4.2" ry="3" transform="rotate(-20 ${xs[i]} ${HEAD_Y})"/>`);
      parts.push(`<line x1="${stemX(i)}" y1="${HEAD_Y - 1}" x2="${stemX(i)}" y2="${STEM_TOP}" stroke="currentColor" stroke-width="1.2"/>`);
      if (note.dot) parts.push(`<circle cx="${xs[i] + 7.5}" cy="${HEAD_Y - 1}" r="1.3"/>`);
      if (!beamed && note.v === 8) {
        parts.push(`<path d="M${stemX(i)} ${STEM_TOP} q0.5 5 5 7.5 q2 2.5 -0.5 8" fill="none" stroke="currentColor" stroke-width="1.3"/>`);
      }
    });

    if (beamed) {
      parts.push(beam(stemX(0), stemX(last), STEM_TOP));
      // Second beam for sixteenths: joined between neighbours, a short stub otherwise.
      sub.notes.forEach((note, i) => {
        if (note.v !== 16) return;
        const next16 = sub.notes[i + 1] && sub.notes[i + 1].v === 16;
        const prev16 = sub.notes[i - 1] && sub.notes[i - 1].v === 16;
        if (next16) parts.push(beam(stemX(i), stemX(i + 1), STEM_TOP + 4.5));
        else if (!prev16) parts.push(beam(stemX(i), stemX(i) + (i === last ? -5 : 5), STEM_TOP + 4.5));
      });
    }

    if (sub.tuplet) {
      const mid = (stemX(0) + stemX(last)) / 2;
      const text = `<text x="${mid}" y="8" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-weight="700" font-size="8.5">${sub.tuplet}</text>`;
      if (!beamed) {
        const y = 5.5;
        parts.push(`<path d="M${xs[0] - 2} ${y + 3} V${y} H${mid - 4} M${mid + 4} ${y} H${stemX(last) + 2} V${y + 3}" fill="none" stroke="currentColor" stroke-width="1"/>`);
      }
      parts.push(text);
    }

    return `<svg class="note-icon" viewBox="0 0 ${width} 38" fill="currentColor" aria-hidden="true">${parts.join('')}</svg>`;
  }

  function renderSubdivisions() {
    els.subs.replaceChildren(...SUBDIVISIONS.map((sub) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sub';
      btn.dataset.sub = sub.id;
      btn.title = sub.name;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-label', sub.name);
      btn.innerHTML = noteIcon(sub);
      btn.addEventListener('click', () => setSub(sub.id));
      return btn;
    }));
  }

  function setSub(id) {
    const sub = subById(id);
    state.sub = sub.id;
    for (const btn of els.subs.children) {
      const selected = btn.dataset.sub === sub.id;
      btn.setAttribute('aria-checked', String(selected));
      btn.tabIndex = selected ? 0 : -1;   // arrow keys move between tiles
    }
    els.subName.textContent = sub.name;
    saveSettings();
  }

  els.subs.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = SUBDIVISIONS.findIndex((s) => s.id === state.sub);
    const next = SUBDIVISIONS[(i + step + SUBDIVISIONS.length) % SUBDIVISIONS.length];
    setSub(next.id);
    els.subs.querySelector(`[data-sub="${next.id}"]`).focus();
  });

  function setVolume(v) {
    state.volume = clamp(v, 0, 1);
    els.volume.value = Math.round(state.volume * 100);
    if (masterGain) masterGain.gain.setTargetAtTime(state.volume, audioCtx.currentTime, 0.02);
    saveSettings();
  }

  // Tap tempo: average the last few intervals; a 2-second pause starts over.
  let taps = [];
  function tap() {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length > 6) taps.shift();
    if (taps.length >= 2) {
      const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      setBpm(60000 / avg);
    }
    els.tap.classList.add('tapped');
    setTimeout(() => els.tap.classList.remove('tapped'), 120);
  }

  // Press and hold − / + to keep changing the value.
  function holdToRepeat(button, action) {
    let delay = 0;
    let repeat = 0;
    const end = () => { clearTimeout(delay); clearInterval(repeat); };
    button.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      action();
      delay = setTimeout(() => { repeat = setInterval(action, 70); }, 400);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => button.addEventListener(ev, end));
    button.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action(); }
    });
  }

  holdToRepeat(els.slower, () => setBpm(state.bpm - 1));
  holdToRepeat(els.faster, () => setBpm(state.bpm + 1));
  holdToRepeat(els.fewerBeats, () => setBeats(state.beats - 1));
  holdToRepeat(els.moreBeats, () => setBeats(state.beats + 1));

  els.slider.addEventListener('input', () => setBpm(Number(els.slider.value)));
  els.volume.addEventListener('input', () => setVolume(Number(els.volume.value) / 100));
  els.toggle.addEventListener('click', toggle);
  els.tap.addEventListener('click', tap);

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const onButton = e.target.tagName === 'BUTTON';
    const onSlider = e.target.type === 'range';

    if (e.code === 'Space' && !onButton) {
      e.preventDefault();
      toggle();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !onSlider) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      setBpm(state.bpm + (e.key === 'ArrowUp' ? step : -step));
    } else if (e.key === 't' || e.key === 'T') {
      tap();
    }
  });

  /* ---------- Theme toggle ---------- */

  // Auto follows the device setting; Light and Dark override it.
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_KEY = 'metronome-theme';
  const THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  const THEME_ICON = {
    auto: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/>'
      + '<path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
    light: '<circle cx="12" cy="12" r="4" fill="currentColor"/>'
      + '<g stroke="currentColor" stroke-width="2" stroke-linecap="round">'
      + '<line x1="12" y1="2" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="22"/>'
      + '<line x1="2" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="22" y2="12"/>'
      + '<line x1="4.9" y1="4.9" x2="6.7" y2="6.7"/><line x1="17.3" y1="17.3" x2="19.1" y2="19.1"/>'
      + '<line x1="4.9" y1="19.1" x2="6.7" y2="17.3"/><line x1="17.3" y1="6.7" x2="19.1" y2="4.9"/></g>',
    dark: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" fill="currentColor"/>',
  };

  const themeToggle = $('theme-toggle');
  const themeIcon = $('theme-icon');
  const themeLabel = $('theme-label');

  function loadTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return THEMES.includes(saved) ? saved : 'auto';
    } catch {
      return 'auto';
    }
  }

  function applyTheme(theme) {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;

    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    const description = theme === 'auto' ? 'Auto, follows your device' : THEME_LABEL[theme];
    themeIcon.innerHTML = THEME_ICON[theme];
    themeLabel.textContent = THEME_LABEL[theme];
    themeToggle.setAttribute('aria-label', `Theme: ${description}. Switch to ${THEME_LABEL[next].toLowerCase()}.`);
    themeToggle.title = `Theme: ${description}`;
  }

  let theme = loadTheme();
  applyTheme(theme);

  themeToggle.addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* not saved; still applied */ }
    applyTheme(theme);
  });

  /* ---------- Initial render ---------- */
  setBpm(state.bpm);
  renderBeats();
  renderSubdivisions();
  setSub(state.sub);
  setVolume(state.volume);
})();
