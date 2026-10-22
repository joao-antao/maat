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

  /*
   * Drum grooves. Each drum gets a step grid, one character per step:
   *   X = loud, x = normal, g = ghost note (very soft), . = rest
   * The | marks the beats and is only there for readability.
   * steps: 4 = sixteenth-note grid, 3 = triplet grid (for swing and shuffle).
   * swing: on a sixteenth grid, delays every second sixteenth by this
   *        fraction of a beat, for a laid-back feel.
   * A drum's grid can be one bar or several; shorter grids simply repeat.
   * To add a groove, add an entry here; it appears in the list automatically.
   * Drums: kick, snare, rim (cross-stick), hat, open (open hi-hat), ride, crash.
   */
  const GROOVES = [
    {
      id: 'rock', name: 'Rock', about: 'Straight eighths, backbeat on 2 and 4',
      beats: 4, steps: 4,
      parts: {
        hat:   'X.x.|X.x.|X.x.|X.x.',
        snare: '....|X...|....|X...',
        kick:  'X...|....|X.x.|....',
      },
    },
    {
      // John Bonham on Led Zeppelin's "When the Levee Breaks" (1971): kick on
      // "1 e" (the "e" soft), the "a" of 2 and the "and" of 3; snare on 2 and 4,
      // each followed by a ghost note; eighths on a loose, sloshy hi-hat.
      id: 'rock-bonham', name: 'Bonham’s rock', tempo: 70,
      about: 'John Bonham’s heavy beat from Led Zeppelin’s “When the Levee Breaks”',
      beats: 4, steps: 4, swing: 0.04,
      parts: {
        hat:   'X.x.|X.x.|X.x.|X.x.',
        open:  '..g.|..g.|..g.|..g.',
        snare: '....|Xg..|....|Xg..',
        kick:  'Xx..|...X|..X.|....',
      },
    },
    {
      id: 'pop', name: 'Pop', tempo: 108,
      about: 'Steady eighths with a pushed kick and an open hi-hat lift',
      beats: 4, steps: 4,
      parts: {
        hat:   'X.x.|X.x.|X.x.|X.x.|X.x.|X.x.|X.x.|X...',
        open:  '....|....|....|....|....|....|....|..x.',
        snare: '....|X...|....|X...',
        kick:  'X...|..x.|X...|....|X...|..x.|X.x.|..x.',
      },
    },
    {
      id: 'shuffle', name: 'Shuffle', about: 'Blues shuffle on a triplet feel',
      beats: 4, steps: 3,
      parts: {
        hat:   'X.x|X.x|X.x|X.x',
        snare: '...|X..|...|X..',
        kick:  'X..|..x|X..|...',
      },
    },
    {
      // Bernard Purdie's half-time shuffle (Steely Dan, "Babylon Sisters",
      // "Home at Last"). On a triplet grid: the hi-hat plays the shuffle (first
      // and third partials), the snare fills every middle partial with ghost
      // notes, the backbeat falls on 3, and the kick always lands together with a
      // hi-hat note. Bar 2 ends with an open hi-hat "shoop".
      id: 'purdie', name: 'Purdie’s shuffle',
      about: 'Bernard Purdie’s half-time shuffle: backbeat on 3, ghost notes in between',
      beats: 4, steps: 3,
      parts: {
        hat:   'X.x|X.x|X.x|X.x|X.x|X.x|X.x|X..',
        open:  '...|...|...|...|...|...|...|..x',
        snare: '.g.|.g.|Xg.|.g.',
        kick:  'X..|..x|...|..x|X..|..x|...|X.x',
      },
    },
    {
      // Jeff Porcaro on Toto's "Rosanna" (1982): the Purdie-style half-time
      // shuffle in the hands (hi-hat on the first and third triplet partials,
      // whisper-quiet snare ghosts on the middle ones, backbeat on 3), with the
      // Bo Diddley / son-clave rhythm on the bass drum across two bars.
      id: 'porcaro', name: 'Porcaro’s shuffle', tempo: 82,
      about: 'Half-time shuffle, with a Bo Diddley kick',
      beats: 4, steps: 3,
      parts: {
        hat:   'X.x|X.x|X.x|X.x',
        snare: '.g.|.g.|Xg.|.g.',
        kick:  'X..|..x|...|x..|...|x..|x..|...',
      },
    },
    {
      id: 'funk', name: 'Funk', about: 'Syncopated kick and ghost notes on the snare',
      beats: 4, steps: 4, swing: 0.02,
      parts: {
        hat:   'x.x.|x.x.|x.x.|x...',
        open:  '....|....|....|..x.',
        snare: '....|X..g|.g..|X..g',
        kick:  'X.x.|....|..x.|.x..',
      },
    },
    {
      // Sixteenths on the hi-hat with one hand, accenting the eighth notes; a linear
      // kick/cross-stick figure (never both on the same sixteenth); a barely-there
      // swing; and an open hi-hat at the end of the second bar.
      id: 'funk-sixteenths', name: 'Funk 16th\'s', tempo: 78,
      about: 'Linear kick and cross-stick under sixteenth hi-hats, over two bars',
      beats: 4, steps: 4, swing: 0.015,
      parts: {
        hat:  'XgXg|XgXg|XgXg|XgXg|XgXg|XgXg|XgXg|Xg.g',
        open: '....|....|....|....|....|....|....|..X.',
        rim:  '....|X..g|....|X.g.|....|X..g|...g|X..g',
        kick: 'X..x|..x.|X.x.|...x|X..x|..x.|X.x.|.x..',
      },
    },
    {
      id: 'jazz', name: 'Jazz swing', about: 'Ride cymbal swing, hi-hat on 2 and 4',
      beats: 4, steps: 3,
      parts: {
        ride:  'X..|x.x|X..|x.x',
        hat:   '...|x..|...|x..',
        kick:  'g..|g..|g..|g..',
        snare: '...|...|..g|...|...|..g|...|g..',
      },
    },
    {
      id: 'waltz', name: 'Jazz waltz', about: 'Swing in three',
      beats: 3, steps: 3,
      parts: {
        ride:  'X..|x.x|x..',
        hat:   '...|x..|x..',
        kick:  'g..|...|...',
        snare: '...|...|..g|...|..g|...',
      },
    },
    {
      id: 'hiphop', name: 'Hip-hop', about: 'Boom bap with a lazy sixteenth swing',
      beats: 4, steps: 4, swing: 0.07,
      parts: {
        hat:   'X.x.|X.x.|X.x.|X.x.',
        snare: '....|X...|....|X...',
        kick:  'X...|...x|..x.|....|X...|...x|..x.|.x..',
      },
    },
    {
      id: 'metal', name: 'Metal', about: 'Double-bass sixteenths under a heavy backbeat',
      beats: 4, steps: 4,
      parts: {
        crash: 'X...|....|....|....|....|....|....|....',
        ride:  'x.x.|x.x.|x.x.|x.x.',
        snare: '....|X...|....|X...',
        kick:  'xxxx|xxxx|xxxx|xxxx',
      },
    },
    {
      id: 'disco', name: 'Disco', about: 'Four on the floor, open hi-hat on the offbeats',
      beats: 4, steps: 4,
      parts: {
        hat:   'x...|x...|x...|x...',
        open:  '..x.|..x.|..x.|..x.',
        snare: '....|X...|....|X...',
        kick:  'X...|X...|X...|X...',
      },
    },
    {
      id: 'reggae', name: 'Reggae', about: 'One drop: kick and cross-stick together on 3',
      beats: 4, steps: 3,
      parts: {
        hat:   'x.x|x.x|x.x|x.x',
        rim:   '...|...|X..|...',
        kick:  '...|...|X..|...',
      },
    },
    {
      // Classic 1970s Afrobeat in the Tony Allen tradition: busy sixteenth
      // hi-hats with open accents, a kick that dances around the beat, and
      // ghost notes surrounding the snare (kick and snare never coincide).
      id: 'afrobeat', name: 'Afrobeat', tempo: 112,
      about: 'Busy hi-hats, a dancing kick and ghost notes around the backbeat',
      beats: 4, steps: 4, swing: 0.03,
      parts: {
        hat:   'X.xx|X..x|X.xx|X..x',
        open:  '....|..x.|....|..x.',
        snare: '..g.|X..g|..g.|X.g.',
        kick:  'X...|..x.|.x..|.x..|X...|..x.|.x..|...x',
      },
    },
    {
      id: 'bossa', name: 'Bossa nova', about: 'Cross-stick clave over a steady bass drum',
      beats: 4, steps: 4,
      parts: {
        hat:   'x.x.|x.x.|x.x.|x.x.',
        rim:   'X...|..X.|....|X...|....|X...|..X.|....',
        kick:  'X..x|X..x|X..x|X..x',
      },
    },
  ];

  const VELOCITY = { X: 1, x: 0.65, g: 0.28 };
  GROOVES.forEach((groove) => {
    const barSteps = groove.beats * groove.steps;
    groove.tracks = Object.entries(groove.parts).map(([drum, grid]) => {
      const hits = [...grid.replace(/[|\s]/g, '')].map((c) => VELOCITY[c] || 0);
      if (hits.length % barSteps) console.warn(`Groove "${groove.id}": the ${drum} part is not a whole number of bars.`);
      return { drum, hits };
    });
    groove.bars = Math.ceil(Math.max(...groove.tracks.map((t) => t.hits.length)) / barSteps);
    const swing = groove.steps === 4 ? groove.swing || 0 : 0;
    groove.offsets = Array.from({ length: groove.steps }, (_, i) => i / groove.steps + (i % 2 ? swing : 0));
  });

  const grooveById = (id) => GROOVES.find((g) => g.id === id) || null;

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
    grooves: $('grooves'),
    grooveName: $('groove-name'),
    grooveClick: $('groove-click'),
    grooveClickRow: $('groove-click-row'),
    grooveTempo: $('groove-tempo'),
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
    const defaults = {
      bpm: 100, beats: 4, sub: 'quarter', volume: 0.8, accents: defaultAccents(4),
      groove: 'off', clickWithGroove: false,
    };
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
        groove: grooveById(saved.groove) ? saved.groove : 'off',
        clickWithGroove: saved.clickWithGroove === true,
      };
    } catch {
      return defaults;
    }
  }

  function saveSettings() {
    try {
      const { bpm, beats, sub, volume, accents, groove, clickWithGroove } = state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        bpm, beats, sub, volume, accents, groove, clickWithGroove,
      }));
    } catch {
      /* Storage can be unavailable (private mode); settings just won't persist. */
    }
  }

  const state = { ...loadSettings(), running: false };

  /* ---------- Audio ---------- */

  let audioCtx = null;
  let masterGain = null;
  let drumBus = null;

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = state.volume;
      masterGain.connect(audioCtx.destination);

      // Drums go through a gentle compressor so loud hits never clip.
      const compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.value = -16;
      compressor.knee.value = 6;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.002;
      drumBus = audioCtx.createGain();
      drumBus.gain.value = 0.62;
      drumBus.connect(compressor).connect(masterGain);
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

  /* ---------- Drum kit (synthesised, no sound files) ---------- */

  let noiseBuffer = null;
  function getNoise() {
    if (!noiseBuffer) {
      const length = audioCtx.sampleRate;
      noiseBuffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    return noiseBuffer;
  }

  function envelope(time, peak, decay) {
    const env = audioCtx.createGain();
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(peak, time + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    return env;
  }

  // Filtered white noise: the body of snares, hats and cymbals.
  function noise(time, { decay, type, freq, peak, q = 0.7 }) {
    const src = audioCtx.createBufferSource();
    src.buffer = getNoise();
    const filter = audioCtx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    src.connect(filter).connect(envelope(time, peak, decay)).connect(drumBus);
    src.start(time);
    src.stop(time + decay + 0.05);
  }

  // A pitched tone, optionally sweeping down (kick drum, snare body).
  function tone(time, { wave, from, to, sweep = 0, decay, peak }) {
    const osc = audioCtx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(from, time);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, time + sweep);
    osc.connect(envelope(time, peak, decay)).connect(drumBus);
    osc.start(time);
    osc.stop(time + decay + 0.05);
  }

  // Six detuned square waves, high-passed: the classic drum-machine metal sound.
  const METAL_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];
  function metal(time, { decay, peak, highpass }) {
    const mix = audioCtx.createGain();
    mix.gain.value = 1 / METAL_RATIOS.length;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = highpass;
    mix.connect(filter).connect(envelope(time, peak, decay)).connect(drumBus);
    METAL_RATIOS.forEach((ratio) => {
      const osc = audioCtx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 40 * ratio;
      osc.connect(mix);
      osc.start(time);
      osc.stop(time + decay + 0.05);
    });
  }

  const DRUMS = {
    kick(t, v) {
      tone(t, { wave: 'sine', from: 150, to: 45, sweep: 0.1, decay: 0.4, peak: v });
    },
    snare(t, v) {
      noise(t, { decay: 0.18, type: 'highpass', freq: 1200, peak: v * 0.75 });
      tone(t, { wave: 'triangle', from: 230, to: 170, sweep: 0.05, decay: 0.09, peak: v * 0.45 });
    },
    rim(t, v) {
      tone(t, { wave: 'square', from: 1700, decay: 0.025, peak: v * 0.22 });
      noise(t, { decay: 0.035, type: 'bandpass', freq: 2600, peak: v * 0.35, q: 2 });
    },
    hat(t, v) {
      metal(t, { decay: 0.05, peak: v * 0.5, highpass: 7000 });
    },
    open(t, v) {
      metal(t, { decay: 0.3, peak: v * 0.42, highpass: 7000 });
    },
    ride(t, v) {
      metal(t, { decay: 0.65, peak: v * 0.75, highpass: 5000 });
      noise(t, { decay: 0.25, type: 'highpass', freq: 8000, peak: v * 0.2 });
    },
    crash(t, v) {
      noise(t, { decay: 1.4, type: 'highpass', freq: 4000, peak: v * 0.45 });
      metal(t, { decay: 1.1, peak: v * 0.25, highpass: 5000 });
    },
  };

  /* ---------- Scheduler ---------- */

  let beatStartTime = 0;  // audio time at which the current beat starts
  let currentBeat = 0;    // position in the bar
  let noteIndex = 0;      // position in the subdivision rhythm
  let beatCount = 0;      // total beats since start; drives pendulum direction
  let barNumber = 0;      // bars since start; picks the bar in multi-bar grooves
  const queue = [];       // beats scheduled but not yet drawn
  let lastBeat = null;

  function playGrooveStep(groove, beat, index, time) {
    const step = ((barNumber % groove.bars) * groove.beats + beat) * groove.steps + index;
    for (const track of groove.tracks) {
      const velocity = track.hits[step % track.hits.length];
      if (velocity) DRUMS[track.drum](time, velocity);
    }
  }

  function scheduleNote(beat, index, time) {
    const accent = state.accents[beat] || 'normal';
    const groove = grooveById(state.groove);

    if (accent === 'mute') {
      // A silent beat silences everything on it: subdivisions and drums too.
    } else if (groove) {
      playGrooveStep(groove, beat, index, time);
      if (index === 0 && state.clickWithGroove) playClick(time, accent);
    } else if (index === 0) {
      playClick(time, accent);
    } else {
      playClick(time, 'sub');
    }
    if (index === 0) queue.push({ time, beat, count: beatCount++ });
  }

  // A groove brings its own step grid; otherwise the chosen subdivision is used.
  function currentOffsets() {
    const groove = grooveById(state.groove);
    return groove ? groove.offsets : subById(state.sub).offsets;
  }

  function scheduler() {
    if (!state.running) return;
    const horizon = audioCtx.currentTime + SCHEDULE_AHEAD;

    for (;;) {
      const offsets = currentOffsets();
      const beatLength = 60 / state.bpm;

      // Finished this beat's rhythm: move to the next beat.
      if (noteIndex >= offsets.length) {
        beatStartTime += beatLength;
        noteIndex = 0;
        currentBeat = (currentBeat + 1) % state.beats;
        if (currentBeat === 0) barNumber += 1;
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
    barNumber = 0;
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
    updateLocks();
  }

  // While a groove plays, it decides the beats per bar and the rhythm.
  function updateLocks() {
    const locked = Boolean(grooveById(state.groove));
    els.fewerBeats.disabled = locked || state.beats <= MIN_BEATS;
    els.moreBeats.disabled = locked || state.beats >= MAX_BEATS;
    for (const btn of els.subs.children) btn.disabled = locked;
    els.subName.textContent = locked ? 'Set by the drum groove' : subById(state.sub).name;
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
    updateLocks();
    saveSettings();
  }

  // Arrow keys move the selection within a group of tiles.
  function arrowKeys(container, attr, ids, current, select) {
    container.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const list = ids();
      const next = list[(list.indexOf(current()) + step + list.length) % list.length];
      select(next);
      container.querySelector(`[data-${attr}="${next}"]`).focus();
    });
  }

  arrowKeys(els.subs, 'sub', () => SUBDIVISIONS.map((s) => s.id), () => state.sub, setSub);

  /* ---------- Drum grooves ---------- */

  const GROOVE_OPTIONS = [{ id: 'off', name: 'Off', about: 'Metronome click only' }, ...GROOVES];

  function renderGrooves() {
    els.grooves.replaceChildren(...GROOVE_OPTIONS.map((option) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'groove';
      btn.dataset.groove = option.id;
      btn.title = option.about;
      btn.setAttribute('role', 'radio');
      btn.textContent = option.name;
      btn.addEventListener('click', () => setGroove(option.id));
      return btn;
    }));
  }

  function setGroove(id) {
    const groove = grooveById(id);
    state.groove = groove ? groove.id : 'off';
    for (const btn of els.grooves.children) {
      const selected = btn.dataset.groove === state.groove;
      btn.setAttribute('aria-checked', String(selected));
      btn.tabIndex = selected ? 0 : -1;
    }
    els.grooveName.textContent = groove ? groove.about : 'Metronome click only';
    els.grooveClickRow.hidden = !groove;
    els.grooveTempo.hidden = !(groove && groove.tempo);
    if (groove && groove.tempo) els.grooveTempo.textContent = `Play at the suggested ${groove.tempo} bpm`;
    if (groove) setBeats(groove.beats);
    updateLocks();
    saveSettings();
  }

  arrowKeys(els.grooves, 'groove', () => GROOVE_OPTIONS.map((g) => g.id), () => state.groove, setGroove);

  els.grooveTempo.addEventListener('click', () => {
    const groove = grooveById(state.groove);
    if (groove && groove.tempo) setBpm(groove.tempo);
  });

  els.grooveClick.addEventListener('change', () => {
    state.clickWithGroove = els.grooveClick.checked;
    saveSettings();
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
  const beatsFree = () => !grooveById(state.groove);
  holdToRepeat(els.fewerBeats, () => { if (beatsFree()) setBeats(state.beats - 1); });
  holdToRepeat(els.moreBeats, () => { if (beatsFree()) setBeats(state.beats + 1); });

  els.slider.addEventListener('input', () => setBpm(Number(els.slider.value)));
  els.volume.addEventListener('input', () => setVolume(Number(els.volume.value) / 100));
  els.toggle.addEventListener('click', toggle);
  els.tap.addEventListener('click', tap);

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const onButton = e.target.tagName === 'BUTTON' || e.target.type === 'checkbox';
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
  renderGrooves();
  els.grooveClick.checked = state.clickWithGroove;
  setGroove(state.groove);
  setVolume(state.volume);
})();
