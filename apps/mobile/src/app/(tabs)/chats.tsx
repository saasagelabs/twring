import type { Agent } from '@twring/contracts';
import { isAiApp } from '@/agents/ai-app';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { twringApi } from '@/api';
import { startCall } from '@/call/start';
import { ChatRow } from '@/components/chat/ChatRow';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { Icon } from '@/components/Icon';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { Skeleton } from '@/components/Skeleton';
import { mobileEnv } from '@/config/env';
import { STATUS_POLL_MS, useResource } from '@/hooks/useResource';
import { onboardingSeen, shouldShowOnboarding } from '@/onboarding/state';
import { missedCallRow } from '@/ring/history';
import { unseenMissed } from '@/ring/missed';
import { markMissedSeen, missedLastSeen } from '@/ring/missed-seen';
import type { MissedInviteHistoryItem } from '@/ring/protocol';
import { type, usePalette } from '@/theme/tokens';
import { useChatList } from '@/threads/chats';
import { sortChatAgents } from '@/threads/presentation';

function useUnseenMissed(): [MissedInviteHistoryItem[], () => void] {
  const [missed, setMissed] = useState<MissedInviteHistoryItem[]>([]);
  useFocusEffect(
    useCallback(() => {
      const api = twringApi();
      if (!api) return;
      const controller = new AbortController();
      void Promise.all([api.history(controller.signal), missedLastSeen()])
        .then(([entries, seen]) => {
          if (!controller.signal.aborted) setMissed(unseenMissed(entries, seen));
        })
        .catch(() => undefined);
      return () => controller.abort();
    }, []),
  );
  return [
    missed,
    () => {
      setMissed([]);
      void markMissedSeen();
    },
  ];
}

function MissedCalls({
  items,
  agents,
  onSeen,
}: {
  items: MissedInviteHistoryItem[];
  agents: Agent[];
  onSeen: () => void;
}) {
  const palette = usePalette();
  if (!items.length) return null;
  return (
    <View style={styles.missedList}>
      {items.map((item) => {
        const row = missedCallRow(item, new Date());
        const agent = agents.find((candidate) => candidate.id === row.agentId);
        const aiApp = isAiApp(agent);
        return (
          <View key={row.key} style={[styles.missedCard, { borderColor: palette.border }]}>
            <Icon name="phoneMissed" size={22} color={palette.danger} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={row.accessibilityLabel}
              onPress={() => {
                onSeen();
                router.push('/history');
              }}
              style={styles.missedMain}
            >
              <Text numberOfLines={1} style={[type.body, { color: palette.textPrimary }]}>
                {row.line}
              </Text>
              <Text style={[type.caption, { color: palette.textTertiary }]}>{row.when}</Text>
            </Pressable>
            {agent && (
              <GhostButton
                label={aiApp ? 'Open chat' : 'Call back'}
                tone="accent"
                onPress={() => {
                  onSeen();
                  if (aiApp)
                    router.push({ pathname: '/chats/[agentId]', params: { agentId: row.agentId } });
                  else startCall({ agentId: row.agentId, name: row.agentName });
                }}
              />
            )}
          </View>
        );
      })}
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          onSeen();
          router.push('/history');
        }}
        style={styles.seeAll}
      >
        <Text style={{ color: palette.accent }}>See all</Text>
      </Pressable>
    </View>
  );
}

export default function ChatsScreen() {
  const palette = usePalette();
  const load = useCallback(
    (signal: AbortSignal) => twringApi()?.listAgents(signal) ?? Promise.resolve<Agent[]>([]),
    [],
  );
  const agents = useResource(load, { pollMs: STATUS_POLL_MS });
  const chats = useChatList();
  const [missed, markSeen] = useUnseenMissed();
  useEffect(() => {
    if (agents.data && shouldShowOnboarding(agents.data.length, onboardingSeen()))
      router.replace('/onboarding');
  }, [agents.data]);
  if (!mobileEnv.ok)
    return (
      <Screen title="Twring">
        <Text style={[type.body, { color: palette.textPrimary }]}>
          This build is missing its configuration. {mobileEnv.issues.join('; ')}
        </Text>
      </Screen>
    );
  const sorted = sortChatAgents(agents.data ?? [], chats.threads);
  const summaries = new Map(chats.threads.map((thread) => [thread.agent_id, thread]));
  const empty = agents.data?.length === 0;
  return (
    <Screen
      wordmark
      refreshing={agents.refreshing}
      onRefresh={() => {
        agents.reload({ refresh: true });
        chats.refresh();
      }}
      footer={
        empty ? (
          <PrimaryButton label="Connect Agent" onPress={() => router.push('/connect')} />
        ) : undefined
      }
    >
      <Text accessibilityRole="header" style={[type.display, { color: palette.textPrimary }]}>
        {chats.off ? 'Agents' : 'Chats'}
      </Text>
      <MissedCalls items={missed} agents={agents.data ?? []} onSeen={markSeen} />
      {agents.loading && (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel="Loading chats"
          style={styles.loading}
        >
          <Skeleton height={76} />
          <Skeleton height={76} />
          <Skeleton height={76} />
        </View>
      )}
      {agents.error && <ErrorNotice error={agents.error} onRetry={() => agents.reload()} />}
      {empty && (
        <Text style={[type.body, { color: palette.textSecondary, textAlign: 'center' }]}>
          {chats.off
            ? 'No agents yet. Connect one to call it.'
            : 'No agents yet. Connect one to start a chat or call.'}
        </Text>
      )}
      <View>
        {sorted.map((agent) => (
          <ChatRow
            key={agent.id}
            agent={agent}
            thread={summaries.get(agent.id)}
            chatsOff={chats.off}
            onPress={() =>
              router.push(
                chats.available
                  ? { pathname: '/chats/[agentId]', params: { agentId: agent.id } }
                  : { pathname: '/agents/[id]', params: { id: agent.id } },
              )
            }
          />
        ))}
      </View>
      {sorted.length > 0 && (
        <View style={styles.add}>
          <GhostButton label="Connect another agent" onPress={() => router.push('/connect')} />
        </View>
      )}
    </Screen>
  );
}
const styles = StyleSheet.create({
  missedList: { gap: 6 },
  missedCard: {
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
  },
  missedMain: { flex: 1, minWidth: 120, minHeight: 48, justifyContent: 'center' },
  seeAll: { alignSelf: 'flex-end', minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 },
  loading: { gap: 8 },
  add: { alignItems: 'center', marginTop: 16 },
});
