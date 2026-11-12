import { Pressable, StyleSheet, Text } from 'react-native';

import { font } from '@/theme/fonts';
import { space, usePalette, radius, type } from '@/theme/tokens';

interface Props {
  label: string;
  onPress: () => void;
  tone?: 'accent' | 'neutral';
  disabled?: boolean;
  accessibilityHint?: string;
}

/** Flat, high-contrast primary action with a comfortably large hit area. */
export function PrimaryButton({
  label,
  onPress,
  tone = 'accent',
  disabled,
  accessibilityHint,
}: Props) {
  const palette = usePalette();
  const color = disabled
    ? palette.textMuted
    : tone === 'accent'
      ? palette.onAccent
      : palette.textPrimary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        disabled
          ? { backgroundColor: palette.surfaceRaised }
          : tone === 'accent'
            ? // Flat cyan: glow is kept for live things (the call orb, a ringing Answer).
              { backgroundColor: pressed ? palette.accentDim : palette.accent }
            : {
                backgroundColor: palette.surface,
                borderWidth: 1,
                borderColor: palette.borderStrong,
              },
        { transform: [{ scale: pressed && !disabled ? 0.97 : 1 }] },
      ]}
    >
      <Text style={[styles.label, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 56,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontFamily: font.bodyEmphasis, fontSize: type.body.fontSize },
});
