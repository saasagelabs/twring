import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { CallFeedbackRequest } from '@twring/contracts';

import { twringApi } from '@/api';
import { apiErrorCopy } from '@/api/errors';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Field } from '@/components/Field';
import { PrimaryButton } from '@/components/PrimaryButton';
import { TextButton } from '@/components/TextButton';
import { useActiveServer } from '@/servers/active';
import { space, type, usePalette, radius } from '@/theme/tokens';

const issues = [
  { label: 'Cut me off', value: 'cut_off' },
  { label: 'Misheard me', value: 'misheard' },
  { label: 'Slow replies', value: 'slow' },
] as const;
type Issue = (typeof issues)[number]['value'];

export function CallFeedback({ callId }: { callId: string }) {
  const palette = usePalette();
  const selfhosted = useActiveServer().kind === 'selfhost';
  const [rating, setRating] = useState<number>();
  const [selected, setSelected] = useState<Issue[]>([]);
  const [note, setNote] = useState('');
  const [state, setState] = useState<'editing' | 'sending' | 'sent' | 'skipped'>('editing');
  const [error, setError] = useState<unknown>();
  const attempt = useRef<AbortController | null>(null);
  useEffect(() => () => attempt.current?.abort(), []);

  const send = async () => {
    const api = twringApi();
    if (rating === undefined || state === 'sending') return;
    if (api === undefined) {
      setError(new Error('api unavailable'));
      return;
    }
    const controller = new AbortController();
    attempt.current = controller;
    setState('sending');
    setError(undefined);
    const body: CallFeedbackRequest = {
      rating,
      issues: selected,
      ...(note.trim() && { note: note.trim() }),
    };
    try {
      await api.sendCallFeedback(callId, body, controller.signal);
      if (!controller.signal.aborted) setState('sent');
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure);
        setState('editing');
      }
    }
  };

  // Ratings go to Twring's service; a person's own server has no one to send them to.
  if (selfhosted || state === 'skipped') return null;
  if (state === 'sent')
    return (
      <Text style={[type.body, { color: palette.textPrimary }]}>
        Thanks. This helps us improve Twring.
      </Text>
    );

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={[type.headline, { color: palette.textPrimary }]}>
        How was the call?
      </Text>
      <View style={styles.stars} accessibilityRole="radiogroup" accessibilityLabel="Call rating">
        {[1, 2, 3, 4, 5].map((star) => (
          <Pressable
            key={star}
            accessibilityRole="radio"
            accessibilityLabel={`${star} ${star === 1 ? 'star' : 'stars'}`}
            accessibilityState={{ checked: rating === star }}
            onPress={() => {
              setRating(star);
              if (star === 5) setSelected([]);
            }}
            style={styles.star}
          >
            <Svg width={32} height={32} viewBox="0 0 24 24" accessible={false}>
              <Path
                d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"
                fill={star <= (rating ?? 0) ? palette.accent : 'transparent'}
                stroke={palette.accent}
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
            </Svg>
          </Pressable>
        ))}
      </View>
      {rating !== undefined && (
        <View style={styles.container}>
          <Text style={[type.bodyEmphasis, { color: palette.textPrimary }]}>What went wrong?</Text>
          <View style={styles.chips}>
            {issues.map((issue) => {
              const checked = selected.includes(issue.value);
              return (
                <Pressable
                  key={issue.value}
                  accessibilityRole="checkbox"
                  accessibilityLabel={issue.label}
                  accessibilityState={{ checked }}
                  onPress={() =>
                    setSelected((current) =>
                      checked
                        ? current.filter((value) => value !== issue.value)
                        : [...current, issue.value],
                    )
                  }
                  style={[
                    styles.chip,
                    {
                      borderColor: checked ? palette.accent : palette.border,
                      backgroundColor: checked ? palette.surfaceRaised : palette.surface,
                    },
                  ]}
                >
                  <Text style={[type.body, { color: palette.textPrimary }]}>{issue.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}
      <Field
        label="Anything else? (optional)"
        value={note}
        onChangeText={setNote}
        maxLength={280}
      />
      {error !== undefined && (
        <ErrorNotice
          error={{ ...apiErrorCopy(error), retryable: true }}
          onRetry={() => void send()}
        />
      )}
      <View style={styles.actions}>
        <PrimaryButton
          label="Send"
          disabled={rating === undefined || state === 'sending'}
          onPress={() => void send()}
        />
        <TextButton
          label="Skip"
          onPress={() => {
            attempt.current?.abort();
            setState('skipped');
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: space.md, width: '100%' },
  stars: { flexDirection: 'row', justifyContent: 'center' },
  star: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 48,
    paddingHorizontal: space.md,
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: radius.pill,
  },
  actions: { gap: space.xs },
});
