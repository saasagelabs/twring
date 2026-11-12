import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';

type Tone = 'you' | 'agent' | 'warning' | 'neutral' | 'muted';

interface Props {
  label: string;
  tone: Tone;
  active: boolean;
  detail?: string;
  /**
   * Keep the detail line's room even when there is no detail, so the pill never changes height
   * (on the call screen a growing pill pushed the panels up and down).
   */
  reserveDetail?: boolean;
}

function Dot({
  index,
  color,
  active,
  reducedMotion,
}: {
  index: number;
  color: string;
  active: boolean;
  reducedMotion: boolean;
}) {
  const progress = useSharedValue(0);
  useEffect(() => {
    if (active && !reducedMotion) {
      progress.value = withDelay(
        index * 150,
        withRepeat(
          withSequence(withTiming(1, { duration: 300 }), withTiming(0, { duration: 900 })),
          -1,
        ),
      );
    } else {
      cancelAnimation(progress);
      progress.value = 0;
    }
    return () => cancelAnimation(progress);
  }, [active, index, progress, reducedMotion]);
  const motion = useAnimatedStyle(() => ({
    opacity: active && !reducedMotion ? 0.5 + progress.value * 0.5 : 1,
    transform: [{ translateY: -3 * progress.value }],
  }));
  return <Animated.View style={[styles.dot, { backgroundColor: color }, motion]} />;
}

export function StatusPill({ label, tone, active, detail, reserveDetail }: Props) {
  const palette = usePalette();
  const reducedMotion = useReducedMotion();
  const color =
    tone === 'you'
      ? palette.accent
      : tone === 'agent'
        ? '#FFFFFF'
        : tone === 'warning'
          ? palette.warning
          : tone === 'muted'
            ? palette.textTertiary
            : palette.textSecondary;
  const glow =
    tone === 'you'
      ? 'rgba(25,214,242,0.2)'
      : tone === 'warning'
        ? 'rgba(255,181,71,0.2)'
        : 'rgba(255,255,255,0.2)';
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      accessibilityLiveRegion="polite"
      style={[
        styles.pill,
        {
          borderColor:
            active && tone !== 'muted'
              ? tone === 'warning'
                ? palette.warning
                : palette.borderAccent
              : palette.border,
          boxShadow: active && tone !== 'muted' ? `0 0 24px ${glow}` : undefined,
        },
      ]}
    >
      <View style={styles.text}>
        <Text
          style={[
            styles.label,
            { color: tone === 'muted' ? color : active ? color : 'rgba(255,255,255,0.5)' },
          ]}
        >
          {label}
        </Text>
        {(detail || reserveDetail) && (
          <Text numberOfLines={1} style={[styles.detail, { color: palette.textTertiary }]}>
            {detail || ' '}
          </Text>
        )}
      </View>
      {tone !== 'muted' && (
        <View
          style={styles.dots}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {[0, 1, 2].map((index) => (
            <Dot
              key={index}
              index={index}
              color={active ? color : palette.textMuted}
              active={active}
              reducedMotion={reducedMotion}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  text: { flexShrink: 1 },
  pill: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 22,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(10,12,16,0.6)',
  },
  label: { fontFamily: font.headline, fontSize: 15, fontStyle: 'italic' },
  detail: { fontFamily: font.caption, fontSize: 12, marginTop: 4 },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
});
