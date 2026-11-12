import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from './Icon';
import { font } from '@/theme/fonts';
import { radius, space, type, usePalette } from '@/theme/tokens';

interface Props {
  label: string;
  description?: string;
  example?: string;
  selected: boolean;
  onPress: () => void;
}

/** One option in a single-choice list (connection method, voice). Selection is not color-only. */
export function Choice({ label, description, example, selected, onPress }: Props) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={[label, description, example && `For example ${example}`]
        .filter(Boolean)
        .join('. ')}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        {
          backgroundColor: selected ? palette.accentTint : palette.surface,
          borderColor: selected ? palette.borderAccent : palette.border,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <View style={styles.text}>
        <Text style={[styles.title, { color: palette.textPrimary }]}>{label}</Text>
        {description !== undefined && (
          <Text style={[type.caption, { color: palette.textSecondary }]}>{description}</Text>
        )}
        {example !== undefined && (
          <Text style={[type.mono, { color: palette.textSecondary }]}>{example}</Text>
        )}
      </View>
      <View
        style={[
          styles.mark,
          {
            borderColor: selected ? palette.accent : palette.borderStrong,
            backgroundColor: selected ? palette.accent : 'transparent',
          },
        ]}
      >
        {selected && <Icon name="check" size={13} color={palette.onAccent} strokeWidth={2.5} />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  choice: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
  },
  text: { flex: 1, gap: space.xs },
  title: { fontFamily: font.interMedium, fontSize: type.body.fontSize },
  mark: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
