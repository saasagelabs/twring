import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View, type TextInputProps } from 'react-native';

import { checkAccess, recheckAccess, redeem, useAccess, useRecheckOnReturn } from '@/access/store';
import { authController, useAuth } from '@/auth';
import { TwringLockup } from '@/components/Brand';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Field } from '@/components/Field';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { TextButton } from '@/components/TextButton';
import { playCallFeedback } from '@/platform/haptics';
import { space, type, usePalette } from '@/theme/tokens';
import type { ErrorCopy } from '@/api/errors';

export default function WaitlistScreen() {
  const palette = usePalette();
  const auth = useAuth();
  const access = useAccess();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCopy | undefined>();
  // Codes are a backup now (people get in automatically): the box stays out of the way.
  const [withCode, setWithCode] = useState(false);
  const [stillFull, setStillFull] = useState(false);
  useRecheckOnReturn();
  const email = access.status === 'waitlist' ? access.email : undefined;
  const accountEmail = email ?? (auth.status === 'signed_in' ? auth.email : undefined);

  async function activate() {
    if (busy || code.length !== 6) return;
    setBusy(true);
    setError(undefined);
    const result = await redeem(code);
    setBusy(false);
    if (result.ok) playCallFeedback('connected');
    else {
      setError(result.error);
      playCallFeedback('error');
    }
  }

  return (
    <Screen
      footer={
        withCode ? (
          <PrimaryButton
            label="Activate account"
            disabled={busy || code.length !== 6}
            accessibilityHint="Redeems your six-digit invite code"
            onPress={() => void activate()}
          />
        ) : undefined
      }
    >
      <View style={styles.top}>
        <View style={styles.lockup}>
          <TwringLockup size={24} />
        </View>
        <Text accessibilityRole="header" style={[type.display, { color: palette.textPrimary }]}>
          You're almost in
        </Text>
        <Text
          accessibilityRole={access.status === 'error' ? 'alert' : undefined}
          accessibilityLiveRegion={access.status === 'error' ? 'polite' : undefined}
          style={[type.body, { color: palette.textSecondary }]}
        >
          {access.status === 'error'
            ? "Couldn't check your access. Check your connection and try again."
            : "Twring lets in a set number of people each day so every call works well, and today's places are taken. New places open every day: open Twring again tomorrow."}
        </Text>
        {access.status === 'error' ? (
          <TextButton label="Try again" onPress={() => void checkAccess()} />
        ) : (
          <TextButton
            label="Check again"
            accessibilityHint="Checks whether a place is free now"
            onPress={() => {
              void recheckAccess().then(() => setStillFull(true));
            }}
          />
        )}
        {withCode ? (
          <Field
            label="Invite code"
            placeholder="123456"
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            {...({ inputMode: 'numeric', maxLength: 7 } satisfies TextInputProps)}
            value={code}
            onChangeText={(value) => {
              setCode(value.replace(/\D/g, '').slice(0, 6));
              setError(undefined);
            }}
            inputStyle={styles.code}
          />
        ) : (
          <TextButton
            label="I have an invite code"
            accessibilityHint="Shows a box for a six-digit invite code"
            onPress={() => setWithCode(true)}
          />
        )}
        {stillFull && access.status === 'waitlist' && (
          <Text
            accessibilityLiveRegion="polite"
            style={[type.body, { color: palette.textSecondary }]}
          >
            Still full today. Try again tomorrow.
          </Text>
        )}
        {error !== undefined && <ErrorNotice error={error} />}
        {accountEmail !== undefined && (
          <Text style={[type.body, { color: palette.textSecondary }]}>
            Signed in as{' '}
            <Text style={[type.bodyEmphasis, { color: palette.textPrimary }]}>{accountEmail}</Text>.
          </Text>
        )}
        <View style={styles.links}>
          <TextButton
            label="Sign out"
            accessibilityHint="Signs out of this account"
            onPress={() => void authController()?.signOut()}
          />
          <TextButton label="Privacy" onPress={() => router.push('/privacy')} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { gap: space.lg, paddingTop: space.lg },
  lockup: { alignItems: 'center' },
  code: { ...type.title, letterSpacing: 5 },
  links: { flexDirection: 'row', justifyContent: 'center', gap: space.lg },
});
