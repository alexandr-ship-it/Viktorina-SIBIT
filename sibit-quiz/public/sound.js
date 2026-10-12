// Звук СИБИТ Квиза: вся музыка и эффекты синтезируются в браузере (Web Audio), без аудиофайлов.
const Sound = (() => {
  const pref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch {} };

  let ctx = null, master, musicGain, sfxGain, noiseBuf;
  let musicOn = pref('sq_music', true), sfxOn = pref('sq_sfx', true);
  let wanted = null, playing = null, bus = null, timer = null, step = 0, nextTime = 0;
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => fn(state()));
  const state = () => ({ unlocked: !!ctx && ctx.state === 'running', musicOn, sfxOn });

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      master.connect(comp).connect(ctx.destination);
      musicGain = ctx.createGain(); musicGain.gain.value = musicOn ? 0.55 : 0; musicGain.connect(master);
      sfxGain = ctx.createGain(); sfxGain.gain.value = sfxOn ? 1 : 0; sfxGain.connect(master);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      ctx.onstatechange = notify;
    }
    if (ctx.state !== 'running') ctx.resume().then(() => { if (wanted && !playing) startTrack(wanted); notify(); });
    else if (wanted && !playing) startTrack(wanted);
  }

  /* ---------- инструменты ---------- */
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  function note(dest, t, midi, dur, o = {}) {
    const { type = 'triangle', vol = 0.2, a = 0.005, r = 0.08, cutoff = 0, q = 1, glideTo = 0 } = o;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(typeof midi === 'number' && midi < 128 ? mtof(midi) : midi, t);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + a);
    g.gain.setValueAtTime(vol, t + Math.max(a, dur - 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + r);
    let node = osc;
    if (cutoff) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff; f.Q.value = q; node.connect(f); node = f; }
    node.connect(g).connect(dest);
    osc.start(t); osc.stop(t + dur + r + 0.05);
  }
  function noise(dest, t, dur, { vol = 0.2, type = 'highpass', freq = 7000, q = 0.7, sweepTo = 0 } = {}) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
  }
  function kick(dest, t, vol = 0.8) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g).connect(dest); o.start(t); o.stop(t + 0.35);
  }
  const hat = (d, t, v = 0.08, open = false) => noise(d, t, open ? 0.14 : 0.035, { vol: v, freq: 8000 });
  const clap = (d, t, v = 0.25) => { noise(d, t, 0.16, { vol: v, type: 'bandpass', freq: 1600, q: 0.8 }); note(d, t, 190, 0.05, { type: 'triangle', vol: v * 0.4, r: 0.04 }); };

  /* ---------- музыка: собственные короткие петли ---------- */
  const TRACKS = {
    // спокойное ожидание в лобби: 96 BPM, Am – F – C – G
    lobby: {
      bpm: 96,
      chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]],
      roots: [45, 41, 48, 43],
      play(s, t, sd) {
        const bar = Math.floor(s / 16) % 4, i = s % 16, ch = this.chords[bar], root = this.roots[bar];
        if (i === 0) ch.forEach(n => note(bus, t, n, sd * 15, { type: 'sine', vol: 0.045, a: 0.25, r: 0.4 }));
        if (i === 0 || i === 10) kick(bus, t, 0.45);
        if (i === 4 || i === 12) clap(bus, t, 0.08);
        if (i % 4 === 2) hat(bus, t, 0.05);
        if ([0, 3, 6, 8, 11, 14].includes(i)) note(bus, t, root - 12 + (i === 6 || i === 14 ? 12 : 0), sd * 1.6, { type: 'sawtooth', vol: 0.09, cutoff: 500 });
        if (i % 2 === 0) {
          const arp = [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[1] + 12, ch[0] + 24, ch[2] + 12, ch[1] + 12, ch[2] + 12][(i / 2) % 8];
          note(bus, t, arp, sd * 1.4, { type: 'triangle', vol: 0.05, r: 0.15 });
        }
      },
    },
    // бодрый ритм во время игры: 124 BPM, Em – C – G – D
    game: {
      bpm: 124,
      chords: [[64, 67, 71], [60, 64, 67], [55, 59, 62], [62, 66, 69]],
      roots: [40, 36, 43, 38],
      play(s, t, sd) {
        const bar = Math.floor(s / 16) % 4, i = s % 16, ch = this.chords[bar], root = this.roots[bar];
        const phrase = Math.floor(s / 64) % 2;
        if (i % 4 === 0) kick(bus, t, 0.6);
        if (i === 4 || i === 12) clap(bus, t, 0.14);
        if (i % 2 === 1) hat(bus, t, i % 4 === 3 ? 0.06 : 0.035, i === 15);
        note(bus, t, root + (i % 4 === 2 ? 12 : 0), sd * 0.8, { type: 'sawtooth', vol: 0.085, cutoff: 650 + (i % 8) * 40 });
        if (phrase === 1 || bar % 2 === 1) {
          const arp = ch[[0, 1, 2, 1][i % 4]] + 12 + (i >= 8 ? 12 : 0);
          note(bus, t, arp, sd * 0.7, { type: 'square', vol: 0.022, cutoff: 2600, r: 0.05 });
        }
        if (i === 0) ch.forEach(n => note(bus, t, n, sd * 14, { type: 'sawtooth', vol: 0.016, a: 0.08, r: 0.3, cutoff: 1400 }));
      },
    },
  };

  function startTrack(name) {
    stopTrack();
    const tr = TRACKS[name];
    if (!ctx || ctx.state !== 'running' || !tr) return;
    playing = name;
    bus = ctx.createGain(); bus.gain.setValueAtTime(0.0001, ctx.currentTime);
    bus.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 1.2);
    bus.connect(musicGain);
    const sd = 60 / tr.bpm / 4;
    step = 0; nextTime = ctx.currentTime + 0.08;
    const myBus = bus;
    timer = setInterval(() => {
      while (nextTime < ctx.currentTime + 0.18) {
        const prev = bus; bus = myBus; tr.play(step, nextTime, sd); bus = prev;
        nextTime += sd; step++;
      }
    }, 25);
  }
  function stopTrack(fade = 0.6) {
    clearInterval(timer); timer = null; playing = null;
    if (bus && ctx) {
      const b = bus; const now = ctx.currentTime;
      b.gain.cancelScheduledValues(now); b.gain.setValueAtTime(b.gain.value || 0.0001, now);
      b.gain.exponentialRampToValueAtTime(0.0001, now + fade);
      setTimeout(() => b.disconnect(), (fade + 0.5) * 1000);
    }
    bus = null;
  }

  /* ---------- эффекты ---------- */
  const SFX = {
    join(d, t) { note(d, t, 76, 0.06, { type: 'sine', vol: 0.22 }); note(d, t + 0.07, 83, 0.1, { type: 'sine', vol: 0.22, r: 0.15 }); },
    tap(d, t) { note(d, t, 1300, 0.025, { type: 'triangle', vol: 0.14, r: 0.03 }); },
    tick(d, t) { note(d, t, 1050, 0.03, { type: 'square', vol: 0.06, cutoff: 3000, r: 0.03 }); },
    tickUrgent(d, t) { note(d, t, 1400, 0.04, { type: 'square', vol: 0.09, cutoff: 3500, r: 0.04 }); note(d, t, 700, 0.04, { type: 'sine', vol: 0.08 }); },
    correct(d, t) { [72, 76, 79, 84].forEach((n, i) => note(d, t + i * 0.07, n, 0.12, { type: 'triangle', vol: 0.22, r: 0.2 })); note(d, t + 0.28, 96, 0.3, { type: 'sine', vol: 0.06, r: 0.4 }); },
    wrong(d, t) { note(d, t, 58, 0.16, { type: 'sawtooth', vol: 0.16, cutoff: 900 }); note(d, t + 0.18, 53, 0.32, { type: 'sawtooth', vol: 0.16, cutoff: 700, r: 0.15 }); },
    timeout(d, t) { [67, 63, 60].forEach((n, i) => note(d, t + i * 0.13, n, 0.12, { type: 'square', vol: 0.08, cutoff: 1500 })); },
    streak(d, t) { noise(d, t, 0.35, { vol: 0.12, type: 'bandpass', freq: 600, sweepTo: 5000, q: 2 }); [79, 83, 86, 91].forEach((n, i) => note(d, t + 0.2 + i * 0.05, n, 0.08, { type: 'square', vol: 0.05, cutoff: 4000, r: 0.1 })); },
    start(d, t) {
      kick(d, t, 0.9);
      [48, 55, 60, 64, 67].forEach(n => note(d, t, n, 0.9, { type: 'sawtooth', vol: 0.06, a: 0.02, r: 0.6, cutoff: 2200 }));
      noise(d, t, 0.8, { vol: 0.12, type: 'highpass', freq: 3000 });
    },
    rankUp(d, t) { noise(d, t, 0.28, { vol: 0.07, type: 'bandpass', freq: 400, sweepTo: 3000, q: 3 }); },
    finished(d, t) { [84, 88, 91].forEach((n, i) => note(d, t + i * 0.06, n, 0.25, { type: 'sine', vol: 0.09, r: 0.4 })); },
    drumroll(d, t) {
      for (let i = 0; i < 28; i++) noise(d, t + i * 0.055, 0.07, { vol: 0.04 + i * 0.006, type: 'bandpass', freq: 1800, q: 0.9 });
      kick(d, t + 1.55, 0.9); noise(d, t + 1.55, 1.2, { vol: 0.18, freq: 4000 });
    },
    // собственная короткая фанфара для пьедестала
    fanfare(d, t) {
      const mel = [[67, 0, 0.15], [72, 0.16, 0.15], [76, 0.32, 0.15], [79, 0.48, 0.4], [76, 0.92, 0.14], [79, 1.08, 0.9]];
      mel.forEach(([n, at, dur]) => { note(d, t + at, n, dur, { type: 'sawtooth', vol: 0.09, cutoff: 3000, r: 0.15 }); note(d, t + at, n + 12, dur, { type: 'square', vol: 0.025, cutoff: 4000, r: 0.15 }); });
      [[48, 55, 64], [53, 60, 69], [55, 62, 71], [48, 55, 64, 72]].forEach((ch, i) =>
        ch.forEach(n => note(d, t + [0, 0.48, 0.92, 1.08][i], n, i === 3 ? 1 : 0.4, { type: 'triangle', vol: 0.06, r: 0.4 })));
      kick(d, t, 0.7); kick(d, t + 0.48, 0.7); kick(d, t + 1.08, 0.9);
      noise(d, t + 1.08, 1.4, { vol: 0.12, freq: 5000 });
    },
    place(d, t) { note(d, t, 60, 0.3, { type: 'triangle', vol: 0.18, r: 0.3 }); kick(d, t, 0.5); },
    end(d, t) { [72, 67, 64, 72].forEach((n, i) => note(d, t + i * 0.12, n, i === 3 ? 0.5 : 0.1, { type: 'triangle', vol: 0.15, r: 0.25 })); },
  };

  function sfx(name) {
    if (!sfxOn || !ctx || ctx.state !== 'running' || !SFX[name]) return;
    SFX[name](sfxGain, ctx.currentTime + 0.01);
  }

  return {
    unlock, sfx, state,
    onChange(fn) { listeners.add(fn); fn(state()); },
    music(name) { wanted = name; if (name !== playing) { if (name) startTrack(name); else stopTrack(); } },
    setMusic(on) {
      musicOn = on; setPref('sq_music', on);
      if (ctx) musicGain.gain.setTargetAtTime(on ? 0.55 : 0, ctx.currentTime, 0.15);
      notify();
    },
    setSfx(on) { sfxOn = on; setPref('sq_sfx', on); if (ctx) sfxGain.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.05); notify(); },
  };
})();
