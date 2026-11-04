import type { Agent, VoiceListResponse } from '@twring/contracts';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { canEditAgent, VIEW_ONLY_AGENT_NOTE } from '@/agents/shared';
import { pickerSelection, savedVoiceMissing, voiceGroups } from '@/agents/voice-groups';
import { apiErrorCopy, twringApi, type ErrorCopy } from '@/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { Icon } from '@/components/Icon';
import { MiniWave } from '@/components/MiniWave';
import { PrimaryButton } from '@/components/PrimaryButton';
import { goBack, Screen } from '@/components/Screen';
import { Skeleton } from '@/components/Skeleton';
import { useResource } from '@/hooks/useResource';
import { useVoicePreview, voicePreview } from '@/platform/voice-preview';
import { radius, space, type, usePalette } from '@/theme/tokens';

/** Plays or stops one voice's short sample. A 48pt target beside the choice, never inside it. */
function PreviewButton({ voiceId, label }: { voiceId: string; label: string }) {
  const palette = usePalette();
  const preview = useVoicePreview();
  const mine = preview.status !== 'idle' && preview.voiceId === voiceId;
  const status = mine ? preview.status : 'idle';
  return (
    <View style={styles.preview}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          status === 'playing' || status === 'loading'
            ? `Stop ${label} sample`
            : `Play ${label} sample`
        }
        accessibilityState={{ busy: status === 'loading' }}
        onPress={() => voicePreview.toggle(voiceId)}
        hitSlop={6}
        style={({ pressed }) => [
          styles.previewButton,
          {
            borderColor: status === 'playing' ? palette.borderAccent : palette.border,
            backgroundColor: status === 'playing' ? 'rgba(25,214,242,0.12)' : palette.surface,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        <Icon
          name={status === 'playing' || status === 'loading' ? 'stop' : 'play'}
          size={15}
          color={palette.accent}
        />
      </Pressable>
      {status === 'failed' && (
        <View style={styles.failed}>
          <Text
            accessibilityLiveRegion="polite"
            style={[type.caption, { color: palette.textSecondary }]}
          >
            {preview.status === 'failed' && preview.message
              ? preview.message
              : 'Sample unavailable'}
          </Text>
          <GhostButton label="Retry" tone="accent" onPress={() => voicePreview.toggle(voiceId)} />
        </View>
      )}
    </View>
  );
}

/** Change an agent's voice. Saving applies from the next call. */
export default function VoiceScreen() {
  const palette = usePalette();
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ErrorCopy | undefined>(undefined);

  const load = useCallback(
    async (signal: AbortSignal): Promise<{ agent: Agent; voices: VoiceListResponse }> => {
      const api = twringApi();
      if (api === undefined) throw new Error('not configured');
      const [agent, voices] = await Promise.all([api.getAgent(id, signal), api.listVoices(signal)]);
      return { agent, voices };
    },
    [id],
  );
  const data = useResource(load);
  const preview = useVoicePreview();
  // Leaving the screen (or starting a call from elsewhere) stops any sample.
  useFocusEffect(useCallback(() => () => voicePreview.stop(), []));
  // A saved voice the server no longer offers (a Grok voice without the xAI key) shows unchosen.
  const selected = pickerSelection(
    choice,
    data.data?.agent.voice_id,
    data.data?.voices.voices ?? [],
  );

  function save() {
    if (selected === undefined) return;
    setSaving(true);
    setSaveError(undefined);
    twringApi()
      ?.updateAgent(id, { voice_id: selected })
      .then(goBack, (reason: unknown) => setSaveError(apiErrorCopy(reason)))
      .finally(() => setSaving(false));
  }

  if (data.data !== undefined && !canEditAgent(data.data.agent)) {
    return (
      <Screen back title="Voice">
        <Text style={[type.body, { color: palette.textSecondary }]}>{VIEW_ONLY_AGENT_NOTE}</Text>
      </Screen>
    );
  }

  return (
    <Screen
      back
      title="Voice"
      footer={
        <PrimaryButton
          label="Save voice"
          disabled={saving || data.data === undefined || selected === undefined}
          onPress={save}
        />
      }
    >
      {data.loading && (
        <View
          accessibilityLabel="Loading voices"
          accessibilityRole="progressbar"
          style={styles.choices}
        >
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} height={64} />
          ))}
        </View>
      )}
      {data.error !== undefined && <ErrorNotice error={data.error} onRetry={() => data.reload()} />}
      {saveError !== undefined && <ErrorNotice error={saveError} />}
      {data.data !== undefined &&
        choice === undefined &&
        savedVoiceMissing(data.data.agent.voice_id, data.data.voices.voices) && (
          <Text style={[type.body, { color: palette.textSecondary }]}>
            This agent's voice is no longer available. Choose another.
          </Text>
        )}
      <View accessibilityRole="radiogroup" accessibilityLabel="Voices" style={styles.choices}>
        {voiceGroups(data.data?.voices.voices ?? []).map((group) => (
          <View key={group.label ?? 'usual'} style={styles.choices}>
            {group.label !== undefined && (
              <Text style={[type.caption, { color: palette.textSecondary }]}>{group.label}</Text>
            )}
            {group.note !== undefined && (
              <Text style={[type.caption, { color: palette.textSecondary }]}>{group.note}</Text>
            )}
            {group.voices.map((voice) => (
              <View
                key={voice.id}
                style={[
                  styles.row,
                  {
                    backgroundColor:
                      selected === voice.id ? 'rgba(25,214,242,0.07)' : palette.surface,
                    borderColor: selected === voice.id ? palette.borderAccent : palette.border,
                  },
                ]}
              >
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected === voice.id }}
                  accessibilityLabel={voice.label}
                  onPress={() => setChoice(voice.id)}
                  style={styles.choice}
                >
                  <Text style={[type.body, { color: palette.textPrimary }]}>{voice.label}</Text>
                  {preview.status === 'playing' && preview.voiceId === voice.id && (
                    <MiniWave size={22} color={palette.accent} active />
                  )}
                  {selected === voice.id && <Icon name="check" size={18} color={palette.accent} />}
                </Pressable>
                <PreviewButton voiceId={voice.id} label={voice.label} />
              </View>
            ))}
          </View>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  choices: { gap: space.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.sm,
  },
  choice: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
  },
  preview: { alignItems: 'center', gap: space.xs },
  previewButton: {
    height: 36,
    width: 36,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  failed: { alignItems: 'center', gap: space.xs },
});
