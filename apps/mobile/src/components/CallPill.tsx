import { Pressable, StyleSheet, Text, View } from 'react-native';

import { font } from '@/theme/fonts';
import { usePalette, type } from '@/theme/tokens';

import { Icon } from './Icon';

export function CallPill({
  onPress,
  accessibilityLabel,
  disabled = false,
}: {
  onPress: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
}) {
  const palette = usePalette();
  const color = disabled ? palette.textMuted : palette.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={styles.hitArea}
    >
      <View
        style={[
          styles.pill,
          {
            borderColor: disabled ? palette.border : palette.borderAccent,
            backgroundColor: disabled ? 'transparent' : palette.accentTint,
            boxShadow: disabled ? undefined : '0 0 12px #19D6F222',
          },
        ]}
      >
        <Icon name="phone" size={13} color={color} strokeWidth={1.8} />
        <Text style={[styles.label, { color }]}>{'Call'}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hitArea: { minHeight: 48, minWidth: 48, justifyContent: 'center', alignItems: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  label: { fontFamily: font.interMedium, fontSize: type.caption.fontSize },
});
