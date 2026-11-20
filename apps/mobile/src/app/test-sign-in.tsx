import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { authController } from '@/auth';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Field } from '@/components/Field';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { playCallFeedback } from '@/platform/haptics';
import { space, type, usePalette } from '@/theme/tokens';

/**
 * Test sign-in: the email and password Twring gives app store and directory reviewers, so they
 * can use the same test account in the app and in an AI app. Only emails the server lists
 * (PASSWORD_SIGNIN_EMAILS) get in. Temporary: removed once the reviews are done.
 */
export default function TestSignInScreen() {
  const palette = usePalette();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function signIn() {
    const controller = authController();
    if (controller === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    const failure = await controller.signInWithPassword(email, password);
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      playCallFeedback('error');
    }
  }

  return (
    <Screen
      title="Test sign-in"
      back
      footer={
        <PrimaryButton
          label="Sign in"
          disabled={busy || email.trim() === '' || password === ''}
          onPress={() => void signIn()}
        />
      }
    >
      <View style={styles.step}>
        <Text style={[type.body, { color: palette.textSecondary }]}>
          For app store and directory reviewers. Use the test email and password you were given.
          Everyone else signs in with Google or Apple.
        </Text>
        <Field
          label="Test email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
          autoComplete="email"
          returnKeyType="next"
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          autoComplete="current-password"
          returnKeyType="go"
          onSubmitEditing={() => void signIn()}
        />
        {error !== undefined && <ErrorNotice error={{ message: error, retryable: false }} />}
        {busy && (
          <ActivityIndicator accessibilityLabel="Signing in" color={palette.textSecondary} />
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  step: { gap: space.lg },
});
