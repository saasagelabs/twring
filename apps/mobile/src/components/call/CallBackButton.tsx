import { Pressable, StyleSheet, Text } from 'react-native';

import { Icon } from '@/components/Icon';
import { callPalette as palette, type } from '@/theme/tokens';

/**
 * The top-left way off a call screen. Both the live call and the ended screen use it, so the
 * arrow sits in the same place and the screen does not jump when the call ends.
 */
export function CallBackButton({
  onPress,
  hint,
  showLabel = false,
}: {
  onPress: () => void;
  hint?: string;
  /** Spell out "Back" next to the arrow: on the live call people did not read the arrow alone. */
  showLabel?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      accessibilityHint={hint}
      onPress={onPress}
      hitSlop={4}
      style={styles.button}
    >
      <Icon name="back" size={22} color={palette.textPrimary} />
      {showLabel && (
        // Capped so very large text still leaves room for the connection pill on a 320 pt phone.
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={1.4}
          style={[type.bodyEmphasis, { color: palette.textPrimary }]}
        >
          Back
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 48,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 6,
  },
});
