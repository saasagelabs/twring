import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Animated, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { File } from 'expo-file-system';
import { useReducedMotion } from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { font } from '@/theme/fonts';
import { usePalette, radius, type } from '@/theme/tokens';
import { callDuration } from '@/threads/presentation';
import { canSend, composerAction, COMPOSER_LIMIT } from './composer-state';
import { AttachSheet } from './AttachSheet';
import { AttachmentTray } from './AttachmentTray';
import type { PreparedFile } from '@/threads/files';
import Svg, { Path } from 'react-native-svg';
import { reportClientError } from '@/observability/sentry';

export { canSend, composerAction, COMPOSER_LIMIT } from './composer-state';
/**
 * Speech, not music: AAC in .m4a, mono, 16 kHz, 32 kbps. Two minutes is about 0.5 MB, well under
 * the gateway's 2 MB limit (HIGH_QUALITY, stereo 128 kbps, would be about 1.9 MB).
 */
const VOICE_NOTE_PRESET = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 32_000,
};
function removeRecording(uri: string | null): void {
  if (uri)
    try {
      new File(uri).delete();
    } catch {
      /* Already removed. */
    }
}
export function Composer({
  name,
  value,
  onChange,
  onSend,
  onVoiceSend,
  files,
  filesAvailable,
  onAddFiles,
  onRemoveFile,
  disabled,
}: {
  name: string;
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onVoiceSend: (uri: string, durationMs: number) => void;
  files?: PreparedFile[];
  filesAvailable?: boolean;
  onAddFiles?: (files: PreparedFile[]) => void;
  onRemoveFile?: (clientId: string) => void;
  disabled?: boolean;
}) {
  const palette = usePalette();
  const [height, setHeight] = useState(24);
  const recorder = useAudioRecorder(VOICE_NOTE_PRESET);
  const reducedMotion = useReducedMotion();
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const fileCount = files?.length ?? 0;
  const started = useRef(0);
  const stopped = useRef(false);
  const autoStopped = useRef(false);
  const active = useRef(false);
  const autoStopPromise = useRef<Promise<void> | null>(null);
  const [opacity] = useState(() => new Animated.Value(1));
  const stop = async (send: boolean) => {
    if (stopped.current && !autoStopped.current) return;
    stopped.current = true;
    const durationMs = Math.min(120_000, Date.now() - started.current);
    try {
      if (autoStopped.current) await autoStopPromise.current;
      else await recorder.stop();
      if (send && durationMs >= 1_000 && recorder.uri) onVoiceSend(recorder.uri, durationMs);
      else removeRecording(recorder.uri);
    } catch (error) {
      reportClientError('voice_stop', error);
      removeRecording(recorder.uri);
      setNote("Couldn't record the voice note. Try again.");
    } finally {
      setRecording(false);
      active.current = false;
      autoStopped.current = false;
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(
        (error: unknown) => reportClientError('voice_audio_reset', error),
      );
    }
  };
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const seconds = Math.min(120, Math.floor((Date.now() - started.current) / 1000));
      setElapsed(seconds);
      if (seconds >= 120 && !stopped.current) {
        stopped.current = true;
        autoStopped.current = true;
        autoStopPromise.current = recorder
          .stop()
          .then(() => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }))
          .catch((error: unknown) => {
            reportClientError('voice_auto_stop', error);
            throw error;
          });
      }
    }, 250);
    return () => clearInterval(timer);
  }, [recording, recorder]);
  useEffect(() => {
    if (!recording || reducedMotion) {
      opacity.setValue(1);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [recording, reducedMotion, opacity]);
  useFocusEffect(
    useCallback(
      () => () => {
        if (active.current) {
          active.current = false;
          stopped.current = true;
          setRecording(false);
          void (
            recorder.isRecording ? recorder.stop() : (autoStopPromise.current ?? Promise.resolve())
          )
            .finally(() => {
              removeRecording(recorder.uri);
              return setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
            })
            .catch((error: unknown) => reportClientError('voice_cleanup', error));
        }
      },
      [recorder],
    ),
  );
  const start = async () => {
    let stage = 'voice_permission';
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setNote('Allow the microphone in Settings to send voice notes.');
        return;
      }
      setNote('');
      stage = 'voice_audio_mode';
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      stage = 'voice_prepare';
      await recorder.prepareToRecordAsync();
      stopped.current = false;
      autoStopped.current = false;
      started.current = Date.now();
      setElapsed(0);
      stage = 'voice_record';
      recorder.record();
      active.current = true;
      setRecording(true);
    } catch (error) {
      reportClientError(stage, error);
      setNote("Couldn't record the voice note. Try again.");
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(
        (reason: unknown) => reportClientError('voice_audio_reset', reason),
      );
    }
  };
  return (
    <View>
      {filesAvailable && (
        <AttachmentTray files={files ?? []} onRemove={(clientId) => onRemoveFile?.(clientId)} />
      )}
      {recording ? (
        <View style={styles.recordRow}>
          <Animated.View style={[styles.dot, { opacity }]} />
          <Text style={[styles.timer, { color: palette.textPrimary }]}>
            {callDuration(elapsed)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel voice note"
            onPress={() => void stop(false)}
            style={styles.action}
          >
            <Text style={[styles.actionLabel, { color: palette.textPrimary }]}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send voice note"
            onPress={() => void stop(true)}
            style={[styles.action, { backgroundColor: palette.accent }]}
          >
            <Text style={[styles.actionLabel, { color: palette.onAccent }]}>Send</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.row}>
          {filesAvailable && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Attach"
              disabled={disabled}
              onPress={() => setAttachOpen(true)}
              style={styles.attach}
            >
              <Svg
                width={22}
                height={22}
                viewBox="0 0 24 24"
                fill="none"
                stroke={palette.textPrimary}
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <Path d="m21 11.5-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8-8" />
              </Svg>
            </Pressable>
          )}
          <View
            style={[
              styles.field,
              { backgroundColor: palette.surface, borderColor: palette.border },
            ]}
          >
            <TextInput
              accessibilityLabel={`Message ${name}`}
              multiline
              editable={!disabled}
              maxLength={COMPOSER_LIMIT}
              value={value}
              onChangeText={onChange}
              onKeyPress={(event) => {
                const key = event.nativeEvent as { key: string; shiftKey?: boolean };
                if (key.key === 'Enter' && !key.shiftKey && canSend(value, fileCount)) {
                  event.preventDefault();
                  onSend();
                }
              }}
              onContentSizeChange={(event) =>
                setHeight(Math.min(144, Math.max(24, event.nativeEvent.contentSize.height)))
              }
              placeholder={disabled ? `You're on a call with ${name}` : `Message ${name}`}
              placeholderTextColor={palette.textTertiary}
              style={[styles.input, { color: palette.textPrimary, height }]}
            />
          </View>
          {composerAction(value, !!disabled, fileCount) !== 'none' && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={canSend(value, fileCount) ? 'Send' : 'Record voice note'}
              onPress={canSend(value, fileCount) ? onSend : () => void start()}
              style={[styles.send, { backgroundColor: palette.accent }]}
            >
              <Icon
                name={canSend(value, fileCount) ? 'send' : 'mic'}
                color={palette.onAccent}
                size={20}
              />
            </Pressable>
          )}
        </View>
      )}
      {!!note && <Text style={[styles.note, { color: palette.danger }]}>{note}</Text>}
      {filesAvailable && (
        <AttachSheet
          visible={attachOpen}
          count={fileCount}
          onClose={() => setAttachOpen(false)}
          onAdd={(picked) => onAddFiles?.(picked)}
          onNote={setNote}
        />
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  attach: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  field: {
    flex: 1,
    borderRadius: radius.xl,
    borderWidth: 1,
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  input: {
    fontFamily: font.body,
    fontSize: type.body.fontSize,
    lineHeight: 22,
    padding: 0,
    textAlignVertical: 'top',
  },
  send: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#EF4444' },
  timer: { flex: 1, fontFamily: font.mono, fontSize: type.body.fontSize },
  action: {
    minHeight: 48,
    minWidth: 64,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionLabel: { fontFamily: font.bodyEmphasis, fontSize: type.body.fontSize },
  note: {
    paddingHorizontal: 18,
    paddingBottom: 8,
    fontFamily: font.body,
    fontSize: type.caption.fontSize,
  },
});
