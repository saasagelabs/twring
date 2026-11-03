export interface WavePathOptions {
  width: number;
  height: number;
  time: number;
  intensity: number;
  phase: number;
  ampMul: number;
  freqMul: number;
  points?: number;
}

/** The Voca layer curve. Pure math so it can run on the UI thread. */
export function wavePath({
  width,
  height,
  time,
  intensity,
  phase,
  ampMul,
  freqMul,
  points = 64,
}: WavePathOptions): string {
  'worklet';
  const count = Math.max(2, points);
  const scale = height / 110;
  const coordinate = (value: number) => (Math.round(value * 10) / 10).toFixed(1);
  let previousX = 0;
  let previousY = height / 2;
  let path = `M ${coordinate(previousX)} ${coordinate(previousY)}`;

  for (let i = 1; i < count; i += 1) {
    const fraction = i / (count - 1);
    const x = fraction * width;
    const envelope = Math.cos(((fraction * 2 - 1) * Math.PI) / 2) ** 1.4;
    const y =
      height / 2 +
      (Math.sin(i * 0.16 * freqMul * (110 / count) + time * 2.4 + phase) * 22 +
        Math.sin(i * 0.34 * freqMul * (110 / count) + time * 4.5 + phase * 1.7) * 10 +
        Math.sin(i * 0.62 * freqMul * (110 / count) + time * 6.2 + phase * 0.6) * 4) *
        envelope *
        intensity *
        ampMul *
        scale;
    const midpointX = (previousX + x) / 2;
    const midpointY = (previousY + y) / 2;
    path += ` Q ${coordinate(previousX)} ${coordinate(previousY)} ${coordinate(midpointX)} ${coordinate(midpointY)}`;
    previousX = x;
    previousY = y;
  }

  return `${path} T ${coordinate(previousX)} ${coordinate(previousY)}`;
}
