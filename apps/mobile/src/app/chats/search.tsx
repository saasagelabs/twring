import type { Agent } from '@twring/contracts';
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { twringApi } from '@/api';
import { Screen } from '@/components/Screen';
import { useResource } from '@/hooks/useResource';
import { radius, space, type, usePalette } from '@/theme/tokens';
import { rowTime } from '@/threads/presentation';
import { useChatSearch } from '@/threads/useChatSearch';

export default function ChatSearchScreen() {
  const palette = usePalette();
  const [query, setQuery] = useState('');
  const { results, searched, filling } = useChatSearch(query);
  const load = useCallback(
    (signal: AbortSignal) => twringApi()?.listAgents(signal) ?? Promise.resolve<Agent[]>([]),
    [],
  );
  const agents = useResource(load);
  const names = new Map((agents.data ?? []).map((agent) => [agent.id, agent.name]));
  const typed = query.trim().length > 0;

  return (
    <Screen back title="Search">
      <TextInput
        autoFocus
        value={query}
        onChangeText={setQuery}
        placeholder="Search your chats"
        placeholderTextColor={palette.textTertiary}
        accessibilityLabel="Search your chats"
        returnKeyType="search"
        autoCorrect={false}
        style={[
          type.body,
          styles.input,
          {
            color: palette.textPrimary,
            backgroundColor: palette.surface,
            borderColor: palette.border,
          },
        ]}
      />
      {filling && (
        <Text
          accessibilityLiveRegion="polite"
          style={[type.caption, styles.note, { color: palette.textTertiary }]}
        >
          Getting older messages...
        </Text>
      )}
      {!typed && (
        <Text style={[type.body, styles.empty, { color: palette.textSecondary }]}>
          Search your chats on this phone.
        </Text>
      )}
      {typed && searched && results.length === 0 && (
        <Text
          accessibilityLiveRegion="polite"
          style={[type.body, styles.empty, { color: palette.textSecondary }]}
        >
          No messages match.
        </Text>
      )}
      {typed &&
        results.map((result) => {
          const name = names.get(result.agentId) ?? 'Agent';
          const who = result.role === 'you' ? 'You' : name;
          const when = result.createdAt ? rowTime(result.createdAt) : '';
          return (
            <Pressable
              key={result.id}
              accessibilityRole="button"
              accessibilityLabel={`${who}, in your chat with ${name}${when ? `, ${when}` : ''}: ${result.snippet}`}
              accessibilityHint="Opens the chat"
              onPress={() =>
                router.push({
                  pathname: '/chats/[agentId]',
                  params: { agentId: result.agentId },
                })
              }
              style={({ pressed }) => [
                styles.row,
                { borderColor: palette.border, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <View style={styles.head}>
                <Text
                  numberOfLines={1}
                  style={[type.bodyEmphasis, styles.name, { color: palette.textPrimary }]}
                >
                  {name}
                </Text>
                {when ? (
                  <Text style={[type.caption, { color: palette.textTertiary }]}>{when}</Text>
                ) : null}
              </View>
              <Text numberOfLines={3} style={[type.body, { color: palette.textSecondary }]}>
                {result.role === 'you' ? 'You: ' : ''}
                {result.snippet}
              </Text>
            </Pressable>
          );
        })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  note: { marginTop: space.sm },
  empty: { marginTop: space.lg, textAlign: 'center' },
  row: {
    minHeight: 56,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space.xs,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { flex: 1 },
});
