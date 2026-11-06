/** The bite's sounds, synthesized with Web Audio so there are no files to load. */
let enabled = true;
let ac: AudioContext | null = null;

export const soundOn = () => enabled;
export const setSound = (on: boolean) => {
  enabled = on;
};

function audio(): AudioContext | null {
  if (!enabled) return null;
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    ac = ac ?? new Ctx();
    if (ac.state === "suspended") void ac.resume();
    return ac;
  } catch {
    return null;
  }
}

function noise(a: AudioContext, duration: number, freq: number, gain: number, at: number) {
  const n = Math.floor(a.sampleRate * duration);
  const b = a.createBuffer(1, n, a.sampleRate);
  const c = b.getChannelData(0);
  for (let i = 0; i < n; i++) c[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const s = a.createBufferSource();
  s.buffer = b;
  const q = a.createBiquadFilter();
  q.type = "lowpass";
  q.frequency.value = freq;
  const v = a.createGain();
  v.gain.value = gain;
  s.connect(q);
  q.connect(v);
  v.connect(a.destination);
  s.start(a.currentTime + at);
}

function tone(a: AudioContext, f: number, to: number, duration: number, gain: number, at: number, type: OscillatorType = "sine") {
  const o = a.createOscillator();
  const v = a.createGain();
  o.type = type;
  const t = a.currentTime + at;
  o.frequency.setValueAtTime(f, t);
  o.frequency.exponentialRampToValueAtTime(to, t + duration);
  v.gain.setValueAtTime(gain, t);
  v.gain.exponentialRampToValueAtTime(0.001, t + duration);
  o.connect(v);
  v.connect(a.destination);
  o.start(t);
  o.stop(t + duration);
}

export function wake() {
  audio();
}

export function rumble() {
  const a = audio();
  if (a) tone(a, 90, 55, 0.16, 0.5, 0);
}

/** Foil tearing: three quick bright rasps. */
export function rip(at: number) {
  const a = audio();
  if (!a) return;
  noise(a, 0.09, 7000, 0.4, at);
  noise(a, 0.12, 9000, 0.45, at + 0.05);
  noise(a, 0.2, 11000, 0.35, at + 0.12);
}

export function chomp(at: number) {
  const a = audio();
  if (!a) return;
  noise(a, 0.12, 2600, 0.55, at);
  noise(a, 0.05, 6000, 0.25, at);
  tone(a, 150, 38, 0.2, 0.8, at);
}

const STINGS = [[523, 659], [523, 659, 784], [523, 659, 784, 1047], [523, 659, 784, 1047, 1319, 1568], [523, 659, 784, 1047, 1319, 1568, 2093]];

export function sting(level: number, at: number) {
  const a = audio();
  if (!a) return;
  (STINGS[level] ?? STINGS[0]).forEach((f, i) => tone(a, f, f, 0.28, 0.14, at + i * 0.075, "triangle"));
}
