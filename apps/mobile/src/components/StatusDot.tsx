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

export function StatusDot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(0);
  useEffect(() => {
    if (pulse && !reducedMotion)
      progress.value = withRepeat(withTiming(1, { duration: 750 }), -1, true);
    else {
      cancelAnimation(progress);
      progress.value = 0;
    }
    return () => cancelAnimation(progress);
  }, [progress, pulse, reducedMotion]);
  const motion = useAnimatedStyle(() => ({
    opacity: 1 - progress.value * 0.6,
    transform: [{ scale: 1 - progress.value * 0.15 }],
  }));
  return (
    <Animated.View
      accessible={false}
      style={[styles.dot, { backgroundColor: color, boxShadow: `0 0 8px ${color}` }, motion]}
    />
  );
}

const styles = StyleSheet.create({ dot: { width: 8, height: 8, borderRadius: 4 } });
