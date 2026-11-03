import type { ListeningProvider, SpeechProvider } from '@twring/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';

import { twringApi } from '@/api';
import { ApiError } from '@/api/client';
import { apiErrorCopy, type ErrorCopy } from '@/api/errors';
import { Choice } from '@/components/Choice';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Field } from '@/components/Field';
import { GhostButton } from '@/components/GhostButton';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { useResource } from '@/hooks/useResource';
import { playCallFeedback } from '@/platform/haptics';
import {
  LISTENING_PROVIDERS,
  SPEECH_PROVIDERS,
  addedLine,
  listeningChoiceShown,
  providerCovers,
  providerLabel,
  removeConfirmMessage,
} from '@/settings/voice-accounts';
import { radius, space, type, usePalette } from '@/theme/tokens';

/**
 * A refused switch (400 no key, 429 too many) shows the server's sentence; anything else (offline,
 * timeout, server trouble) says the switch did not happen and who still listens.
 */
function listeningErrorCopy(
  reason: unknown,
  wanted: ListeningProvider,
  current: ListeningProvider,
): ErrorCopy {
  const copy = apiErrorCopy(reason);
  if (
    reason instanceof ApiError &&
    (reason.status === 400 || reason.status === 429) &&
    reason.serverMessage !== undefined &&
    reason.serverMessage !== ''
  ) {
    return { ...copy, message: reason.serverMessage };
  }
  return {
    ...copy,
    message: `Couldn't switch listening to ${providerLabel(wanted)}. ${providerLabel(current)} still listens. Try again.`,
  };
}

/** Settings, Your own voice accounts: use a person's own Deepgram, Cartesia or xAI key. */
export default function VoiceAccountsScreen() {
  const palette = usePalette();
  const load = useCallback(async (signal: AbortSignal) => {
    const api = twringApi();
    if (api === undefined) throw new Error('not configured');
    return api.speechKeyState(signal);
  }, []);
  const keys = useResource(load);
  // The latest read, so a switch that lands after a re-read pins to that read, not the tap's.
  const dataRef = useRef(keys.data);
  useEffect(() => {
    dataRef.current = keys.data;
  }, [keys.data]);
  const [editing, setEditing] = useState<SpeechProvider>();
  // Held only while typing; cleared on save and cancel, never kept after.
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ErrorCopy>();
  const [removeError, setRemoveError] = useState<ErrorCopy>();
  // Shown at once on tap; cleared when the server answers (kept on success, rolled back on failure).
  const [pendingListening, setPendingListening] = useState<ListeningProvider>();
  const [listeningError, setListeningError] = useState<ErrorCopy>();
  // The choice the server accepted, held until a fresh read replaces the data it was made against.
  const [saved, setSaved] = useState<{ provider: ListeningProvider; against: unknown }>();
  const savedListening =
    saved !== undefined && saved.against === keys.data ? saved.provider : undefined;
  const listening = pendingListening ?? savedListening ?? keys.data?.listening;

  function chooseListening(provider: ListeningProvider) {
    const api = twringApi();
    if (api === undefined || pendingListening !== undefined || provider === listening) return;
    setPendingListening(provider);
    setListeningError(undefined);
    api.setListeningProvider(provider).then(
      () => {
        setSaved({ provider, against: dataRef.current });
        setPendingListening(undefined);
        keys.reload({ silent: true });
        playCallFeedback('connected');
      },
      (reason: unknown) => {
        setPendingListening(undefined);
        setListeningError(listeningErrorCopy(reason, provider, listening ?? 'deepgram'));
        playCallFeedback('error');
        // The keys may have changed elsewhere; re-read so the choice matches the server.
        keys.reload({ silent: true });
      },
    );
  }

  function startEditing(provider: SpeechProvider) {
    setEditing(provider);
    setDraft('');
    setSaveError(undefined);
    setRemoveError(undefined);
  }

  function stopEditing() {
    setEditing(undefined);
    setDraft('');
    setSaveError(undefined);
  }

  function save(provider: SpeechProvider) {
    const api = twringApi();
    if (api === undefined || saving) return;
    setSaving(true);
    setSaveError(undefined);
    api.saveSpeechKey(provider, draft.trim()).then(
      () => {
        setSaving(false);
        stopEditing();
        playCallFeedback('connected');
        keys.reload({ silent: true });
      },
      (reason: unknown) => {
        setSaving(false);
        setSaveError(apiErrorCopy(reason, { provider }));
        playCallFeedback('error');
      },
    );
  }

  function confirmRemove(provider: SpeechProvider) {
    Alert.alert(removeConfirmMessage(provider), undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          setRemoveError(undefined);
          setListeningError(undefined);
          twringApi()
            ?.removeSpeechKey(provider)
            .then(
              () => keys.reload({ silent: true }),
              (reason: unknown) => {
                setRemoveError(apiErrorCopy(reason, { provider }));
                keys.reload({ silent: true });
              },
            );
        },
      },
    ]);
  }

  return (
    <Screen title="Your own voice accounts" back>
      <Text style={[type.body, { color: palette.textSecondary }]}>
        Use your own Deepgram, Cartesia or xAI account for listening and voice. Without a key,
        Twring's own voice account is used.
      </Text>
      {keys.loading && (
        <ActivityIndicator accessibilityLabel="Loading" color={palette.textSecondary} />
      )}
      {keys.error !== undefined && <ErrorNotice error={keys.error} onRetry={() => keys.reload()} />}
      {removeError !== undefined && <ErrorNotice error={removeError} />}
      {keys.data !== undefined &&
        SPEECH_PROVIDERS.map((provider) => {
          const added =
            keys.data?.providers.find((row) => row.provider === provider)?.added ?? null;
          return (
            <View key={provider} style={[styles.card, { borderColor: palette.border }]}>
              <Text style={[type.title, { color: palette.textPrimary }]}>
                {providerLabel(provider)}
              </Text>
              <Text style={[type.body, { color: palette.textSecondary }]}>
                {providerCovers(provider)}
              </Text>
              <Text style={[type.body, { color: palette.textPrimary }]}>
                {added === null ? 'No key added' : addedLine(added)}
              </Text>
              {editing === provider ? (
                <View style={styles.form}>
                  <Field
                    label={`${providerLabel(provider)} key`}
                    placeholder="Paste your key"
                    value={draft}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    textContentType="none"
                    onChangeText={(value) => {
                      setDraft(value);
                      setSaveError(undefined);
                    }}
                  />
                  {saveError !== undefined && <ErrorNotice error={saveError} />}
                  <PrimaryButton
                    label={saving ? 'Checking…' : 'Save'}
                    disabled={saving || draft.trim() === ''}
                    onPress={() => save(provider)}
                  />
                  <GhostButton label="Cancel" disabled={saving} onPress={stopEditing} />
                </View>
              ) : (
                <View style={styles.actions}>
                  <GhostButton
                    label={added === null ? 'Add key' : 'Replace'}
                    accessibilityHint={`${added === null ? 'Add' : 'Replace'} ${providerLabel(provider)} key`}
                    tone="accent"
                    onPress={() => startEditing(provider)}
                  />
                  {added !== null && (
                    <GhostButton
                      label="Remove"
                      accessibilityHint={`Remove ${providerLabel(provider)} key`}
                      tone="danger"
                      onPress={() => confirmRemove(provider)}
                    />
                  )}
                </View>
              )}
            </View>
          );
        })}
      {listeningChoiceShown(keys.data) && (
        <View style={styles.listening}>
          <Text accessibilityRole="header" style={[type.title, { color: palette.textPrimary }]}>
            Listening
          </Text>
          <Text style={[type.body, { color: palette.textSecondary }]}>
            Deepgram and xAI can both listen on your calls. Choose which one does.
          </Text>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="Listening"
            style={styles.choices}
          >
            {LISTENING_PROVIDERS.map((provider) => (
              <Choice
                key={provider}
                label={providerLabel(provider)}
                selected={listening === provider}
                onPress={() => chooseListening(provider)}
              />
            ))}
          </View>
          {listeningError !== undefined && <ErrorNotice error={listeningError} />}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.sm,
  },
  form: { gap: space.md, paddingTop: space.sm },
  actions: { flexDirection: 'row', gap: space.md, paddingTop: space.sm },
  listening: { gap: space.sm },
  choices: { gap: space.sm },
});
