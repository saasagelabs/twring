import { useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { usePalette } from '@/theme/tokens';

interface Props {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel: string;
}

export function Toggle({ value, onValueChange, disabled, accessibilityLabel }: Props) {
  const palette = usePalette();
  const reducedMotion = useReducedMotion();
  const position = useSharedValue(value ? 21 : 3);
  useEffect(() => {
    position.value = reducedMotion
      ? value
        ? 21
        : 3
      : withTiming(value ? 21 : 3, { duration: 200 });
  }, [position, reducedMotion, value]);
  const knob = useAnimatedStyle(() => ({ left: position.value }));
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      hitSlop={{ top: 11, bottom: 11, left: 2, right: 2 }}
      style={[
        styles.track,
        {
          backgroundColor: value ? palette.accent : 'rgba(255,255,255,0.15)',
          boxShadow: value ? '0 0 10px rgba(25,214,242,0.6)' : undefined,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Animated.View style={[styles.knob, knob]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { width: 44, height: 26, borderRadius: 13, justifyContent: 'center' },
  knob: {
    position: 'absolute',
    top: 3,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
  },
});
