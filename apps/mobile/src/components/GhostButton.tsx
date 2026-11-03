import { Pressable, StyleSheet, Text } from 'react-native';

import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';

interface Props {
  label: string;
  onPress: () => void;
  tone?: 'neutral' | 'accent' | 'danger';
  disabled?: boolean;
  accessibilityHint?: string;
}

export function GhostButton({
  label,
  onPress,
  tone = 'neutral',
  disabled,
  accessibilityHint,
}: Props) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: palette.surface,
          borderColor:
            tone === 'danger'
              ? '#FF4D5E88'
              : tone === 'accent'
                ? palette.borderAccent
                : 'rgba(255,255,255,0.12)',
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.label,
          {
            color:
              tone === 'danger' ? palette.danger : tone === 'accent' ? palette.accent : '#FFFFFF',
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 50,
    borderRadius: 25,
    borderWidth: 1,
    paddingHorizontal: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontFamily: font.interMedium, fontSize: 15 },
});
