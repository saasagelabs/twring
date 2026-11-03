import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { computerCallHint } from '@/agents/ai-app';
import { GhostButton } from '@/components/GhostButton';
import { radius, space, type, usePalette } from '@/theme/tokens';

export function ComputerCallHint({ name }: { name: string }) {
  const palette = usePalette();
  const copy = computerCallHint(name);
  return (
    <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
      <Text style={[type.title, { color: palette.textPrimary }]}>{copy.title}</Text>
      <Text style={[type.body, { color: palette.textSecondary }]}>{copy.body}</Text>
      <GhostButton
        label={copy.action}
        onPress={() => router.push({ pathname: '/connect', params: { where: 'computer' } })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.md,
  },
});
