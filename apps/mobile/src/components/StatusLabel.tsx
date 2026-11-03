import { StyleSheet, Text, View } from 'react-native';

import type { Tone } from '@/agents/labels';
import { space, type, usePalette, type Palette } from '@/theme/tokens';
import { StatusDot } from './StatusDot';

function toneColor(tone: Tone, palette: Palette): string {
  switch (tone) {
    case 'success':
      return palette.success;
    case 'warning':
      return palette.warning;
    case 'danger':
      return palette.danger;
    case 'neutral':
      return '#6B7078';
  }
}

/** A status in words, with a small colored dot that only reinforces them. */
export function StatusLabel({ label, tone }: { label: string; tone: Tone }) {
  const palette = usePalette();
  return (
    <View style={styles.row}>
      <StatusDot color={toneColor(tone, palette)} />
      <Text style={[type.caption, { color: palette.textSecondary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
