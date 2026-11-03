import type { ThreadMessage } from '@twring/contracts';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';
import { approvalCountdown } from '../../threads/presentation';

type Approval = Extract<ThreadMessage, { kind: 'approval' }>;

export function ChatApproval({
  message,
  name,
  onDecide,
}: {
  message: Approval;
  name: string;
  onDecide: (decision: 'approve' | 'deny') => Promise<void> | void;
}) {
  const palette = usePalette();
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (message.status !== 'pending') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [message.status]);
  const decide = async (decision: 'approve' | 'deny') => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await onDecide(decision);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  if (message.status !== 'pending') {
    const time = new Date(message.updated_at).toLocaleTimeString('en', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const line =
      message.status === 'expired'
        ? 'Expired: denied'
        : `${message.status === 'allowed' ? 'Allowed' : 'Denied'} · ${time}`;
    return (
      <Text
        accessible
        accessibilityLabel={line}
        style={[
          styles.notice,
          { color: message.status === 'allowed' ? palette.accent : palette.textSecondary },
        ]}
      >
        {line}
      </Text>
    );
  }
  return (
    <View
      accessible
      accessibilityLabel={`${name} needs your OK: ${message.title}`}
      style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.borderAccent }]}
    >
      <View style={styles.heading}>
        <View style={[styles.dot, { backgroundColor: palette.accent }]} />
        <Text style={[styles.micro, { color: palette.accent }]}>NEEDS YOUR OK</Text>
      </View>
      <Text style={[styles.title, { color: palette.textPrimary }]}>{message.title}</Text>
      {message.description !== undefined && (
        <Text style={[styles.description, { color: palette.textSecondary }]}>
          {message.description}
        </Text>
      )}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Allow ${message.title}`}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => void decide('approve')}
          style={[styles.button, { backgroundColor: palette.accent, opacity: busy ? 0.5 : 1 }]}
        >
          <Text style={[styles.buttonText, { color: palette.onAccent }]}>Allow</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Deny ${message.title}`}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => void decide('deny')}
          style={[
            styles.button,
            { borderColor: palette.borderStrong, borderWidth: 1, opacity: busy ? 0.5 : 1 },
          ]}
        >
          <Text style={[styles.buttonText, { color: palette.textPrimary }]}>Deny</Text>
        </Pressable>
      </View>
      <Text style={[styles.countdown, { color: palette.textTertiary }]}>
        {approvalCountdown(message.expires_at, now)} left
      </Text>
      {error && (
        <Text accessibilityRole="alert" style={{ color: palette.danger }}>
          Couldn't send. Try again.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderRadius: 18,
    padding: 18,
    gap: 12,
    marginVertical: 6,
  },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  micro: { fontFamily: font.microLabel, fontSize: 11, letterSpacing: 1.4 },
  title: { fontFamily: font.headline, fontSize: 19 },
  description: { fontFamily: font.body, fontSize: 15, lineHeight: 22 },
  actions: { flexDirection: 'row', gap: 12 },
  button: {
    flex: 1,
    minHeight: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontFamily: font.interMedium, fontSize: 15 },
  countdown: { fontFamily: font.mono, fontSize: 12, textAlign: 'center' },
  notice: { alignSelf: 'center', fontFamily: font.mono, fontSize: 12, marginVertical: 8 },
});
