import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { twringApi } from '@/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Field } from '@/components/Field';
import { GhostButton } from '@/components/GhostButton';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { recoveryApi } from '@/e2e/pair-api';
import {
  newRecoveryWords,
  RECOVERY_CHECK_POSITIONS,
  RECOVERY_COPY,
  restoreFromWords,
  restoreOffer,
  saveRecoveryKey,
  wroteDown,
  type RestoreFailure,
  type SaveFailure,
} from '@/e2e/recovery';
import type { RecoveryBackupResponse } from '@twring/contracts';
import { playCallFeedback } from '@/platform/haptics';
import { currentScope, privateKeychain } from '@/threads/chats';
import { font } from '@/theme/fonts';
import { space, type, usePalette } from '@/theme/tokens';

type Step =
  | { kind: 'intro' }
  | { kind: 'words'; words: string[] }
  | { kind: 'check'; words: string[] }
  | { kind: 'saved' }
  | { kind: 'loading' }
  | { kind: 'enter'; backup: RecoveryBackupResponse }
  | { kind: 'removed' }
  | { kind: 'restored' };

const SAVE_COPY: Record<SaveFailure, string> = {
  no_device: RECOVERY_COPY.noDevice,
  network: RECOVERY_COPY.network,
  refused: RECOVERY_COPY.refused,
};
const RESTORE_COPY: Record<RestoreFailure, string> = {
  wrong_words: RECOVERY_COPY.wrongWords,
  damaged: RECOVERY_COPY.damaged,
  has_key: RECOVERY_COPY.hasKey,
};

/** Word inputs never go to a keyboard's memory: no autocorrect, suggestions or autofill. */
const WORD_INPUT = {
  autoCapitalize: 'none',
  autoCorrect: false,
  spellCheck: false,
  autoComplete: 'off',
  importantForAutofill: 'no',
  textContentType: 'none',
  keyboardType: 'visible-password',
} as const;

const deps = (account: string) => ({ api: recoveryApi(), store: privateKeychain(), account });

/** The account's device list, so a restore drops computers removed since the backup. */
function devicesList() {
  const api = twringApi();
  if (api?.privateDevices === undefined) return {};
  return { devices: { list: () => api.privateDevices!() } };
}

/**
 * The optional recovery key for private chats (C3 #11). `?mode=create` shows 12 words once and
 * asks back two of them before saving; `?mode=restore` puts this phone's key back from them.
 * The words live only in this screen's state.
 */
export default function PrivateRecoveryScreen() {
  const palette = usePalette();
  const params = useLocalSearchParams<{ mode?: string; agentId?: string }>();
  const restoring = params.mode === 'restore';
  // Opened from an agent's "Make chats private" via pairing: finishing returns there, as pairing would.
  const agentId = typeof params.agentId === 'string' && params.agentId ? params.agentId : undefined;
  const finish = () =>
    agentId === undefined
      ? router.back()
      : router.dismissTo({ pathname: '/agents/[id]', params: { id: agentId, private: 'ask' } });
  const [step, setStep] = useState<Step>(restoring ? { kind: 'loading' } : { kind: 'intro' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [checks, setChecks] = useState<string[]>(['', '']);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!restoring) return;
    let live = true;
    void restoreOffer({ api: recoveryApi(), store: privateKeychain() }).then(
      (offer) => {
        if (!live) return;
        if (offer.kind === 'found') setStep({ kind: 'enter', backup: offer.backup });
        else if (offer.kind === 'removed') setStep({ kind: 'removed' });
        else if (offer.kind === 'network') setError(RECOVERY_COPY.network);
        else router.replace('/private/pair');
      },
      () => live && setError(RECOVERY_COPY.network),
    );
    return () => {
      live = false;
    };
  }, [restoring]);

  const account = currentScope();
  const pairInstead = () => router.replace('/private/pair');

  const onSave = async (words: string[]) => {
    if (busy || account === undefined) return;
    if (!wroteDown(words, checks)) {
      playCallFeedback('error');
      setError(RECOVERY_COPY.wrongWords);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await saveRecoveryKey(deps(account), words);
      if (result.ok) {
        playCallFeedback('connected');
        setStep({ kind: 'saved' });
      } else {
        playCallFeedback('error');
        setError(SAVE_COPY[result.code]);
      }
    } catch {
      setError(RECOVERY_COPY.network);
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async (backup: RecoveryBackupResponse) => {
    if (busy || account === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await restoreFromWords({ ...deps(account), ...devicesList() }, backup, typed);
      if (result.ok) {
        playCallFeedback('connected');
        setTyped('');
        setStep({ kind: 'restored' });
      } else {
        playCallFeedback('error');
        setError(RESTORE_COPY[result.code]);
      }
    } catch {
      setError(RECOVERY_COPY.damaged);
    } finally {
      setBusy(false);
    }
  };

  const heading = (text: string) => (
    <Text accessibilityRole="header" style={[styles.heading, { color: palette.textPrimary }]}>
      {text}
    </Text>
  );
  const support = (text: string) => (
    <Text style={[styles.support, { color: palette.textSecondary }]}>{text}</Text>
  );
  const notice = error !== undefined && <ErrorNotice error={{ message: error, retryable: true }} />;
  const done = <PrimaryButton label="Done" onPress={finish} />;

  switch (step.kind) {
    case 'intro':
      return (
        <Screen
          title="Recovery key"
          back
          footer={
            <View style={styles.actions}>
              <PrimaryButton
                label="Show my 12 words"
                onPress={() => setStep({ kind: 'words', words: newRecoveryWords() })}
              />
              <GhostButton label="Not now" onPress={finish} />
            </View>
          }
        >
          <View style={styles.step}>
            {heading('Save a recovery key')}
            {support(RECOVERY_COPY.offer)}
            {support(
              'You get 12 words. Write them on paper and keep them safe. Twring never sees them and can not show them again.',
            )}
            {support(RECOVERY_COPY.replaces)}
          </View>
        </Screen>
      );
    case 'words':
      return (
        <Screen
          title="Recovery key"
          back
          footer={
            <PrimaryButton
              label="I wrote them down"
              onPress={() => {
                setChecks(['', '']);
                setError(undefined);
                setStep({ kind: 'check', words: step.words });
              }}
            />
          }
        >
          <View style={styles.step}>
            {heading('Write these 12 words down')}
            {support('In this order. Anyone with them can read your private chats.')}
            <View style={styles.words}>
              {step.words.map((word, i) => (
                <Text
                  key={i}
                  style={[styles.word, { color: palette.textPrimary }]}
                  accessibilityLabel={`Word ${i + 1}: ${word}`}
                >
                  {`${i + 1}. ${word}`}
                </Text>
              ))}
            </View>
          </View>
        </Screen>
      );
    case 'check':
      return (
        <Screen
          title="Recovery key"
          back
          footer={
            <View style={styles.actions}>
              <PrimaryButton
                label="Save recovery key"
                disabled={busy || checks.some((c) => c.trim() === '')}
                onPress={() => void onSave(step.words)}
              />
              <GhostButton
                label="Show the words again"
                disabled={busy}
                onPress={() => setStep({ kind: 'words', words: step.words })}
              />
            </View>
          }
        >
          <View style={styles.step}>
            {heading('Check your words')}
            {RECOVERY_CHECK_POSITIONS.map((position, i) => (
              <Field
                key={position}
                label={`Word ${position}`}
                value={checks[i] ?? ''}
                onChangeText={(text) =>
                  setChecks((current) => current.map((c, j) => (j === i ? text : c)))
                }
                maxLength={16}
                {...WORD_INPUT}
              />
            ))}
            {notice}
            {busy && <ActivityIndicator accessibilityLabel="Saving" />}
          </View>
        </Screen>
      );
    case 'saved':
      return (
        <Screen title="Recovery key" footer={done}>
          <View style={styles.step}>
            {heading('Recovery key saved')}
            {support('Keep the paper safe. A new phone can use it to read your private chats.')}
          </View>
        </Screen>
      );
    case 'loading':
      return (
        <Screen
          title="Recovery key"
          back
          footer={
            error !== undefined ? (
              <GhostButton label="Pair this phone instead" onPress={pairInstead} />
            ) : undefined
          }
        >
          <View style={styles.step}>
            {notice || <ActivityIndicator accessibilityLabel="Checking" />}
          </View>
        </Screen>
      );
    case 'enter':
      return (
        <Screen
          title="Recovery key"
          back
          footer={
            <View style={styles.actions}>
              <PrimaryButton
                label="Restore"
                disabled={busy || typed.trim() === ''}
                onPress={() => void onRestore(step.backup)}
              />
              <GhostButton label="Pair this phone instead" disabled={busy} onPress={pairInstead} />
            </View>
          }
        >
          <View style={styles.step}>
            {heading('Type your 12 words')}
            {support('The words you wrote down when you saved a recovery key, in order.')}
            <Field
              label="Your 12 words"
              hint="Separate them with spaces"
              value={typed}
              onChangeText={setTyped}
              maxLength={200}
              multiline
              {...WORD_INPUT}
            />
            {notice}
            {busy && <ActivityIndicator accessibilityLabel="Checking" />}
          </View>
        </Screen>
      );
    case 'removed':
      return (
        <Screen
          title="Recovery key"
          back
          footer={<PrimaryButton label="Pair this phone" onPress={pairInstead} />}
        >
          <View style={styles.step}>
            {heading('Recovery key not usable')}
            {support(RECOVERY_COPY.removed)}
          </View>
        </Screen>
      );
    case 'restored':
      return (
        <Screen title="Recovery key" footer={done}>
          <View style={styles.step}>
            {heading('Restored')}
            {support('Private: only your phone and your computer can read this')}
          </View>
        </Screen>
      );
  }
}

const styles = StyleSheet.create({
  step: { gap: space.lg },
  actions: { gap: space.md },
  words: { gap: space.sm },
  heading: { fontFamily: font.display, fontSize: type.screenTitle.fontSize, letterSpacing: -0.8 },
  support: { fontFamily: font.body, fontSize: type.body.fontSize },
  word: { fontFamily: font.body, fontSize: type.body.fontSize },
});
