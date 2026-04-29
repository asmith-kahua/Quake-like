// Procedural sound effects module for the Quake-clone.
// All sounds are synthesized at play-time via the Web Audio API — no external assets.
// Attaches a class to window.Game.Sound. Construct it once and call init() from a
// user-gesture handler (e.g. an overlay click) before any play() calls.

window.Game = window.Game || {};

window.Game.Sound = class {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.noiseBuffer = null;
    this.listenerPos = [0, 0, 0];
    this.activeVoices = 0;
    this.maxVoices = 24;
    this.lastPlayed = Object.create(null); // name -> timestamp (ms)
    this.minRepeatMs = 25;
    this.masterVolume = 1.0;
    this.initialized = false;
  }

  // Must be invoked from a user gesture handler (click/keydown/etc).
  init() {
    if (this.initialized) {
      return;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        return;
      }
      this.ctx = new Ctx();
      // Some browsers create the context in suspended state even from a gesture.
      if (this.ctx.state === 'suspended' && typeof this.ctx.resume === 'function') {
        this.ctx.resume().catch(function () { });
      }

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(this.ctx.destination);

      // Pre-compute a 1-second mono white-noise buffer; reused via BufferSource.
      const sr = this.ctx.sampleRate;
      const len = sr; // 1 second
      const buf = this.ctx.createBuffer(1, len, sr);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buf;

      this.initialized = true;
    } catch (e) {
      // Fail silently — game should still run without audio.
      this.ctx = null;
      this.masterGain = null;
      this.initialized = false;
    }
  }

  setMasterVolume(v) {
    const clamped = Math.max(0, Math.min(1, +v || 0));
    this.masterVolume = clamped;
    if (this.masterGain) {
      try {
        this.masterGain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
      } catch (e) {
        try { this.masterGain.gain.value = clamped; } catch (e2) { }
      }
    }
  }

  setListenerPosition(vec3) {
    if (!vec3) {
      return;
    }
    if (Array.isArray(vec3)) {
      this.listenerPos[0] = +vec3[0] || 0;
      this.listenerPos[1] = +vec3[1] || 0;
      this.listenerPos[2] = +vec3[2] || 0;
    } else if (typeof vec3.x === 'number') {
      this.listenerPos[0] = vec3.x;
      this.listenerPos[1] = vec3.y;
      this.listenerPos[2] = vec3.z;
    }
  }

  // Internal: distance attenuation factor in [0.05, 1].
  _attenuationFor(position) {
    if (!position) {
      return 1;
    }
    let px, py, pz;
    if (Array.isArray(position)) {
      px = +position[0] || 0; py = +position[1] || 0; pz = +position[2] || 0;
    } else if (typeof position.x === 'number') {
      px = position.x; py = position.y; pz = position.z;
    } else {
      return 1;
    }
    const dx = px - this.listenerPos[0];
    const dy = py - this.listenerPos[1];
    const dz = pz - this.listenerPos[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let a = 1 - dist / 30;
    if (a < 0.05) a = 0.05;
    if (a > 1) a = 1;
    return a;
  }

  // Internal: build a one-shot gain that connects to master and auto-disconnects.
  // The returned gain exposes a `_track(node)` method — every intermediate node
  // (oscillator, BufferSource, BiquadFilter, modulation gain, etc.) connected
  // upstream of this gain MUST be tracked so it can be disconnected once the
  // envelope ends. Without this, AudioParam-bound nodes and filters accumulate
  // in the AudioContext graph and cause Web Audio scheduler latency spikes.
  _voice(durationSec, peakVolume) {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.connect(this.masterGain);
    const self = this;
    self.activeVoices++;
    const tracked = [];
    let cleaned = false;
    g._track = function (node) {
      if (node) tracked.push(node);
      return node;
    };
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      for (let i = 0; i < tracked.length; i++) {
        try { tracked[i].disconnect(); } catch (e) { }
      }
      tracked.length = 0;
      try { g.disconnect(); } catch (e) { }
      self.activeVoices = Math.max(0, self.activeVoices - 1);
    }
    g._cleanup = cleanup;
    // Fallback: if no source node fires `onended` (e.g. exception before .start),
    // a setTimeout still releases the graph nodes. Add ample slack.
    const ms = Math.max(20, Math.ceil(durationSec * 1000) + 120);
    setTimeout(cleanup, ms);
    g._peak = peakVolume;
    return g;
  }

  // Internal: wire a source node (oscillator / BufferSource) so its `onended`
  // event drives the voice cleanup. This is the deterministic path; the
  // `_voice` setTimeout is just a safety net.
  _bindEnd(src, voiceGain) {
    if (!src || !voiceGain || typeof voiceGain._cleanup !== 'function') return src;
    src.onended = voiceGain._cleanup;
    return src;
  }

  // Internal: short noise BufferSource using the shared 1s buffer with random offset.
  _noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    // Randomize playback start offset within the 1s buffer to avoid identical bursts.
    try {
      // We can't seek a non-loopable single playback easily; loop=true + duration cap works.
      // Instead, use playbackRate jitter for variety.
      src.playbackRate.value = 0.9 + Math.random() * 0.2;
    } catch (e) { }
    return src;
  }

  play(name, opts) {
    if (!this.initialized || !this.ctx || !this.masterGain || !this.noiseBuffer) {
      return;
    }
    if (this.activeVoices >= this.maxVoices) {
      return;
    }
    opts = opts || {};
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const last = this.lastPlayed[name] || 0;
    if (now - last < this.minRepeatMs) {
      return;
    }
    this.lastPlayed[name] = now;

    // Resume context if it was auto-suspended.
    if (this.ctx.state === 'suspended' && typeof this.ctx.resume === 'function') {
      try { this.ctx.resume(); } catch (e) { }
    }

    const optVol = (typeof opts.volume === 'number') ? Math.max(0, Math.min(1, opts.volume)) : 1;
    const att = this._attenuationFor(opts.position);
    const vol = optVol * att;

    try {
      switch (name) {
        case 'rifleShot': this._rifleShot(vol); break;
        case 'rocketFire': this._rocketFire(vol); break;
        case 'explosion': this._explosion(vol); break;
        case 'enemyHit': this._enemyHit(vol); break;
        case 'enemyDie': this._enemyDie(vol); break;
        case 'playerHurt': this._playerHurt(vol); break;
        case 'pickupHealth': this._pickupHealth(vol); break;
        case 'pickupAmmo': this._pickupAmmo(vol); break;
        case 'levelComplete': this._levelComplete(vol); break;
        case 'levelStart': this._levelStart(vol); break;
        case 'jump': this._jump(vol); break;
        case 'weaponSwitch': this._weaponSwitch(vol); break;
        default: break;
      }
    } catch (e) {
      // Swallow — one bad sound shouldn't poison the rest.
    }
  }

  // ---------- Individual sound implementations ----------

  _rifleShot(vol) {
    try {
      const ctx = this.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.09;

      // 1) High-passed noise click/pop (~50ms)
      const noiseDur = 0.06;
      const noise = this._noiseSource();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;
      hp.Q.value = 0.7;
      const ng = this._voice(noiseDur, 0.9 * vol);
      ng._track(noise); ng._track(hp);
      ng.gain.cancelScheduledValues(t0);
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.9 * vol + 0.0001, t0 + 0.002);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + noiseDur);
      noise.connect(hp); hp.connect(ng);
      noise.start(t0);
      noise.stop(t0 + noiseDur + 0.01);
      this._bindEnd(noise, ng);

      // 2) Quick downward saw chirp
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(900, t0);
      osc.frequency.exponentialRampToValueAtTime(120, t0 + dur);
      const og = this._voice(dur, 0.35 * vol);
      og._track(osc);
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(0.35 * vol + 0.0001, t0 + 0.005);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(og);
      osc.start(t0);
      osc.stop(t0 + dur + 0.01);
      this._bindEnd(osc, og);
    } catch (e) { }
  }

  _rocketFire(vol) {
    try {
      const ctx = this.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.25;

      // Low-pass falling noise (the "whoosh")
      const noise = this._noiseSource();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1800, t0);
      lp.frequency.exponentialRampToValueAtTime(180, t0 + dur);
      lp.Q.value = 1.0;
      const ng = this._voice(dur, 0.7 * vol);
      ng._track(noise); ng._track(lp);
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.7 * vol + 0.0001, t0 + 0.02);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      noise.connect(lp); lp.connect(ng);
      noise.start(t0);
      noise.stop(t0 + dur + 0.02);
      this._bindEnd(noise, ng);

      // Low-end rumble oscillator
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(110, t0);
      osc.frequency.exponentialRampToValueAtTime(45, t0 + dur);
      const og = this._voice(dur, 0.55 * vol);
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(0.55 * vol + 0.0001, t0 + 0.03);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      // Boost low end via a lowpass on the osc as well
      const olp = ctx.createBiquadFilter();
      olp.type = 'lowpass';
      olp.frequency.value = 400;
      og._track(osc); og._track(olp);
      osc.connect(olp); olp.connect(og);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
      this._bindEnd(osc, og);
    } catch (e) { }
  }

  _explosion(vol) {
    try {
      const ctx = this.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.6;

      // Big noise burst with low-pass sweep down
      const noise = this._noiseSource();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2200, t0);
      lp.frequency.exponentialRampToValueAtTime(150, t0 + dur);
      lp.Q.value = 0.9;
      const ng = this._voice(dur, 0.95 * vol);
      ng._track(noise); ng._track(lp);
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.95 * vol + 0.0001, t0 + 0.01);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      noise.connect(lp); lp.connect(ng);
      noise.start(t0);
      noise.stop(t0 + dur + 0.02);
      this._bindEnd(noise, ng);

      // Low oscillator thump
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(140, t0);
      osc.frequency.exponentialRampToValueAtTime(35, t0 + 0.35);
      const og = this._voice(0.4, 0.8 * vol);
      og._track(osc);
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(0.8 * vol + 0.0001, t0 + 0.02);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
      osc.connect(og);
      osc.start(t0);
      osc.stop(t0 + 0.42);
      this._bindEnd(osc, og);
    } catch (e) { }
  }

  _enemyHit(vol) {
    try {
      const ctx = this.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.14;

      // Band-passed noise squelch
      const noise = this._noiseSource();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1200;
      bp.Q.value = 4;
      const ng = this._voice(dur, 0.55 * vol);
      ng._track(noise); ng._track(bp);
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.55 * vol + 0.0001, t0 + 0.005);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      noise.connect(bp); bp.connect(ng);
      noise.start(t0);
      noise.stop(t0 + dur + 0.01);
      this._bindEnd(noise, ng);

      // Quick descending sine
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(700, t0);
      osc.frequency.exponentialRampToValueAtTime(260, t0 + dur);
      const og = this._voice(dur, 0.35 * vol);
      og._track(osc);
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(0.35 * vol + 0.0001, t0 + 0.005);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(og);
      osc.start(t0);
      osc.stop(t0 + dur + 0.01);
      this._bindEnd(osc, og);
    } catch (e) { }
  }

  _enemyDie(vol) {
    try {
      const ctx = this.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.7;

      // Three detuned sawtooths descending — beefy growl.
      const detunes = [-12, 0, 9];
      const startF = 280;
      const endF = 70;
      for (let i = 0; i < detunes.length; i++) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.detune.value = detunes[i];
        osc.frequency.setValueAtTime(startF, t0);
        osc.frequency.exponentialRampToValueAtTime(endF, t0 + dur);
        const og = this._voice(dur, 0.32 * vol);
        og.gain.setValueAtTime(0.0001, t0);
        og.gain.exponentialRampToValueAtTime(0.32 * vol + 0.0001, t0 + 0.04);
        og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(1500, t0);
        lp.frequency.exponentialRampToValueAtTime(300, t0 + dur);
        og._track(osc); og._track(lp);
        osc.connect(lp); lp.connect(og);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
        this._bindEnd(osc, og);
      }
    } catch (e) { }
  }

  _playerHurt(vol) {
    try {
      const ctx = this.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.12;

      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(200, t0);
      osc.frequency.exponentialRampToValueAtTime(100, t0 + dur);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 700;
      bp.Q.value = 1.5;
      const og = this._voice(dur, 0.55 * vol);
      og._track(osc); og._track(bp);
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(0.55 * vol + 0.0001, t0 + 0.005);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(bp); bp.connect(og);
      osc.start(t0);
      osc.stop(t0 + dur + 0.01);
      this._bindEnd(osc, og);
    } catch (e) { }
  }

  _pickupHealth(vol) {
    try {
      const ctx = this.ctx;
      const t0 = ctx.currentTime;
      // Three quick ascending sine notes (C5, E5, G5 — cheery major triad).
      const notes = [523.25, 659.25, 783.99];
      const noteDur = 0.12;
      const gap = 0.08;
      for (let i = 0; i < notes.length; i++) {
        const start = t0 + i * gap;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = notes[i];
        const og = this._voice(start - t0 + noteDur, 0.35 * vol);
        og._track(osc);
        og.gain.setValueAtTime(0.0001, start);
        og.gain.exponentialRampToValueAtTime(0.35 * vol + 0.0001, start + 0.01);
        og.gain.exponentialRampToValueAtTime(0.0001, start + noteDur);
        osc.connect(og);
        osc.start(start);
        osc.stop(start + noteDur + 0.01);
        this._bindEnd(osc, og);
      }
    } catch (e) { }
  }

  _pickupAmmo(vol) {
    try {
      const ctx = this.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.14;

      // FM-ish: carrier at ~440, modulator into carrier frequency for metallic flavor.
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.value = 440;
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = 660;
      const modGain = ctx.createGain();
      modGain.gain.setValueAtTime(400, t0);
      modGain.gain.exponentialRampToValueAtTime(20, t0 + dur);
      mod.connect(modGain); modGain.connect(carrier.frequency);

      const og = this._voice(dur, 0.45 * vol);
      // Track every node we created upstream of `og`, including the modulator
      // chain whose `modGain` is connected to an AudioParam (carrier.frequency).
      // AudioParam-bound nodes are NOT torn down by `og.disconnect()` alone —
      // without explicit disconnects here, they pile up in the AudioContext
      // graph on every pickup and cause the lag the user reported.
      og._track(carrier); og._track(mod); og._track(modGain);
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(0.45 * vol + 0.0001, t0 + 0.005);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      carrier.connect(og);
      mod.start(t0); carrier.start(t0);
      mod.stop(t0 + dur + 0.01); carrier.stop(t0 + dur + 0.01);
      // Use the carrier's onended (it gates the audible voice). `mod` ends at
      // the same time, so its disconnect happens via the tracked-list cleanup.
      this._bindEnd(carrier, og);

      // Noise click on the front
      const clickDur = 0.025;
      const noise = this._noiseSource();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2500;
      const ng = this._voice(clickDur, 0.4 * vol);
      ng._track(noise); ng._track(hp);
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.4 * vol + 0.0001, t0 + 0.001);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + clickDur);
      noise.connect(hp); hp.connect(ng);
      noise.start(t0);
      noise.stop(t0 + clickDur + 0.005);
      this._bindEnd(noise, ng);
    } catch (e) { }
  }

  _levelComplete(vol) {
    try {
      const ctx = this.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.6;
      // C major triad: C5, E5, G5 sustained.
      const notes = [523.25, 659.25, 783.99];
      for (let i = 0; i < notes.length; i++) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = notes[i];
        const og = this._voice(dur, 0.28 * vol);
        og._track(osc);
        og.gain.setValueAtTime(0.0001, t0);
        og.gain.exponentialRampToValueAtTime(0.28 * vol + 0.0001, t0 + 0.04);
        og.gain.setValueAtTime(0.28 * vol, t0 + dur - 0.15);
        og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(og);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
        this._bindEnd(osc, og);
      }
    } catch (e) { }
  }

  _levelStart(vol) {
    try {
      const ctx = this.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.45;

      // Low oscillator drop (the "door slam")
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(180, t0);
      osc.frequency.exponentialRampToValueAtTime(40, t0 + dur);
      const og = this._voice(dur, 0.7 * vol);
      og._track(osc);
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(0.7 * vol + 0.0001, t0 + 0.02);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(og);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
      this._bindEnd(osc, og);

      // Noise hit at the very start
      const nDur = 0.08;
      const noise = this._noiseSource();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 800;
      const ng = this._voice(nDur, 0.5 * vol);
      ng._track(noise); ng._track(lp);
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.5 * vol + 0.0001, t0 + 0.002);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + nDur);
      noise.connect(lp); lp.connect(ng);
      noise.start(t0);
      noise.stop(t0 + nDur + 0.01);
      this._bindEnd(noise, ng);
    } catch (e) { }
  }

  _jump(vol) {
    try {
      const ctx = this.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.08;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(220, t0);
      osc.frequency.exponentialRampToValueAtTime(150, t0 + dur);
      const og = this._voice(dur, 0.18 * vol);
      og._track(osc);
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(0.18 * vol + 0.0001, t0 + 0.005);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(og);
      osc.start(t0);
      osc.stop(t0 + dur + 0.01);
      this._bindEnd(osc, og);
    } catch (e) { }
  }

  _weaponSwitch(vol) {
    try {
      const ctx = this.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.05;
      const noise = this._noiseSource();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 3000;
      bp.Q.value = 6;
      const ng = this._voice(dur, 0.5 * vol);
      ng._track(noise); ng._track(bp);
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.5 * vol + 0.0001, t0 + 0.002);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      noise.connect(bp); bp.connect(ng);
      noise.start(t0);
      noise.stop(t0 + dur + 0.01);
      this._bindEnd(noise, ng);
    } catch (e) { }
  }
};
