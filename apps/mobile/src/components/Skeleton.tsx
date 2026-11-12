import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { usePalette, radius } from '@/theme/tokens';

export function Skeleton({ height, width }: { height: number; width?: number }) {
  const palette = usePalette();
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(0.5);
  useEffect(() => {
    if (reducedMotion) {
      cancelAnimation(opacity);
      opacity.value = 1;
    } else {
      opacity.value = withRepeat(withTiming(1, { duration: 1200 }), -1, true);
    }
    return () => cancelAnimation(opacity);
  }, [opacity, reducedMotion]);
  const motion = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      accessible={false}
      style={[
        styles.block,
        { height, width, backgroundColor: palette.surface, borderColor: palette.border },
        motion,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  block: { alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md },
});
