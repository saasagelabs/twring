import type { ThreadMessage } from '@twring/contracts';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';
import { callCardLine } from '../../threads/presentation';

type CallOrRing = Extract<ThreadMessage, { kind: 'call' | 'ring' }>;

export function CallCard({
  message,
  name,
  time,
  onCallBack,
  callBackDisabled = false,
}: {
  message: CallOrRing;
  name: string;
  time: string;
  onCallBack?: () => void;
  callBackDisabled?: boolean;
}) {
  const palette = usePalette();
  const line = callCardLine(message, name);
  if (!line) return null;
  const missed = message.kind === 'ring' && message.outcome === 'missed';
  const color = missed
    ? palette.danger
    : message.kind === 'call' && message.outcome === 'failed'
      ? palette.textSecondary
      : palette.textPrimary;
  return (
    <View style={styles.wrap}>
      <View
        accessible
        accessibilityLabel={`${line}, ${time}`}
        style={[styles.chip, { backgroundColor: palette.surface, borderColor: palette.border }]}
      >
        <Icon name={missed ? 'phoneMissed' : 'phone'} size={16} color={color} />
        <Text numberOfLines={1} style={[styles.line, { color }]}>
          {line}
        </Text>
        <Text style={[styles.time, { color: palette.textTertiary }]}>{time}</Text>
      </View>
      {missed && onCallBack && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Call back"
          accessibilityState={{ disabled: callBackDisabled }}
          disabled={callBackDisabled}
          onPress={onCallBack}
          style={[
            styles.callBack,
            { borderColor: palette.border, opacity: callBackDisabled ? 0.5 : 1 },
          ]}
        >
          <Text style={[styles.callBackText, { color: palette.accent }]}>Call back</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 4, paddingVertical: 4 },
  chip: {
    maxWidth: '100%',
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 12,
  },
  line: { flexShrink: 1, fontFamily: font.interMedium, fontSize: 13 },
  time: { fontFamily: font.mono, fontSize: 11 },
  callBack: {
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 24,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBackText: { fontFamily: font.interMedium, fontSize: 13 },
});
