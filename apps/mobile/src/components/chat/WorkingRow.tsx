import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { GhostButton } from '@/components/GhostButton';
import { workingLabel } from '@/threads/presentation';
import { usePalette, type } from '@/theme/tokens';
import { Bubble } from './Bubble';
function Dot({ delay, color }: { delay: number; color: string }) {
  const opacity = useSharedValue(0.3);
  useEffect(() => {
    opacity.value = withDelay(delay, withRepeat(withTiming(1, { duration: 450 }), -1, true));
  }, [delay, opacity]);
  const motion = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.dot, { backgroundColor: color }, motion]} />;
}
export function WorkingRow({
  name,
  activity,
  text,
  onStop,
  onLink,
}: {
  name: string;
  activity?: string;
  text?: string;
  onStop: () => void;
  onLink: (url: string) => void;
}) {
  const palette = usePalette();
  const reduced = useReducedMotion();
  const label = workingLabel(activity);
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel={label ? `${name} is working: ${label}` : `${name} is working`}
      style={styles.wrap}
    >
      <View style={styles.row}>
        <Text style={[styles.label, { color: palette.accent }]}>
          {reduced || !label ? 'Working…' : `Working · ${label}`}
        </Text>
        {!reduced && (
          <View style={styles.dots}>
            <Dot delay={0} color={palette.accent} />
            <Dot delay={150} color={palette.accent} />
            <Dot delay={300} color={palette.accent} />
          </View>
        )}
        <GhostButton label="Stop" onPress={onStop} />
      </View>
      {!!text && <Bubble text={text} time="" sender={name} own={false} onLink={onLink} />}
    </View>
  );
}
const styles = StyleSheet.create({
  wrap: { gap: 5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { flex: 1, fontSize: type.body.fontSize, fontStyle: 'italic' },
  dots: { flexDirection: 'row', gap: 3 },
  dot: { width: 5, height: 5, borderRadius: 3 },
});
