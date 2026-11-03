import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { twringApi } from '@/api';
import { ApiError } from '../../api/client';
import { apiErrorCopy } from '../../api/errors';
import { probeSpeechKeyError } from '../../api/speech-key-probe';
import { Icon } from '@/components/Icon';
import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';

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
  return error instanceof ApiError &&
    (error.code === 'speech_key_refused' || error.code === 'speech_key_unreadable')
    ? apiErrorCopy(error).message
    : LISTEN_FAILED;
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
  const [failure, setFailure] = useState(LISTEN_FAILED);

  const stop = useCallback(() => {
    generation.current++;
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
            if (probed !== undefined) setFailure(listenFailureMessage(probed));
          });
        } else if (status.didJustFinish) stop();
        else if (status.isLoaded && status.playing) dispatch('play');
      });
      player.play();
    } catch (error) {
      if (request === generation.current) {
        stop();
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
  label: { fontFamily: font.caption, fontSize: 12 },
  error: { fontFamily: font.caption, fontSize: 12, paddingBottom: 8 },
});
