import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, SlideInDown, useReducedMotion } from 'react-native-reanimated';
import { font } from '@/theme/fonts';
import { radius, type, usePalette } from '@/theme/tokens';
import { pillLabel } from '@/threads/scroll-state';

/** Sits above the message box while new replies arrive below what the reader is looking at. */
export function NewReplyPill({ count, onPress }: { count: number; onPress: () => void }) {
  const palette = usePalette();
  const reducedMotion = useReducedMotion();
  const label = pillLabel(count);
  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      <Animated.View entering={reducedMotion ? undefined : SlideInDown.duration(180)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}. Jump to the newest message`}
          onPress={onPress}
          style={[styles.pill, { backgroundColor: palette.accent }]}
        >
          <Text style={[styles.text, { color: palette.onAccent }]}>{label}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

/** Marks where unread messages start when a chat opens. */
export function UnreadDivider() {
  const palette = usePalette();
  return (
    <Animated.View
      entering={FadeIn}
      accessibilityRole="text"
      accessibilityLabel="New messages"
      style={styles.divider}
    >
      <View style={[styles.line, { backgroundColor: palette.borderAccent }]} />
      <Text style={[styles.dividerText, { color: palette.accent }]}>New</Text>
      <View style={[styles.line, { backgroundColor: palette.borderAccent }]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 8, alignItems: 'center' },
  pill: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    justifyContent: 'center',
  },
  text: { fontFamily: font.bodyEmphasis, fontSize: type.caption.fontSize },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  line: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: { fontFamily: font.mono, fontSize: type.microLabel.fontSize, letterSpacing: 1 },
});
