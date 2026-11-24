import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';

import { twringApi } from '@/api';
import { ApiError } from '../../api/client';
import { apiErrorCopy } from '../../api/errors';
import { probeSpeech, probeSpeechKeyError } from '../../api/speech-key-probe';
import { Icon } from '@/components/Icon';
import { font } from '@/theme/fonts';
import { secureStore } from '@/platform/secure-store';
import { usePalette, type } from '@/theme/tokens';

import {
  SEEK_STEP_SECONDS,
  applyListenSpeed,
  clampSeek,
  createListenSpeedStore,
  formatClock,
  knownDuration,
  listenStatusHandler,
  nextListenSpeed,
  progressFraction,
  progressText,
  speedLabel,
  type ListenProgress,
  type ListenSpeed,
} from './listen-progress';

/** One speed for every Listen on this phone, auto-listen included. */
export const listenSpeed = createListenSpeedStore(() => secureStore);

export type ListenState = 'idle' | 'loading' | 'playing' | 'error';
export type ListenAction = 'load' | 'play' | 'stop' | 'fail';
export function listenReducer(_state: ListenState, action: ListenAction): ListenState {
  switch (action) {
    case 'load':
      return 'loading';
    case 'play':
      return 'playing';
    case 'stop':
      return 'idle';
    case 'fail':
      return 'error';
  }
}

const LISTEN_FAILED = "Couldn't play this. Try again.";

/** A refused or unreadable own voice key names its fix; anything else stays generic. */
export function listenFailureMessage(error: unknown): string {
  return isSpeechKeyError(error) ? apiErrorCopy(error).message : LISTEN_FAILED;
}

function isSpeechKeyError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    (error.code === 'speech_key_refused' || error.code === 'speech_key_unreadable')
  );
}

/**
 * Agents whose Listen came back as a refused own voice key (each agent has its own voice, so its
 * own provider). The native player retries a refused answer several times before it reports a
 * failure (about 5 requests in 4 s), so for these agents the next Listen asks once as plain HTTP
 * first and shows the refusal straight away.
 */
const keyRefused = new Set<string>();
/** The check before the player is on the tap's path: past this it counts as inconclusive. */
export const LISTEN_PREFLIGHT_TIMEOUT_MS = 4_000;

/** Remembers a refused own key for this agent so its next Listen checks first. */
export function noteListenFailure(agentId: string, error: unknown): void {
  if (isSpeechKeyError(error)) keyRefused.add(agentId);
}

/** Test helper: back to handing Listen straight to the player. */
export function forgetListenRefusal(): void {
  keyRefused.clear();
}

/**
 * Before the player: undefined means play. After a refused own key, the probe runs once: a refusal
 * comes back to show; only a confirmed healthy answer clears the memory. An inconclusive check
 * (network failure, another error) plays as usual but keeps checking first next time.
 */
export async function listenPreflight(
  agentId: string,
  probe: () => Promise<'ok' | ApiError | undefined>,
): Promise<ApiError | undefined> {
  if (!keyRefused.has(agentId)) return undefined;
  const found = await probe();
  if (found === 'ok') keyRefused.delete(agentId);
  else if (isSpeechKeyError(found)) return found;
  return undefined;
}

let current: { owner: symbol; player?: AudioPlayer; stop: () => void } | undefined;
export function stopMessageSpeech(): void {
  current?.stop();
}

interface Props {
  agentId: string;
  messageId: string;
  name: string;
  autoPlay?: boolean;
}

export function ListenButton({ agentId, messageId, name, autoPlay = false }: Props) {
  const palette = usePalette();
  const [state, dispatch] = useReducer(listenReducer, 'idle');
  const owned = useRef<AudioPlayer | undefined>(undefined);
  const generation = useRef(0);
  const owner = useRef(Symbol('listen'));
  const playedAutomatically = useRef(false);
  const preflight = useRef<AbortController | undefined>(undefined);
  const [failure, setFailure] = useState(LISTEN_FAILED);
  const [progress, setProgress] = useState<ListenProgress | undefined>(undefined);
  const [speed, setSpeed] = useState<ListenSpeed>(listenSpeed.current());
  const [trackWidth, setTrackWidth] = useState(0);
  const mounted = useRef(true);

  const stop = useCallback(() => {
    generation.current++;
    preflight.current?.abort();
    preflight.current = undefined;
    const player = owned.current;
    if (current?.owner === owner.current) current = undefined;
    if (player) {
      owned.current = undefined;
      player.pause();
      player.remove();
    }
    if (mounted.current) {
      setProgress(undefined);
      dispatch('stop');
    }
  }, []);
  useEffect(
    () => () => {
      mounted.current = false;
      generation.current++;
      preflight.current?.abort();
      const player = owned.current;
      owned.current = undefined;
      if (current?.owner === owner.current) current = undefined;
      player?.pause();
      player?.remove();
    },
    [],
  );

  const press = useCallback(async () => {
    if (state === 'loading' || state === 'playing') {
      stop();
      return;
    }
    stopMessageSpeech();
    const request = ++generation.current;
    current = { owner: owner.current, stop };
    dispatch('load');
    try {
      const api = twringApi();
      if (!api) throw new Error('API unavailable');
      const source = await api.messageSpeechUrl(agentId, messageId);
      const check = new AbortController();
      preflight.current = check;
      const deadline = setTimeout(() => check.abort(), LISTEN_PREFLIGHT_TIMEOUT_MS);
      let refused: ApiError | undefined;
      try {
        refused = await listenPreflight(agentId, () =>
          probeSpeech(fetch, source.uri, source.headers, check.signal),
        );
      } finally {
        clearTimeout(deadline);
        if (preflight.current === check) preflight.current = undefined;
      }
      if (request !== generation.current) return;
      if (refused !== undefined) throw refused;
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      const rate = await listenSpeed.load();
      if (request !== generation.current) return;
      setSpeed(rate);
      const player = createAudioPlayer(source);
      owned.current = player;
      current = { owner: owner.current, player, stop };
      applyListenSpeed(player, rate);
      player.addListener(
        'playbackStatusUpdate',
        listenStatusHandler({
          isCurrent: () => mounted.current && request === generation.current,
          onProgress: setProgress,
          onPlaying: () => dispatch('play'),
          onFinish: stop,
          onError: () => {
            stop();
            setFailure(LISTEN_FAILED);
            dispatch('fail');
            // The player cannot say why; ask the same URL as plain HTTP for a refused own key.
            void probeSpeechKeyError(fetch, source.uri, source.headers).then((probed) => {
              noteListenFailure(agentId, probed);
              if (probed !== undefined && mounted.current) setFailure(listenFailureMessage(probed));
            });
          },
        }),
      );
      player.play();
    } catch (error) {
      if (request === generation.current) {
        stop();
        noteListenFailure(agentId, error);
        setFailure(listenFailureMessage(error));
        dispatch('fail');
      }
    }
  }, [agentId, messageId, state, stop]);

  const seek = useCallback(
    (target: number) => {
      const player = owned.current;
      if (!player || !progress) return;
      const to = clampSeek(target, progress.duration);
      if (to === undefined) return;
      setProgress({ position: to, duration: progress.duration });
      player.seekTo(to).catch(() => undefined);
    },
    [progress],
  );

  const seekAt = useCallback(
    (event: GestureResponderEvent) => {
      const length = progress && knownDuration(progress.duration);
      if (length === undefined || trackWidth <= 0) return;
      seek((event.nativeEvent.locationX / trackWidth) * length);
    },
    [progress, seek, trackWidth],
  );

  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (!progress) return;
      const step =
        event.nativeEvent.actionName === 'increment' ? SEEK_STEP_SECONDS : -SEEK_STEP_SECONDS;
      seek(progress.position + step);
    },
    [progress, seek],
  );

  const changeSpeed = useCallback(() => {
    const next = nextListenSpeed(speed);
    setSpeed(next);
    if (owned.current) applyListenSpeed(owned.current, next);
    void listenSpeed.set(next);
  }, [speed]);

  useEffect(() => {
    if (autoPlay && !playedAutomatically.current) {
      playedAutomatically.current = true;
      void press();
    }
  }, [autoPlay, press]);

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={state === 'playing' ? 'Stop' : `Listen to ${name}'s reply`}
        onPress={() => void press()}
        style={styles.button}
      >
        {state === 'loading' ? (
          <ActivityIndicator size="small" color={palette.accent} />
        ) : (
          <Icon name="volume" size={16} color={palette.accent} />
        )}
        <Text style={[styles.label, { color: palette.accent }]}>
          {state === 'loading' ? 'Loading…' : state === 'playing' ? 'Stop' : 'Listen'}
        </Text>
      </Pressable>
      {state === 'playing' && progress && (
        <View style={styles.progressRow}>
          <View
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Position"
            accessibilityValue={{ text: progressText(progress) }}
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={onAccessibilityAction}
            onLayout={(event: LayoutChangeEvent) => setTrackWidth(event.nativeEvent.layout.width)}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={seekAt}
            onResponderRelease={seekAt}
            style={styles.track}
          >
            <View style={[styles.rail, { backgroundColor: palette.inactive }]}>
              {progressFraction(progress) !== undefined && (
                <View
                  style={[
                    styles.fill,
                    {
                      backgroundColor: palette.accent,
                      width: `${(progressFraction(progress) ?? 0) * 100}%`,
                    },
                  ]}
                />
              )}
            </View>
          </View>
          <Text style={[styles.time, { color: palette.textSecondary }]}>
            {formatClock(progress.position)} /{' '}
            {knownDuration(progress.duration) === undefined
              ? '-:--'
              : formatClock(progress.duration)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Speed ${speedLabel(speed)}. Change speed`}
            onPress={changeSpeed}
            style={styles.speed}
          >
            <Text style={[styles.label, { color: palette.accent }]}>{speedLabel(speed)}</Text>
          </Pressable>
        </View>
      )}
      {state === 'error' && (
        <Text accessibilityLiveRegion="polite" style={[styles.error, { color: palette.danger }]}>
          {failure}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'flex-start', marginLeft: 12 },
  button: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
  },
  label: { fontFamily: font.caption, fontSize: type.caption.fontSize },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8, width: 260 },
  track: { flex: 1, minHeight: 44, justifyContent: 'center' },
  rail: { height: 3, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 3 },
  time: {
    fontFamily: font.caption,
    fontSize: type.caption.fontSize,
    fontVariant: ['tabular-nums'],
  },
  speed: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  error: { fontFamily: font.caption, fontSize: type.caption.fontSize, paddingBottom: 8 },
});
