# Metronome

A browser metronome built with plain HTML, CSS and JavaScript.

## Features

- Tempo from 30 to 250 bpm, with the Italian tempo marking (Largo, Allegro…)
- Swinging pendulum whose weight moves with the tempo, like a mechanical metronome
- 1 to 12 beats per bar; click any beat to make it accented, normal or silent
- Eleven subdivisions, each shown as a note icon: quarter notes, eighth notes, eighth-note triplets, sixteenth notes, quintuplets, sextuplets, triplet shuffle, dotted eighth and sixteenth, eighth and two sixteenths, two sixteenths and eighth, and sixteenth-eighth-sixteenth. To add your own rhythm, add one line to `SUBDIVISIONS` in `script.js`; its timing and icon are worked out automatically.
- Drum grooves to play along with, a groove can carry a suggested `tempo`, which adds a one-click button to play it at that speed. The drum kit is synthesised with Web Audio, so there are no sound files. Silent beats also silence the drums, which makes for good "gap" practice. To add your own groove, add an entry to `GROOVES` in `script.js`; each drum is written as a step grid such as `'X...|x...|X.x.|x...'`.
- Tap tempo
- Settings are remembered between visits
- Theme button in the top corner: Auto follows your device's light/dark setting, or choose Light or Dark to override it. Your choice is remembered.

Keyboard: `Space` starts and stops, `↑` / `↓` change the tempo (hold `Shift` for steps of 10), `T` taps the tempo.

## Files

| File         | Purpose                                     |
| ------------ | ------------------------------------------- |
| `index.html` | Page structure                              |
| `style.css`  | Layout and the light/dark colour themes     |
| `script.js`  | Audio scheduling, pendulum animation, controls |


## How the timing works

`setInterval` on its own drifts by several milliseconds per beat, which is audible. Instead, a timer running in a Web Worker wakes up every 25 ms and schedules the next 100 ms of clicks on the Web Audio clock (`AudioContext.currentTime`), which is sample-accurate. The pendulum and beat dots read the same clock, so what you see matches what you hear.

On iPhone, Web Audio is muted when the ring/silent switch is set to silent.
