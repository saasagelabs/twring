import type { AudioStatus } from 'expo-audio';

/** Listen speeds, in the order the chip cycles through them. */
export const LISTEN_SPEEDS = [1, 1.5, 2] as const;
export type ListenSpeed = (typeof LISTEN_SPEEDS)[number];
/** How far the screen reader's increment and decrement move the position. */
export const SEEK_STEP_SECONDS = 5;

export function nextListenSpeed(speed: ListenSpeed): ListenSpeed {
  const index = LISTEN_SPEEDS.indexOf(speed);
  return LISTEN_SPEEDS[(index + 1) % LISTEN_SPEEDS.length] ?? 1;
}

export function parseListenSpeed(raw: string | null | undefined): ListenSpeed {
  const value = Number(raw);
  return LISTEN_SPEEDS.find((speed) => speed === value) ?? 1;
}

export function speedLabel(speed: ListenSpeed): string {
  return `${speed}x`;
}

interface SpeedStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

const SPEED_KEY = 'twring.listen_speed';

/** The per-device Listen speed: read once, then kept in memory for every playback. */
export function createListenSpeedStore(storage: () => SpeedStorage) {
  let speed: ListenSpeed = 1;
  let loaded: Promise<ListenSpeed> | undefined;
  /** A speed chosen on this phone wins over a stored one that arrives after it. */
  let chosen = false;
  return {
    current: (): ListenSpeed => speed,
    load(): Promise<ListenSpeed> {
      loaded ??= Promise.resolve()
        .then(() => storage().getItemAsync(SPEED_KEY))
        .then((raw) => (chosen ? speed : (speed = parseListenSpeed(raw))))
        .catch(() => speed);
      return loaded;
    },
    async set(next: ListenSpeed): Promise<void> {
      speed = next;
      chosen = true;
      loaded = Promise.resolve(next);
      await Promise.resolve()
        .then(() => storage().setItemAsync(SPEED_KEY, String(next)))
        .catch(() => undefined);
    },
  };
}

interface RatePlayer {
  setPlaybackRate(rate: number, pitchCorrectionQuality?: 'low' | 'medium' | 'high'): void;
}

/** Faster speech keeps its normal pitch. */
export function applyListenSpeed(player: RatePlayer, speed: ListenSpeed): void {
  player.setPlaybackRate(speed, 'high');
}

/** A known length in seconds, or undefined while the audio has not said how long it is. */
export function knownDuration(duration: number): number | undefined {
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

/** Where a seek lands: nowhere before the length is known, else inside the audio. */
export function clampSeek(target: number, duration: number): number | undefined {
  const length = knownDuration(duration);
  if (length === undefined || !Number.isFinite(target)) return undefined;
  return Math.min(Math.max(target, 0), length);
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export interface ListenProgress {
  position: number;
  duration: number;
}

/** "0:12 of 0:40", or an honest note while the length is still unknown. */
export function progressText({ position, duration }: ListenProgress): string {
  const length = knownDuration(duration);
  return length === undefined
    ? `${formatClock(position)}, length not known yet`
    : `${formatClock(position)} of ${formatClock(length)}`;
}

/** Share of the bar filled, or undefined (indeterminate) while the length is unknown. */
export function progressFraction({ position, duration }: ListenProgress): number | undefined {
  const length = knownDuration(duration);
  return length === undefined ? undefined : Math.min(Math.max(position / length, 0), 1);
}

interface StatusHandlers {
  /** False once this playback was stopped, replaced or unmounted: nothing more may update. */
  isCurrent: () => boolean;
  onProgress: (progress: ListenProgress) => void;
  onPlaying: () => void;
  onFinish: () => void;
  onError: () => void;
}

/** Turns player status into state updates, and drops everything once the playback is gone. */
export function listenStatusHandler(handlers: StatusHandlers) {
  return (
    status: Pick<
      AudioStatus,
      'error' | 'didJustFinish' | 'isLoaded' | 'playing' | 'currentTime' | 'duration'
    >,
  ) => {
    if (!handlers.isCurrent()) return;
    if (status.error) {
      handlers.onError();
      return;
    }
    if (status.didJustFinish) {
      handlers.onFinish();
      return;
    }
    if (!status.isLoaded) return;
    handlers.onProgress({ position: status.currentTime, duration: status.duration });
    if (status.playing) handlers.onPlaying();
  };
}

/** The position under a finger on the bar, or undefined before the length or bar size is known. */
export function positionAt(x: number, width: number, duration: number): number | undefined {
  const length = knownDuration(duration);
  if (length === undefined || !(width > 0) || !Number.isFinite(x)) return undefined;
  return clampSeek((x / width) * length, length);
}
