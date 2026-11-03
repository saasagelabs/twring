import { normalizePairingCode, parsePairLink } from '@twring/contracts';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { authController, useAuth } from '@/auth';
import { mobileEnv } from '@/config/env';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Field } from '@/components/Field';
import { PrimaryButton } from '@/components/PrimaryButton';
import { QrScanner } from '@/components/QrScanner';
import { Screen } from '@/components/Screen';
import { TextButton } from '@/components/TextButton';
import { playCallFeedback } from '@/platform/haptics';
import { sealKeys } from '@/platform/seal-keys';
import { normalizeAddress } from '@/servers/address';
import { pairWithServer } from '@/servers/pairing';
import { profileStore } from '@/servers/profiles';
import { checkServer } from '@/servers/server-check';
import { switchToHosted } from '@/servers/switching';
import { font } from '@/theme/fonts';
import { space, type, usePalette } from '@/theme/tokens';

const BAD_CODE = "That code didn't work. Ask for a new one.";

type Step = 'start' | 'scan' | 'type' | 'name';

const SCAN_COPY = {
  needCamera: 'Twring needs the camera to scan the code your server printed.',
  cameraOff:
    'Camera access is off for Twring. Turn it on in your phone settings, or type the address instead.',
  viewfinder: 'Camera viewfinder. Point it at the code your server printed.',
  typeInstead: 'Type the address instead',
};

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/**
 * Use my own server: scan the code the server printed (or type its address and code), then pick
 * a name. The server is checked before anything secret is sent; pairing signs this phone in.
 * Opened while signed in (a pair link), it first offers to sign out, then goes on with the link.
 */
export default function PairScreen() {
  const palette = usePalette();
  const params = useLocalSearchParams<{ server?: string; code?: string; id?: string }>();
  const linked = one(params.server) !== '' && one(params.code) !== '';
  const [step, setStep] = useState<Step>(linked ? 'type' : 'start');
  const [addressText, setAddressText] = useState(one(params.server));
  const [codeText, setCodeText] = useState(one(params.code));
  // From a scanned or opened link: the server the code was printed by.
  const [serverId, setServerId] = useState<string | undefined>(one(params.id) || undefined);
  const [checked, setChecked] = useState<{ address: string; code: string } | undefined>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Changes on every failed try, so the scanner listens again even when the message is the same.
  const [failures, setFailures] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const auth = useAuth();

  const allowHttp = mobileEnv.ok && mobileEnv.env.CORD_ENV === 'development';

  function fail(message: string) {
    setError(message);
    setFailures((count) => count + 1);
    playCallFeedback('error');
  }

  /** Checks the server answers as itself before moving on to the name. */
  async function verify(address: string, code: string, expectedId: string | undefined) {
    if (busy) return;
    const normalized = normalizeAddress(address, { allowHttp });
    if (!normalized.ok) return fail(normalized.message);
    const normalizedCode = normalizePairingCode(code);
    if (normalizedCode === undefined) return fail(BAD_CODE);
    setBusy(true);
    setError(undefined);
    const check = await checkServer(
      normalized.address,
      { serverId: expectedId },
      { fetch: (url, init) => fetch(url, init), now: Date.now, allowHttp },
    );
    setBusy(false);
    if (!check.ok) return fail(check.message);
    setServerId(expectedId);
    setChecked({ address: normalized.address, code: normalizedCode });
    setStep('name');
  }

  async function onScanned(data: string) {
    const parsed = parsePairLink(data);
    if (parsed === undefined) return fail(BAD_CODE);
    await verify(parsed.server, parsed.code, parsed.serverId);
  }

  async function done() {
    const displayName = name.trim();
    if (busy || checked === undefined || displayName === '') return;
    setBusy(true);
    setError(undefined);
    const outcome = await pairWithServer(
      { address: checked.address, code: checked.code, serverId, displayName },
      {
        fetch: (url, init) => fetch(url, init),
        now: Date.now,
        allowHttp,
        store: profileStore,
        sealKeys,
      },
    );
    setBusy(false);
    if (!outcome.ok) return fail(outcome.message);
    playCallFeedback('connected');
    router.replace('/');
  }

  const back = () => {
    setError(undefined);
    setStep('start');
  };
  const notice =
    error === undefined ? null : <ErrorNotice error={{ message: error, retryable: false }} />;
  const heading = (text: string) => (
    <Text accessibilityRole="header" style={[styles.heading, { color: palette.textPrimary }]}>
      {text}
    </Text>
  );
  const support = (text: string) => (
    <Text style={[type.body, { color: palette.textSecondary }]}>{text}</Text>
  );

  async function signOutFirst() {
    if (leaving) return;
    setLeaving(true);
    // Twring's service signs out; a person's own server stays saved for later.
    if (profileStore.active().kind === 'selfhost') await switchToHosted().catch(() => undefined);
    else await authController()?.signOut();
    setLeaving(false);
  }

  if (auth.status === 'signed_in') {
    return (
      <Screen
        title="Use my own server"
        back
        footer={
          <PrimaryButton
            label="Sign out and continue"
            disabled={leaving}
            onPress={() => void signOutFirst()}
          />
        }
      >
        <View style={styles.step}>
          {heading('Join this server')}
          {support('To join this server, sign out first.')}
          {leaving && <ActivityIndicator accessibilityLabel="Signing out" />}
        </View>
      </Screen>
    );
  }

  if (step === 'name') {
    return (
      <Screen
        title="Use my own server"
        back={back}
        footer={
          <PrimaryButton
            label="Done"
            disabled={busy || name.trim() === ''}
            onPress={() => void done()}
          />
        }
      >
        <View style={styles.step}>
          {heading('Your name on this server')}
          {support(
            `You are joining ${checked?.address.replace(/^https?:\/\//, '') ?? 'this server'}. This is how it shows you to the people who run it.`,
          )}
          <Field
            label="Your name"
            value={name}
            onChangeText={setName}
            maxLength={40}
            autoCapitalize="words"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => void done()}
          />
          {notice}
          {busy && <ActivityIndicator accessibilityLabel="Connecting" />}
        </View>
      </Screen>
    );
  }

  if (step === 'type') {
    return (
      <Screen
        title="Use my own server"
        back={back}
        footer={
          <PrimaryButton
            label="Continue"
            disabled={busy || addressText.trim() === '' || codeText.trim() === ''}
            onPress={() => void verify(addressText, codeText, serverId)}
          />
        }
      >
        <View style={styles.step}>
          {heading('Type the address')}
          {support('Both are printed where your server started, for example twring.example.com.')}
          <Field
            label="Server address"
            value={addressText}
            onChangeText={(text) => {
              setAddressText(text);
              setServerId(undefined);
            }}
            placeholder="twring.example.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Field
            label="Code"
            value={codeText}
            onChangeText={setCodeText}
            placeholder="ABCD-EFGH"
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
          />
          {notice}
          {busy && <ActivityIndicator accessibilityLabel="Checking the server" />}
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      title="Use my own server"
      back
      footer={
        step === 'start' ? (
          <PrimaryButton
            label="Scan the code"
            accessibilityHint="Opens the camera"
            onPress={() => setStep('scan')}
          />
        ) : undefined
      }
    >
      <View style={styles.step}>
        {heading('Scan the code your server printed')}
        {support('Point your camera at the code on the screen where your server started.')}
        {notice}
        {step === 'scan' ? (
          <QrScanner
            copy={SCAN_COPY}
            busy={busy}
            attempt={failures}
            onScanned={(data) => void onScanned(data)}
            onTypeInstead={() => {
              setError(undefined);
              setStep('type');
            }}
          />
        ) : (
          <View style={styles.inline}>
            <TextButton label="Type the address instead" onPress={() => setStep('type')} />
          </View>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  step: { gap: space.lg },
  inline: { flexDirection: 'row' },
  heading: { fontFamily: font.display, fontSize: 30, letterSpacing: -0.8 },
});
