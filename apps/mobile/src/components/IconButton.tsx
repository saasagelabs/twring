import { Pressable, StyleSheet } from 'react-native';

import { usePalette } from '@/theme/tokens';

import { Icon, type IconName } from './Icon';

interface Props {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  active?: boolean;
  size?: number;
}

export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  active = false,
  size = 36,
}: Props) {
  const palette = usePalette();
  const slop = Math.max(0, (48 - size) / 2);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active }}
      hitSlop={slop}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          width: size,
          height: size,
          backgroundColor: active ? 'rgba(25,214,242,0.12)' : palette.surface,
          borderColor: active ? palette.borderAccent : palette.border,
          opacity: pressed ? 0.75 : 1,
        },
      ]}
    >
      <Icon
        name={icon}
        size={size * 0.5}
        strokeWidth={1.7}
        color={active ? palette.accent : 'rgba(255,255,255,0.85)'}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
