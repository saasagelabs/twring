import * as AppleAuthentication from 'expo-apple-authentication';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { authController, useAuth } from '@/auth';
import { ErrorNotice } from '@/components/ErrorNotice';
import { TwringLockup } from '@/components/Brand';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { TextButton } from '@/components/TextButton';
import { Waveform } from '@/components/Waveform';
import { playCallFeedback } from '@/platform/haptics';
import { SavedServers } from '@/servers/saved-servers';
import { space, type, usePalette } from '@/theme/tokens';

/**
 * Sign-in (ADR-021): Continue with Google; on the iPhone also Continue with Apple, Apple's own
 * button first (App Store guideline 4.8). Shown whenever the user is signed out.
 */
export default function SignInScreen() {
  const palette = usePalette();
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const notice = auth.status === 'signed_out' ? auth.notice : undefined;
  const apple = authController()?.appleAvailable === true;

  async function signIn(provider: 'google' | 'apple') {
    const controller = authController();
    if (controller === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    const failure =
      provider === 'apple'
        ? await controller.signInWithApple()
        : await controller.signInWithGoogle();
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      playCallFeedback('error');
    }
  }

  return (
    <Screen
      footer={
        <View style={styles.buttons}>
          {apple && (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
              cornerRadius={28}
              style={styles.apple}
              onPress={() => void signIn('apple')}
            />
          )}
          <PrimaryButton
            label="Continue with Google"
            disabled={busy}
            accessibilityHint="Opens Google sign-in"
            onPress={() => void signIn('google')}
          />
          {/* Servers this phone is paired with; nothing when none are saved. */}
          <SavedServers />
        </View>
      }
    >
      <View style={styles.top}>
        <View style={styles.lockup}>
          <TwringLockup size={24} />
        </View>
        <View style={styles.wave}>
          <Waveform width={300} height={120} color={palette.accent} intensity={0.3} />
        </View>
        <Text accessibilityRole="header" style={[type.display, { color: palette.textPrimary }]}>
          Sign in to Twring
        </Text>
        <Text style={[type.body, { color: palette.textSecondary }]}>
          Your agents and call history belong to your account, so only you can see and call them.
          {apple
            ? ' Twring keeps only your email address and name from Apple or Google.'
            : ' From Google, Twring keeps only your email address and profile name and picture.'}
        </Text>
        {notice !== undefined && error === undefined && (
          <Text accessibilityRole="alert" style={[type.body, { color: palette.textPrimary }]}>
            {notice}
          </Text>
        )}
        {error !== undefined && <ErrorNotice error={{ message: error, retryable: false }} />}
        {busy && (
          <ActivityIndicator accessibilityLabel="Signing in" color={palette.textSecondary} />
        )}
        <View style={styles.links}>
          <TextButton label="Privacy" onPress={() => router.push('/privacy')} />
          <TextButton label="Use my own server" onPress={() => router.push('/pair')} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { gap: space.lg, paddingTop: space.lg },
  lockup: { alignItems: 'center' },
  wave: { alignItems: 'center', paddingTop: space.xxxl, paddingBottom: space.xl },
  links: { flexDirection: 'row', justifyContent: 'center', gap: space.lg },
  buttons: { gap: space.md },
  apple: { width: '100%', height: 56 },
});
