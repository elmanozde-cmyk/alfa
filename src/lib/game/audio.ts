let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    ctx = new AC({ latencyHint: "interactive" });
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.22;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function unlockAudio(): void {
  ensure();
}

export function setMuted(next: boolean): void {
  muted = next;
  if (master && ctx) {
    master.gain.setTargetAtTime(next ? 0 : 0.22, ctx.currentTime, 0.02);
  }
}

function beep(
  freq: number,
  dur: number,
  type: OscillatorType,
  gain = 0.16,
  slide = 0,
) {
  const ac = ensure();
  if (!ac || !master || muted) return;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime);
  if (slide) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(40, freq + slide),
      ac.currentTime + dur,
    );
  }
  g.gain.setValueAtTime(0.0001, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(gain, ac.currentTime + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
  osc.connect(g);
  g.connect(master);
  osc.start();
  osc.stop(ac.currentTime + dur + 0.02);
  osc.onended = () => {
    osc.disconnect();
    g.disconnect();
  };
}

export const sfx = {
  bell() {
    beep(880, 0.22, "triangle", 0.2);
    window.setTimeout(() => beep(659.25, 0.38, "triangle", 0.18), 160);
  },
  close() {
    beep(659, 0.2, "triangle", 0.16, -80);
    window.setTimeout(() => beep(440, 0.4, "sine", 0.14, -120), 180);
  },
  trade(side: "buy" | "sell") {
    if (side === "buy") beep(740, 0.07, "square", 0.07);
    else beep(220, 0.09, "square", 0.07);
  },
  news(tone: "up" | "down" | "neutral") {
    if (tone === "up") {
      beep(523, 0.08, "sine", 0.1);
      window.setTimeout(() => beep(784, 0.12, "sine", 0.1), 70);
    } else if (tone === "down") {
      beep(392, 0.1, "sine", 0.1, -80);
    } else {
      beep(498, 0.09, "triangle", 0.08);
    }
  },
  click() {
    beep(1400, 0.03, "square", 0.04);
  },
  rank() {
    beep(523, 0.1, "triangle", 0.12);
    window.setTimeout(() => beep(659, 0.12, "triangle", 0.12), 90);
    window.setTimeout(() => beep(784, 0.22, "triangle", 0.14), 180);
  },
  liq() {
    beep(180, 0.28, "sawtooth", 0.14, -60);
    window.setTimeout(() => beep(90, 0.35, "square", 0.1, -30), 80);
  },
  bust() {
    beep(160, 0.35, "sawtooth", 0.16, -70);
    window.setTimeout(() => beep(98, 0.45, "triangle", 0.14, -40), 120);
    window.setTimeout(() => beep(64, 0.55, "sine", 0.12, -20), 260);
  },
};
