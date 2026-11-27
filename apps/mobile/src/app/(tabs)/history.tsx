import { router, useLocalSearchParams } from 'expo-router';
import type { Agent } from '@twring/contracts';
import { isAiApp } from '@/agents/ai-app';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { twringApi } from '@/api';
import { ApiError } from '@/api/client';
import { apiErrorCopy, type ErrorCopy } from '@/api/errors';
import { startCall } from '@/call/start';
import { Avatar } from '@/components/Avatar';
import { CallButton } from '@/components/CallButton';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { IconButton } from '@/components/IconButton';
import { ListRow } from '@/components/ListRow';
import { Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { Skeleton } from '@/components/Skeleton';
import { TextButton } from '@/components/TextButton';
import { Waveform } from '@/components/Waveform';
import { useNow } from '@/hooks/useNow';
import { useResource } from '@/hooks/useResource';
import {
  DAY_GROUPS,
  groupHistory,
  historyListRow,
  historySummary,
  withoutRemoved,
} from '@/ring/history';
import type { HistoryEntry } from '@/ring/protocol';
import { parseCallBack } from '@/ring/missed';
import { markMissedSeen } from '@/ring/missed-seen';
import { useFocusRefresh } from '@/hooks/foreground';
import { space, type, usePalette } from '@/theme/tokens';

const DELETE_ACTION = 'delete';
const DELETE_ACTIONS = [{ name: DELETE_ACTION, label: 'Delete from Recents' }] as const;

/** What a failed clear says; an older self-hosted server has no clear endpoint (404/405). */
function clearErrorCopy(error: unknown): ErrorCopy {
  if (
    error instanceof ApiError &&
    error.kind === 'http' &&
    (error.status === 404 || error.status === 405)
  ) {
    return { message: 'Your server needs an update to clear Recents.', retryable: false };
  }
  return apiErrorCopy(error);
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
  // Also on return to the foreground, when Recents reloads with rings missed while away.
  useFocusRefresh(() => {
    void markMissedSeen();
  });

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

  // Deleted entries leave the list as soon as the server confirms, before the reload lands.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<{ kind: 'one'; id: string } | { kind: 'all' }>();
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<ErrorCopy>();
  const entries = withoutRemoved(history.data ?? [], removed);

  function runDelete() {
    const api = twringApi();
    if (confirm === undefined || api === undefined || busy) return;
    const ids = confirm.kind === 'one' ? [confirm.id] : entries.map((entry) => entry.call_id);
    setBusy(true);
    setDeleteError(undefined);
    const request = confirm.kind === 'one' ? api.deleteHistoryItem(confirm.id) : api.clearHistory();
    void request
      .then(
        () => {
          setRemoved((current) => new Set([...current, ...ids]));
          setConfirm(undefined);
          history.reload({ silent: true });
        },
        (error: unknown) => {
          setConfirm(undefined);
          setDeleteError(confirm.kind === 'all' ? clearErrorCopy(error) : apiErrorCopy(error));
        },
      )
      .finally(() => setBusy(false));
  }
  const rowActions = (id: string) => ({
    onLongPress: () => setConfirm({ kind: 'one', id }),
    accessibilityActions: DELETE_ACTIONS,
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
      if (event.nativeEvent.actionName === DELETE_ACTION) setConfirm({ kind: 'one', id });
    },
  });

  const groups = groupHistory(entries, now);
  const summary = historySummary(entries);
  return (
    <Screen
      brand
      title="Recents"
      refreshing={history.refreshing}
      onRefresh={() => history.reload({ refresh: true })}
    >
      {summary !== undefined && (
        <View style={styles.summaryRow}>
          <Text style={[type.caption, styles.summary, { color: palette.textTertiary }]}>
            {summary}
          </Text>
          {entries.length > 0 && (
            <TextButton
              label="Clear all"
              tone="danger"
              disabled={busy}
              onPress={() => setConfirm({ kind: 'all' })}
            />
          )}
        </View>
      )}
      {deleteError !== undefined && <ErrorNotice error={deleteError} />}
      {history.loading && (
        <View accessible accessibilityLabel="Loading call history" style={styles.loading}>
          {[0, 1, 2, 3, 4].map((item) => (
            <Skeleton key={item} height={72} />
          ))}
        </View>
      )}
      {history.error !== undefined && (
        <ErrorNotice error={history.error} onRetry={() => history.reload()} />
      )}
      {history.data !== undefined && entries.length === 0 && (
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
              <View>
                {groups[group].map((item) => {
                  const row = historyListRow(item, now);
                  const avatar = (
                    <Avatar
                      id={item.agent_id}
                      name={row.agentName}
                      avatarVersion={avatarVersion(item.agent_id)}
                      size={44}
                    />
                  );
                  if (row.kind === 'missed') {
                    const matchedAgent = agents.data?.find((agent) => agent.id === row.agentId);
                    const aiApp = matchedAgent ? isAiApp(matchedAgent) : undefined;
                    const reason = item.reason?.trim();
                    return (
                      <ListRow
                        key={row.key}
                        avatar={avatar}
                        title={row.agentName}
                        line={`Missed · ${row.when}`}
                        lineTone="danger"
                        {...(reason ? { line2: reason } : {})}
                        accessibilityLabel={row.accessibilityLabel}
                        {...rowActions(item.call_id)}
                        right={
                          aiApp === true ? (
                            <IconButton
                              icon="chat"
                              size={40}
                              accessibilityLabel={`Open chat with ${row.agentName}`}
                              onPress={() =>
                                router.push({
                                  pathname: '/chats/[agentId]',
                                  params: { agentId: row.agentId },
                                })
                              }
                            />
                          ) : aiApp === false ? (
                            <CallButton
                              name={row.agentName}
                              onPress={() =>
                                startCall({ agentId: row.agentId, name: row.agentName })
                              }
                            />
                          ) : undefined
                        }
                      />
                    );
                  }
                  return (
                    <ListRow
                      key={row.key}
                      avatar={avatar}
                      title={row.agentName}
                      line={`${row.outcome} · ${row.when} · ${row.duration}`}
                      lineTone={row.failed ? 'danger' : 'secondary'}
                      accessibilityLabel={row.accessibilityLabel}
                      {...rowActions(item.call_id)}
                    />
                  );
                })}
              </View>
            </View>
          ),
      )}
      <Sheet
        visible={confirm !== undefined}
        title={confirm?.kind === 'all' ? 'Clear Recents?' : 'Delete this call?'}
        onClose={() => {
          if (!busy) setConfirm(undefined);
        }}
      >
        <View style={styles.sheet}>
          <Text style={[type.body, { color: palette.textSecondary }]}>
            {confirm?.kind === 'all'
              ? "This deletes your call list from Twring. Calls in your chats stay. This can't be undone."
              : 'It is removed from Recents. Calls in your chats stay.'}
          </Text>
          <GhostButton
            label={confirm?.kind === 'all' ? 'Clear all' : 'Delete'}
            tone="danger"
            disabled={busy}
            onPress={runDelete}
          />
          <GhostButton label="Cancel" disabled={busy} onPress={() => setConfirm(undefined)} />
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  summary: { flex: 1, fontVariant: ['tabular-nums'] },
  sheet: { gap: 14 },
  loading: { gap: space.xs },
  empty: { alignItems: 'center', gap: space.lg, paddingTop: 72 },
  emptyText: { textAlign: 'center' },
  group: { gap: space.xs },
  groupLabel: { paddingLeft: space.xs, letterSpacing: 1 },
});
