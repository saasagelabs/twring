import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import type { Agent } from '@twring/contracts';
import { isAiApp } from '@/agents/ai-app';
import { useCallback, useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { twringApi } from '@/api';
import { startCall } from '@/call/start';
import { Avatar } from '@/components/Avatar';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { Skeleton } from '@/components/Skeleton';
import { Waveform } from '@/components/Waveform';
import { useNow } from '@/hooks/useNow';
import { useResource } from '@/hooks/useResource';
import {
  DAY_GROUPS,
  groupHistory,
  historyListRow,
  historySummary,
  type MissedCallRow,
} from '@/ring/history';
import type { HistoryEntry } from '@/ring/protocol';
import { parseCallBack } from '@/ring/missed';
import { markMissedSeen } from '@/ring/missed-seen';
import { font } from '@/theme/fonts';
import { radius, space, type, usePalette } from '@/theme/tokens';

/** A ring nobody answered: why the agent called, and a way to call it back. */
function MissedCall({
  row,
  reason,
  avatarVersion,
  aiApp,
}: {
  row: MissedCallRow;
  reason?: string;
  avatarVersion?: number;
  aiApp?: boolean;
}) {
  const palette = usePalette();
  return (
    <View style={[styles.row, { borderColor: palette.border }]}>
      <Avatar id={row.agentId} name={row.agentName} avatarVersion={avatarVersion} size={44} />
      <View accessible accessibilityLabel={row.accessibilityLabel} style={styles.main}>
        <Text style={[styles.name, { color: palette.textPrimary }]}>{row.agentName}</Text>
        <Text style={[styles.meta, { color: palette.danger }]}>Missed · {row.when}</Text>
        {!!reason && <Text style={[styles.meta, { color: palette.textTertiary }]}>{reason}</Text>}
      </View>
      {aiApp !== undefined && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            aiApp ? `Open chat with ${row.agentName}` : `Call ${row.agentName} back`
          }
          onPress={() =>
            aiApp
              ? router.push({ pathname: '/chats/[agentId]', params: { agentId: row.agentId } })
              : startCall({ agentId: row.agentId, name: row.agentName })
          }
          style={styles.callHit}
        >
          <View style={[styles.callPill, { borderColor: palette.borderAccent }]}>
            {!aiApp && <Icon name="phone" size={13} color={palette.accent} strokeWidth={1.8} />}
            <Text style={[styles.callText, { color: palette.accent }]}>
              {aiApp ? 'Open chat' : 'Call back'}
            </Text>
          </View>
        </Pressable>
      )}
    </View>
  );
}

/** Call history: calls and missed agent rings, with no transcript kept. */
export default function HistoryScreen() {
  const palette = usePalette();
  const now = useNow();
  const load = useCallback((signal: AbortSignal) => {
    const api = twringApi();
    return api === undefined ? Promise.resolve<HistoryEntry[]>([]) : api.history(signal);
  }, []);
  const history = useResource(load);
  const agents = useResource(
    useCallback((signal: AbortSignal): Promise<Agent[]> => {
      const api = twringApi();
      return api ? api.listAgents(signal) : Promise.resolve([]);
    }, []),
  );
  const avatarVersion = (agentId: string) =>
    agents.data?.find((agent) => agent.id === agentId)?.avatar_version;
  const params = useLocalSearchParams<{ call_back?: string; name?: string }>();

  // Seeing Recents sees every missed call: Chats drops them and their notifications go.
  useFocusEffect(
    useCallback(() => {
      void markMissedSeen();
    }, []),
  );

  // "Call back" on a missed-call notification: call that agent once, then forget the link.
  const callBack = parseCallBack(params);
  const callBackId = callBack?.agentId;
  const callBackName = callBack?.name;
  useEffect(() => {
    // Wait for the agents to tell an AI app (opens its chat) from a callable agent; if they
    // can't load, call as before.
    if (callBackId === undefined || (!agents.data && !agents.error)) return;
    router.setParams({ call_back: undefined, name: undefined });
    if (isAiApp(agents.data?.find((agent) => agent.id === callBackId)))
      router.push({ pathname: '/chats/[agentId]', params: { agentId: callBackId } });
    else
      startCall({ agentId: callBackId, ...(callBackName !== undefined && { name: callBackName }) });
  }, [callBackId, callBackName, agents.data, agents.error]);

  const groups = groupHistory(history.data ?? [], now);
  const summary = historySummary(history.data ?? []);
  return (
    <Screen
      title="Recents"
      refreshing={history.refreshing}
      onRefresh={() => history.reload({ refresh: true })}
    >
      {summary !== undefined && (
        <Text style={[type.caption, styles.summary, { color: palette.textTertiary }]}>
          {summary}
        </Text>
      )}
      {history.loading && (
        <View accessible accessibilityLabel="Loading call history" style={styles.loading}>
          {[0, 1, 2, 3, 4].map((item) => (
            <Skeleton key={item} height={68} />
          ))}
        </View>
      )}
      {history.error !== undefined && (
        <ErrorNotice error={history.error} onRetry={() => history.reload()} />
      )}
      {history.data?.length === 0 && (
        <View style={styles.empty}>
          <Waveform
            width={280}
            height={80}
            color={palette.accent}
            intensity={0.18}
            animated={false}
          />
          <Text style={[type.body, styles.emptyText, { color: palette.textSecondary }]}>
            Your completed calls will appear here.
          </Text>
        </View>
      )}
      {DAY_GROUPS.map(
        (group) =>
          groups[group].length > 0 && (
            <View key={group} style={styles.group}>
              <Text style={[type.microLabel, styles.groupLabel, { color: palette.textTertiary }]}>
                {group}
              </Text>
              {groups[group].map((item) => {
                const row = historyListRow(item, now);
                const matchedAgent =
                  row.kind === 'missed'
                    ? agents.data?.find((agent) => agent.id === row.agentId)
                    : undefined;
                if (row.kind === 'missed')
                  return (
                    <MissedCall
                      key={row.key}
                      row={row}
                      reason={item.reason?.trim()}
                      avatarVersion={avatarVersion(row.agentId)}
                      aiApp={matchedAgent ? isAiApp(matchedAgent) : undefined}
                    />
                  );
                return (
                  <View
                    key={row.key}
                    accessible
                    accessibilityLabel={row.accessibilityLabel}
                    style={[styles.row, { borderColor: palette.border }]}
                  >
                    <Avatar
                      id={item.agent_id}
                      name={row.agentName}
                      avatarVersion={avatarVersion(item.agent_id)}
                      size={44}
                    />
                    <View style={styles.main}>
                      <Text style={[styles.name, { color: palette.textPrimary }]}>
                        {row.agentName}
                      </Text>
                      <Text
                        style={[
                          styles.meta,
                          { color: row.failed ? palette.danger : palette.textTertiary },
                        ]}
                      >
                        {row.outcome} · {row.when} · {row.duration}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          ),
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { marginTop: -14, fontVariant: ['tabular-nums'] },
  loading: { gap: 6 },
  empty: { alignItems: 'center', gap: space.lg, paddingTop: 72 },
  emptyText: { textAlign: 'center' },
  group: { gap: space.sm },
  groupLabel: { paddingLeft: space.xs, letterSpacing: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 68,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
  },
  main: { flex: 1, gap: 3 },
  name: { fontFamily: font.interMedium, fontSize: 15 },
  meta: { fontFamily: font.caption, fontSize: 12, lineHeight: 17 },
  callHit: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  callPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(25,214,242,0.06)',
  },
  callText: { fontFamily: font.interMedium, fontSize: 13 },
});
