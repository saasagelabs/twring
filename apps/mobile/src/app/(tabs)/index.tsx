import type { Agent } from '@twring/contracts';
import { router } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { agentStatusLine, orderAgents } from '@/agents/order';
import { canCall } from '@/agents/ai-app';
import { twringApi } from '@/api';
import { startCall } from '@/call/start';
import { Avatar } from '@/components/Avatar';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { Icon } from '@/components/Icon';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { Skeleton } from '@/components/Skeleton';
import { mobileEnv } from '@/config/env';
import { STATUS_POLL_MS, useResource } from '@/hooks/useResource';
import { onboardingSeen, shouldShowOnboarding } from '@/onboarding/state';
import { useChatList } from '@/threads/chats';
import { radius, space, type, usePalette } from '@/theme/tokens';

function AgentCard({ agent }: { agent: Agent }) {
  const palette = usePalette();
  const status = agentStatusLine(agent);
  return (
    <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
      <Pressable
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${agent.name}, ${status}`}
        onPress={() => router.push({ pathname: '/agents/[id]', params: { id: agent.id } })}
        style={styles.cardBody}
      >
        <Avatar
          id={agent.id}
          name={agent.name}
          avatarVersion={agent.avatar_version}
          size={56}
          online={agent.protocol === 'cord-connector' ? status === 'Online' : undefined}
        />
        <View style={styles.cardText}>
          <Text style={[type.headline, { color: palette.textPrimary }]}>{agent.name}</Text>
          <Text style={[type.caption, { color: palette.textSecondary }]}>{status}</Text>
        </View>
      </Pressable>
      {canCall(agent) && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Call ${agent.name}`}
          onPress={() => startCall({ agentId: agent.id, name: agent.name })}
          style={[
            styles.call,
            { backgroundColor: palette.surfaceRaised, borderColor: palette.borderAccent },
          ]}
        >
          <Icon name="phone" size={24} color={palette.accent} />
        </Pressable>
      )}
    </View>
  );
}

export default function AgentsScreen() {
  const palette = usePalette();
  const load = useCallback(
    (signal: AbortSignal) => twringApi()?.listAgents(signal) ?? Promise.resolve<Agent[]>([]),
    [],
  );
  const agents = useResource(load, { pollMs: STATUS_POLL_MS });
  const chats = useChatList();
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
  const sorted = orderAgents(agents.data ?? [], chats.threads);
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
      <Text accessibilityRole="header" style={[type.screenTitle, { color: palette.textPrimary }]}>
        Agents
      </Text>
      {agents.loading && (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel="Loading agents"
          style={styles.list}
        >
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} height={88} />
          ))}
        </View>
      )}
      {agents.error && <ErrorNotice error={agents.error} onRetry={() => agents.reload()} />}
      {empty && (
        <Text style={[type.body, styles.empty, { color: palette.textSecondary }]}>
          Your agents will appear here. Connect one and Twring will make it callable.
        </Text>
      )}
      <View style={styles.list}>
        {sorted.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
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
  list: { gap: space.sm },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.sm,
  },
  cardBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.md, minWidth: 0 },
  cardText: { flex: 1, gap: space.xs },
  call: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { textAlign: 'center' },
  add: { alignItems: 'center', marginTop: space.lg },
});
