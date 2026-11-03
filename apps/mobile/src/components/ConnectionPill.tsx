import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';

import { StatusDot } from './StatusDot';

function Spinner() {
  const reducedMotion = useReducedMotion();
  const angle = useSharedValue(0);
  useEffect(() => {
    if (reducedMotion) {
      cancelAnimation(angle);
      angle.value = 0;
    } else {
      angle.value = withRepeat(withTiming(360, { duration: 900 }), -1);
    }
    return () => cancelAnimation(angle);
  }, [angle, reducedMotion]);
  const motion = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle.value}deg` }] }));
  const palette = usePalette();
  return (
    <Animated.View
      style={[
        styles.spinner,
        { borderColor: palette.textTertiary, borderTopColor: 'transparent' },
        motion,
      ]}
    />
  );
}

export function ConnectionPill({
  tone,
  label,
}: {
  tone: 'connecting' | 'connected' | 'reconnecting';
  label: string;
}) {
  const palette = usePalette();
  const color =
    tone === 'connected'
      ? palette.accent
      : tone === 'reconnecting'
        ? palette.warning
        : palette.textTertiary;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={[
        styles.pill,
        {
          borderColor:
            tone === 'connected'
              ? palette.borderAccent
              : tone === 'reconnecting'
                ? '#FFB54755'
                : palette.border,
        },
      ]}
    >
      {tone === 'connecting' ? <Spinner /> : <StatusDot color={color} pulse />}
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(10,12,16,0.6)',
  },
  label: { fontFamily: font.interMedium, fontSize: 12, letterSpacing: 0.2 },
  spinner: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5 },
});
