import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNow } from '@/hooks/useNow';
import { StatusDot } from '@/components/StatusDot';
import { font } from '@/theme/fonts';
import { usePalette, type } from '@/theme/tokens';
export function OnCallBanner({ startedAt, onPress }: { startedAt?: number; onPress: () => void }) {
  const palette = usePalette();
  const now = useNow(1000);
  const seconds = startedAt ? Math.max(0, Math.floor((now.getTime() - startedAt) / 1000)) : 0;
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <View style={[styles.banner, { backgroundColor: palette.accentTintStrong }]}>
      <StatusDot color={palette.accent} pulse />
      <Text style={[styles.label, { color: palette.textPrimary }]}>On a call · {clock}</Text>
      <Pressable accessibilityRole="button" onPress={onPress} style={styles.action}>
        <Text style={{ color: palette.accent }}>Return to call</Text>
      </Pressable>
    </View>
  );
}
const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    minHeight: 48,
  },
  label: { flex: 1, fontFamily: font.body, fontSize: type.caption.fontSize },
  action: { minHeight: 48, justifyContent: 'center' },
});
