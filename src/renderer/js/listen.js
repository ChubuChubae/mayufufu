// Hearing you: the microphone, recorded at 16 kHz (what Whisper reads) until you stop talking, then
// turned into text by main.js (stt.js), here on the PC.

const RATE = 16000;
const SILENCE_MS = 3000;  // this quiet after you've spoken: you're done
const NOTHING_MS = 7000;   // nothing said at all in this long: she stops listening
const MAX_MS = 30000;
const FLOOR_MS = 250;      // the first moments tell how loud the room is

export class Listen {
  constructor({ host }) {
    this.host = host;
    this.session = null;
  }

  get active() {
    return Boolean(this.session);
  }

  // Records until you go quiet (or stop()). Resolves with
  // { ok: true, audio: Float32Array | null } (null: nothing said), or { ok: false, code }.
  async record({ onLevel } = {}) {
    if (this.session) return { ok: false, code: 'busy' };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      return { ok: false, code: err?.name === 'NotFoundError' ? 'nomic' : 'denied' };
    }
    const ctx = new AudioContext({ sampleRate: RATE });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(proc).connect(mute).connect(ctx.destination);

    const chunks = [];
    const t0 = performance.now();
    let floor = 0;
    let floorN = 0;
    let spoke = false;
    let lastLoud = t0;

    return new Promise((resolve) => {
      const finish = () => {
        if (!this.session) return;
        this.session = null;
        proc.onaudioprocess = null;
        src.disconnect();
        proc.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        if (!spoke) return resolve({ ok: true, audio: null });
        const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) { all.set(c, at); at += c.length; }
        resolve({ ok: true, audio: all });
      };
      this.session = { finish };
      proc.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(data));
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        if (now - t0 < FLOOR_MS) {
          floor = (floor * floorN + rms) / ++floorN;
        } else if (rms > Math.max(0.012, floor * 3)) {
          spoke = true;
          lastLoud = now;
        }
        onLevel?.(Math.min(1, rms * 12));
        if ((spoke && now - lastLoud > SILENCE_MS) || (!spoke && now - t0 > NOTHING_MS) || now - t0 > MAX_MS) finish();
      };
    });
  }

  stop() {
    this.session?.finish();
  }

  // Recorded audio as text: { ok, text } (text '' when Whisper heard nothing).
  async transcribe(audio, lang) {
    return this.host.sttTranscribe(audio, lang);
  }
}
