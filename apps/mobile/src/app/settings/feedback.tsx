import { MAX_APP_FEEDBACK_CHARS } from '@twring/contracts';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { twringApi } from '@/api';
import { useAuth } from '@/auth';
import { Field } from '@/components/Field';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { feedbackHint, sendFeedback } from '@/feedback/send';
import { playCallFeedback } from '@/platform/haptics';
import { space, type, usePalette } from '@/theme/tokens';

/** Settings, Send feedback: a note at any time, not only after a call. */
export default function FeedbackScreen() {
  const palette = usePalette();
  const auth = useAuth();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  const email = auth.status === 'signed_in' ? auth.email : undefined;

  async function send() {
    const api = twringApi();
    if (busy || api === undefined) return;
    setBusy(true);
    setError(undefined);
    const result = await sendFeedback(api, note);
    setBusy(false);
    if (result.ok) {
      setSent(true);
      playCallFeedback('connected');
    } else {
      setError(result.message);
      playCallFeedback('error');
    }
  }

  return (
    <Screen
      title="Send feedback"
      back
      footer={
        sent ? (
          <PrimaryButton label="Done" onPress={() => router.back()} />
        ) : (
          <PrimaryButton
            label={busy ? 'Sending…' : 'Send'}
            disabled={busy || note.trim() === ''}
            accessibilityHint="Sends your note to the Twring team"
            onPress={() => void send()}
          />
        )
      }
    >
      {sent ? (
        <View style={styles.body}>
          <Text accessibilityRole="header" style={[type.title, { color: palette.textPrimary }]}>
            Thank you
          </Text>
          <Text style={[type.body, { color: palette.textSecondary }]}>{feedbackHint(email)}</Text>
        </View>
      ) : (
        <View style={styles.body}>
          <Text style={[type.body, { color: palette.textSecondary }]}>
            Tell us what works, what doesn't, or what you'd like Twring to do. {feedbackHint(email)}
          </Text>
          <Field
            label="Your note"
            placeholder="What happened, and on which phone?"
            value={note}
            multiline
            maxLength={MAX_APP_FEEDBACK_CHARS}
            onChangeText={(value) => {
              setNote(value);
              setError(undefined);
            }}
            inputStyle={styles.input}
          />
          {error !== undefined && (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={[type.body, { color: palette.danger }]}
            >
              {error}
            </Text>
          )}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.lg, paddingTop: space.lg },
  input: { minHeight: 140, textAlignVertical: 'top' },
});
