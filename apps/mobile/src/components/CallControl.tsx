import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from './Icon';
import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';

export function CallControl({
  icon,
  label,
  onPress,
  accessibilityLabel,
  variant = 'default',
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
  variant?: 'default' | 'active' | 'danger';
}) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: variant === 'active' }}
      onPress={onPress}
      style={styles.control}
    >
      <View
        style={[
          styles.circle,
          {
            backgroundColor:
              variant === 'danger'
                ? palette.danger
                : variant === 'active'
                  ? '#FFFFFF'
                  : palette.surface,
            borderWidth: variant === 'default' ? 1 : 0,
            borderColor: 'rgba(255,255,255,0.10)',
            boxShadow: variant === 'danger' ? '0 0 18px #FF4D5E55' : undefined,
          },
        ]}
      >
        <Icon
          name={icon}
          size={20}
          strokeWidth={1.7}
          color={
            variant === 'active'
              ? '#000000'
              : variant === 'danger'
                ? '#FFFFFF'
                : 'rgba(255,255,255,0.8)'
          }
        />
      </View>
      <Text
        style={[
          styles.label,
          {
            color:
              variant === 'danger'
                ? palette.danger
                : variant === 'active'
                  ? '#FFFFFF'
                  : 'rgba(255,255,255,0.55)',
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  control: { minWidth: 64, alignItems: 'center', gap: 6 },
  circle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontFamily: font.interMedium, fontSize: 11, letterSpacing: 0.2 },
});
