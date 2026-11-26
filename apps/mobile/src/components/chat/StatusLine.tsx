import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { GhostButton } from '@/components/GhostButton';
import { font } from '@/theme/fonts';
import { usePalette, type } from '@/theme/tokens';
import type { StatusLineContent } from './status-line';

function Dot({ delay, color, still }: { delay: number; color: string; still: boolean }) {
  const opacity = useSharedValue(still ? 1 : 0.3);
  useEffect(() => {
    if (!still)
      opacity.value = withDelay(delay, withRepeat(withTiming(1, { duration: 450 }), -1, true));
  }, [delay, opacity, still]);
  const motion = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.dot, { backgroundColor: color }, motion]} />;
}

/** Fixed line above the composer, so status changes never move the list or the keyboard. */
export function StatusLine({
  name,
  content,
  onStop,
  onRetry,
  onDelete,
}: {
  name: string;
  content: StatusLineContent;
  onStop: () => void;
  onRetry: (clientId: string) => void;
  onDelete: (clientId: string) => void;
}) {
  const palette = usePalette();
  const reduced = useReducedMotion();
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel={
        content.kind === 'working'
          ? content.label
            ? `${name} is working: ${content.label}`
            : `${name} is working`
          : undefined
      }
      style={styles.line}
    >
      {content.kind === 'working' && (
        <>
          <Text numberOfLines={1} style={[styles.working, { color: palette.accent }]}>
            {content.text}
          </Text>
          <View style={styles.dots}>
            <Dot delay={0} color={palette.accent} still={reduced} />
            <Dot delay={150} color={palette.accent} still={reduced} />
            <Dot delay={300} color={palette.accent} still={reduced} />
          </View>
          <View style={styles.spacer} />
          <GhostButton label="Stop" accessibilityHint={`Stops ${name}`} onPress={onStop} />
        </>
      )}
      {content.kind === 'status' && (
        <>
          <Text
            numberOfLines={1}
            style={[
              styles.status,
              { color: content.tone === 'danger' ? palette.danger : palette.textTertiary },
            ]}
          >
            {content.text}
          </Text>
          {content.retryClientId !== undefined && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry"
              style={styles.retry}
              onPress={() => onRetry(content.retryClientId!)}
            >
              <Text style={[styles.retryLabel, { color: palette.accent }]}>Retry</Text>
            </Pressable>
          )}
          {content.deleteClientId !== undefined && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete"
              style={styles.retry}
              onPress={() => onDelete(content.deleteClientId!)}
            >
              <Text style={[styles.retryLabel, { color: palette.accent }]}>Delete</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  line: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
  },
  working: { flexShrink: 1, fontSize: type.body.fontSize, fontStyle: 'italic' },
  dots: { flexDirection: 'row', gap: 3 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  spacer: { flex: 1 },
  status: { flex: 1, fontFamily: font.mono, fontSize: type.microLabel.fontSize },
  retry: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 },
  retryLabel: { fontFamily: font.bodyEmphasis, fontSize: type.caption.fontSize },
});
