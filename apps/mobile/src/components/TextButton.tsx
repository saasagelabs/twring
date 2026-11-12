import { Pressable, StyleSheet, Text } from 'react-native';

import { space, usePalette, type } from '@/theme/tokens';
import { font } from '@/theme/fonts';

interface Props {
  label: string;
  onPress: () => void;
  tone?: 'accent' | 'danger';
  disabled?: boolean;
  accessibilityHint?: string;
}

/** A quiet secondary action with a full 44pt hit target. */
export function TextButton({
  label,
  onPress,
  tone = 'accent',
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
      style={({ pressed }) => [styles.button, { opacity: disabled ? 0.5 : pressed ? 0.6 : 1 }]}
    >
      <Text style={[styles.label, { color: tone === 'danger' ? palette.danger : palette.accent }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 48, minWidth: 48, justifyContent: 'center', paddingHorizontal: space.sm },
  label: { fontFamily: font.interMedium, fontSize: type.body.fontSize },
});
