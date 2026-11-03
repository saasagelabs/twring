import { StyleSheet, Text, View } from 'react-native';

import type { ErrorCopy } from '@/api/errors';
import { font } from '@/theme/fonts';
import { radius, space, type, usePalette } from '@/theme/tokens';

import { GhostButton } from './GhostButton';

/** What happened and what to do next, with the technical reference in small print. */
export function ErrorNotice({ error, onRetry }: { error: ErrorCopy; onRetry?: () => void }) {
  const palette = usePalette();
  return (
    <View accessibilityRole="alert" style={styles.box}>
      <Text style={[styles.message, { color: palette.textPrimary }]}>{error.message}</Text>
      {error.detail !== undefined && (
        <Text selectable style={[type.caption, { color: palette.textSecondary }]}>
          {error.detail}
        </Text>
      )}
      {onRetry !== undefined && error.retryable && (
        <View style={styles.actions}>
          <GhostButton label="Try again" tone="danger" onPress={onRetry} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.sm,
    backgroundColor: 'rgba(255,77,94,0.08)',
    borderWidth: 1,
    borderColor: '#FF4D5E55',
  },
  message: { fontFamily: font.body, fontSize: 14 },
  actions: { flexDirection: 'row' },
});
