import { StyleSheet, Text, View } from 'react-native';
import { TextButton } from '@/components/TextButton';
import { usePalette } from '@/theme/tokens';
export function Notice({
  text,
  action,
  onPress,
}: {
  text: string;
  action?: string;
  onPress?: () => void;
}) {
  const palette = usePalette();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.text, { color: palette.textSecondary }]}>{text}</Text>
      {action && onPress && <TextButton label={action} onPress={onPress} />}
    </View>
  );
}
const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingHorizontal: 24 },
  text: { textAlign: 'center', fontSize: 12, lineHeight: 18 },
});
