import { StyleSheet, Text, View } from 'react-native';
import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';
export function DateSeparator({ label }: { label: string }) {
  const palette = usePalette();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.text, { color: palette.textTertiary }]}>{label}</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingVertical: 12 },
  text: { fontFamily: font.mono, fontSize: 11, letterSpacing: 1 },
});
