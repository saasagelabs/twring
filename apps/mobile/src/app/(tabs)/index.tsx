import type { Agent } from '@twring/contracts';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { agentCache, OFFLINE_SAVED_AGENTS } from '@/agents/agent-cache';
import { homeRow } from '@/agents/home-rows';
import { twringApi } from '@/api';
import { startCall } from '@/call/start';
import { Avatar } from '@/components/Avatar';
import { TwringLockup } from '@/components/Brand';
import { CallButton } from '@/components/CallButton';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Icon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { ListRow } from '@/components/ListRow';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { Skeleton } from '@/components/Skeleton';
import { mobileEnv } from '@/config/env';
import { STATUS_POLL_MS, useResource } from '@/hooks/useResource';
import { onboardingSeen, shouldShowOnboarding } from '@/onboarding/state';
import { unseenMissed } from '@/ring/missed';
import { markMissedSeen, missedLastSeen } from '@/ring/missed-seen';
import { radius, space, type, usePalette } from '@/theme/tokens';
import { useChatList } from '@/threads/chats';
import { sortChatAgents } from '@/threads/presentation';

const savedAgents = agentCache();

/** Agents with a missed ring the owner has not seen yet, and a way to mark them all seen. */
function useUnseenMissed(): [ReadonlySet<string>, () => void] {
  const [missed, setMissed] = useState<ReadonlySet<string>>(new Set());
  useFocusEffect(
    useCallback(() => {
      const api = twringApi();
      if (!api) return;
      const controller = new AbortController();
      void Promise.all([api.history(controller.signal), missedLastSeen()])
        .then(([entries, seen]) => {
          if (!controller.signal.aborted)
            setMissed(new Set(unseenMissed(entries, seen).map((entry) => entry.agent_id)));
        })
        .catch(() => undefined);
      return () => controller.abort();
    }, []),
  );
  return [
    missed,
    () => {
      setMissed(new Set());
      void markMissedSeen();
    },
  ];
}

export default function AgentsScreen() {
  const palette = usePalette();
  const load = useCallback(
    (signal: AbortSignal) => twringApi()?.listAgents(signal) ?? Promise.resolve<Agent[]>([]),
    [],
  );
  const agents = useResource(load, { pollMs: STATUS_POLL_MS, cache: savedAgents });
  const chats = useChatList();
  const [missed, markSeen] = useUnseenMissed();
  useEffect(() => {
    // Only a fresh list decides onboarding: a saved one may be out of date.
    if (agents.data && !agents.stale && shouldShowOnboarding(agents.data.length, onboardingSeen()))
      router.replace('/onboarding');
  }, [agents.data, agents.stale]);
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
  const empty = agents.data?.length === 0 && !agents.stale;
  return (
    <Screen
      brand
      title="Agents"
      headerRight={
        chats.available && sorted.length > 0 ? (
          <View style={styles.header}>
            <IconButton
              icon="search"
              accessibilityLabel="Search your chats"
              onPress={() => router.push('/chats/search')}
            />
            <TwringLockup size={18} glow={false} />
          </View>
        ) : undefined
      }
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
      {agents.loading && (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel="Loading agents"
          style={styles.loading}
        >
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} height={72} />
          ))}
        </View>
      )}
      {agents.error && agents.stale ? (
        <Text
          accessibilityRole="alert"
          style={[type.caption, { color: palette.textSecondary, textAlign: 'center' }]}
        >
          {OFFLINE_SAVED_AGENTS}
        </Text>
      ) : (
        agents.error && <ErrorNotice error={agents.error} onRetry={() => agents.reload()} />
      )}
      {empty && (
        <Text style={[type.body, { color: palette.textSecondary, textAlign: 'center' }]}>
          {chats.off
            ? 'No agents yet. Connect one to call it.'
            : 'No agents yet. Connect one to start a chat or call.'}
        </Text>
      )}
      <View>
        {sorted.map((agent) => {
          const row = homeRow(agent, summaries.get(agent.id), missed, chats.off);
          return (
            <ListRow
              key={agent.id}
              avatar={
                <Avatar
                  id={agent.id}
                  name={agent.name}
                  avatarVersion={agent.avatar_version}
                  size={48}
                  online={row.aiApp || agents.stale ? undefined : !row.offline}
                />
              }
              title={agent.name}
              titleTone={row.offline ? 'secondary' : 'primary'}
              meta={row.time}
              metaTone={row.unread ? 'accent' : 'tertiary'}
              line={row.line}
              lineTone={row.lineTone}
              badge={row.unread}
              accessibilityLabel={row.accessibilityLabel}
              onPress={() => {
                if (row.missed) markSeen();
                router.push(
                  chats.available
                    ? { pathname: '/chats/[agentId]', params: { agentId: agent.id } }
                    : { pathname: '/agents/[id]', params: { id: agent.id } },
                );
              }}
              right={
                row.call === 'none' ? undefined : (
                  <CallButton
                    name={agent.name}
                    variant="outline"
                    disabled={row.call === 'disabled'}
                    onPress={() => {
                      if (row.missed) markSeen();
                      startCall({ agentId: agent.id, name: agent.name });
                    }}
                  />
                )
              }
            />
          );
        })}
        {sorted.length > 0 && (
          <ListRow
            avatar={
              <View style={[styles.add, { borderColor: palette.borderAccent }]}>
                <Icon name="add" size={22} color={palette.accent} />
              </View>
            }
            title="Connect another agent"
            accessibilityLabel="Connect another agent"
            onPress={() => router.push('/connect')}
          />
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { gap: space.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  add: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
