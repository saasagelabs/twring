import { Pressable, StyleSheet, Text } from 'react-native';

import { space, type, usePalette } from '@/theme/tokens';

/** Header back control: chevron plus "Back", a full 44pt target, no fill. */
export function BackButton({ onPress }: { onPress: () => void }) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={space.xs}
      onPress={onPress}
      android_ripple={{ color: palette.border, borderless: true }}
      style={({ pressed }) => [styles.button, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={[type.title, styles.chevron, { color: palette.accent }]}>‹</Text>
      <Text style={[type.bodyEmphasis, { color: palette.accent }]}>Back</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    minWidth: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingRight: space.sm,
    backgroundColor: 'transparent',
  },
  chevron: { marginTop: -2 },
});
