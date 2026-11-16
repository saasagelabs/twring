import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { twringApi } from '@/api';
import { ApiError } from '../../api/client';
import { apiErrorCopy } from '../../api/errors';
import { probeSpeech, probeSpeechKeyError } from '../../api/speech-key-probe';
import { Icon } from '@/components/Icon';
import { font } from '@/theme/fonts';
import { usePalette, type } from '@/theme/tokens';

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
 * Set once a Listen came back as a refused own voice key. The native player retries a refused
 * answer several times before it reports a failure (about 5 requests in 4 s), so while this is set
 * the next Listen asks once as plain HTTP first and shows the refusal straight away.
 */
let keyRefused = false;
/** The check before the player is on the tap's path: past this it counts as inconclusive. */
export const LISTEN_PREFLIGHT_TIMEOUT_MS = 4_000;

/** Remembers a refused own key so the next Listen checks first. */
export function noteListenFailure(error: unknown): void {
  if (isSpeechKeyError(error)) keyRefused = true;
}

/** Test helper: back to handing Listen straight to the player. */
export function forgetListenRefusal(): void {
  keyRefused = false;
}

/**
 * Before the player: undefined means play. After a refused own key, the probe runs once: a refusal
 * comes back to show; only a confirmed healthy answer clears the memory. An inconclusive check
 * (network failure, another error) plays as usual but keeps checking first next time.
 */
export async function listenPreflight(
  probe: () => Promise<'ok' | ApiError | undefined>,
): Promise<ApiError | undefined> {
  if (!keyRefused) return undefined;
  const found = await probe();
  if (found === 'ok') keyRefused = false;
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
    dispatch('stop');
  }, []);
  useEffect(
    () => () => {
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
        refused = await listenPreflight(() =>
          probeSpeech(fetch, source.uri, source.headers, check.signal),
        );
      } finally {
        clearTimeout(deadline);
        if (preflight.current === check) preflight.current = undefined;
      }
      if (request !== generation.current) return;
      if (refused !== undefined) throw refused;
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      if (request !== generation.current) return;
      const player = createAudioPlayer(source);
      owned.current = player;
      current = { owner: owner.current, player, stop };
      player.addListener('playbackStatusUpdate', (status) => {
        if (request !== generation.current) return;
        if (status.error) {
          stop();
          setFailure(LISTEN_FAILED);
          dispatch('fail');
          // The player cannot say why; ask the same URL as plain HTTP for a refused own key.
          void probeSpeechKeyError(fetch, source.uri, source.headers).then((probed) => {
            noteListenFailure(probed);
            if (probed !== undefined) setFailure(listenFailureMessage(probed));
          });
        } else if (status.didJustFinish) stop();
        else if (status.isLoaded && status.playing) dispatch('play');
      });
      player.play();
    } catch (error) {
      if (request === generation.current) {
        stop();
        noteListenFailure(error);
        setFailure(listenFailureMessage(error));
        dispatch('fail');
      }
    }
  }, [agentId, messageId, state, stop]);

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
  error: { fontFamily: font.caption, fontSize: type.caption.fontSize, paddingBottom: 8 },
});
