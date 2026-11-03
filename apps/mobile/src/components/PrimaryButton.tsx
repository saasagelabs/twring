import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, Text } from 'react-native';

import { font } from '@/theme/fonts';
import { space, usePalette } from '@/theme/tokens';

interface Props {
  label: string;
  onPress: () => void;
  tone?: 'accent' | 'neutral';
  disabled?: boolean;
  accessibilityHint?: string;
}

/** Filled, high-contrast primary action with a comfortably large hit area. */
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
          ? { backgroundColor: 'rgba(255,255,255,0.06)' }
          : tone === 'accent'
            ? {
                boxShadow:
                  '0 0 0 1px rgba(25,214,242,0.4), 0 8px 28px rgba(25,214,242,0.33), inset 0 1px 0 rgba(255,255,255,0.4)',
              }
            : {
                backgroundColor: palette.surface,
                borderWidth: 1,
                borderColor: palette.borderStrong,
              },
        { transform: [{ scale: pressed && !disabled ? 0.97 : 1 }] },
      ]}
    >
      {tone === 'accent' && !disabled && (
        <LinearGradient colors={[palette.accent, palette.accentDim]} style={styles.gradient} />
      )}
      <Text style={[styles.label, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 56,
    borderRadius: 28,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gradient: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 28 },
  label: { fontFamily: font.bodyEmphasis, fontSize: 16 },
});
