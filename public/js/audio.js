/* audio.js — WebAudio 합성 효과음. 에셋 파일 없이 오실레이터/노이즈로 생성.
 * AudioContext는 사용자 제스처(PLAY 클릭) 후 init/resume 해야 한다. */
export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.42;
    this.master.connect(this.ctx.destination);
    const n = Math.floor(this.ctx.sampleRate * 0.5);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  get t() { return this.ctx.currentTime; }

  // 톤: 주파수 글라이드 + 지수 감쇠 엔벨로프
  tone({ f0, f1, type = 'sine', dur = 0.15, vol = 0.5, delay = 0 }) {
    if (!this.ctx) return;
    const t = this.t + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 != null) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.03);
  }

  // 노이즈: 필터 통과 + 감쇠
  noise({ dur = 0.12, vol = 0.4, type = 'lowpass', freq = 1200, delay = 0 }) {
    if (!this.ctx) return;
    const t = this.t + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0002, vol), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.03);
  }

  fire(type) {
    if (!this.ctx) return;
    switch (type) {
      case 'pushball':
        this.tone({ f0: 220, f1: 70, type: 'sine', dur: 0.22, vol: 0.5 });
        this.noise({ dur: 0.18, vol: 0.22, freq: 500 });
        break;
      case 'bearing':
        this.tone({ f0: 1900, f1: 600, type: 'square', dur: 0.1, vol: 0.3 });
        this.noise({ dur: 0.06, vol: 0.28, type: 'highpass', freq: 3000 });
        break;
      case 'ironball':
        this.tone({ f0: 200, f1: 58, type: 'square', dur: 0.2, vol: 0.42 });
        this.noise({ dur: 0.12, vol: 0.26, freq: 700 });
        break;
      case 'pencil':
        this.tone({ f0: 1500, f1: 820, type: 'square', dur: 0.06, vol: 0.2 });
        this.noise({ dur: 0.04, vol: 0.16, type: 'highpass', freq: 2600 });
        break;
      case 'arrow':
        this.tone({ f0: 420, f1: 190, type: 'triangle', dur: 0.16, vol: 0.32 });
        this.noise({ dur: 0.1, vol: 0.2, freq: 1100 });
        break;
      case 'eraser':
        this.tone({ f0: 170, f1: 95, type: 'sine', dur: 0.3, vol: 0.4 });
        this.noise({ dur: 0.2, vol: 0.18, freq: 420 });
        break;
      case 'stickybomb':
        this.tone({ f0: 320, f1: 170, type: 'sine', dur: 0.16, vol: 0.32 });
        break;
      case 'jumppack':
        this.tone({ f0: 160, f1: 700, type: 'sawtooth', dur: 0.3, vol: 0.36 });
        this.noise({ dur: 0.28, vol: 0.3, type: 'bandpass', freq: 1300 });
        break;
      default: // disc
        this.tone({ f0: 720, f1: 280, type: 'triangle', dur: 0.12, vol: 0.32 });
        this.noise({ dur: 0.08, vol: 0.18, freq: 1800 });
    }
  }

  bowDraw() {
    this.tone({ f0: 160, f1: 320, type: 'sine', dur: 0.5, vol: 0.16 });
  }

  explosion(vol = 1) {
    this.tone({ f0: 180, f1: 38, type: 'sawtooth', dur: 0.6, vol: 0.55 * vol });
    this.noise({ dur: 0.5, vol: 0.45 * vol, freq: 500 });
  }

  stick(vol = 1) {
    this.tone({ f0: 600, f1: 380, type: 'triangle', dur: 0.07, vol: 0.26 * vol });
  }

  hit(vol = 1) {
    this.noise({ dur: 0.1, vol: 0.4 * vol, type: 'bandpass', freq: 900 });
    this.tone({ f0: 320, f1: 150, type: 'square', dur: 0.09, vol: 0.26 * vol });
  }

  kill(vol = 1) {
    this.tone({ f0: 520, f1: 90, type: 'sawtooth', dur: 0.4, vol: 0.4 * vol });
    this.noise({ dur: 0.25, vol: 0.28 * vol, freq: 700 });
  }

  skill(name, vol = 1) {
    if (name === 'repulse') {
      this.tone({ f0: 130, f1: 40, type: 'sine', dur: 0.5, vol: 0.5 * vol });
      this.noise({ dur: 0.45, vol: 0.32 * vol, freq: 600 });
    } else if (name === 'dash') {
      this.noise({ dur: 0.3, vol: 0.4 * vol, type: 'bandpass', freq: 1600 });
      this.tone({ f0: 300, f1: 1200, type: 'sine', dur: 0.28, vol: 0.22 * vol });
    } else {
      this.tone({ f0: 900, f1: 1400, type: 'square', dur: 0.08, vol: 0.3 * vol });
      this.tone({ f0: 1200, f1: 1700, type: 'square', dur: 0.08, vol: 0.3 * vol, delay: 0.1 });
    }
  }

  jump() {
    this.tone({ f0: 280, f1: 520, type: 'sine', dur: 0.12, vol: 0.2 });
  }

  bounce(vol = 1) {
    this.tone({ f0: 440, f1: 210, type: 'triangle', dur: 0.1, vol: 0.32 * vol });
  }

  respawn() {
    this.tone({ f0: 400, f1: 600, type: 'sine', dur: 0.1, vol: 0.3 });
    this.tone({ f0: 620, f1: 900, type: 'sine', dur: 0.12, vol: 0.3, delay: 0.1 });
  }
}
