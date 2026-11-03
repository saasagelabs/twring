import { Pressable, StyleSheet, Text, View } from 'react-native';

import { space, type, usePalette } from '@/theme/tokens';
import { Icon } from './Icon';

interface Props {
  label: string;
  value?: string;
  onPress?: () => void;
  accessibilityHint?: string;
  /** False for the last row of a card, so no line sits on the card's edge. */
  divider?: boolean;
}

/** A settings-style line: label, current value underneath, and a chevron when it opens more. */
export function Row({ label, value, onPress, accessibilityHint, divider = true }: Props) {
  const palette = usePalette();
  const line = {
    borderColor: palette.border,
    borderBottomWidth: divider ? StyleSheet.hairlineWidth : 0,
  };
  const body = (
    <>
      <View style={styles.text}>
        <Text style={[type.body, { color: palette.textPrimary }]}>{label}</Text>
        {value !== undefined && (
          <Text style={[type.caption, { color: palette.textTertiary }]}>{value}</Text>
        )}
      </View>
      {onPress !== undefined && (
        <View importantForAccessibility="no" accessibilityElementsHidden>
          <Icon name="chev" size={16} color={palette.textTertiary} />
        </View>
      )}
    </>
  );
  if (onPress === undefined) {
    return (
      <View accessible style={[styles.row, line]}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value !== undefined ? `${label}, ${value}` : label}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [styles.row, line, { opacity: pressed ? 0.6 : 1 }]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  text: { flex: 1, gap: space.xs },
});
