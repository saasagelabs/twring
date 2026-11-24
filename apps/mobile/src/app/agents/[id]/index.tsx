import type { Agent, CallHistoryItem } from '@twring/contracts';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { savedVoiceLabel } from '@/agents/voice-groups';
import { keytermSummary } from '@/agents/keyterms';
import { canEditAgent, SHARED_AGENT_NOTE } from '@/agents/shared';
import {
  aiAppReachability,
  canCall,
  isAiApp,
  removeAiAppCopy,
  showComputerCallHint,
} from '@/agents/ai-app';
import { agentStatusFor, formatWhen, historyRow } from '@/agents/labels';
import { apiErrorCopy, twringApi, type ErrorCopy } from '@/api';
import { callAgent } from '@/call/call-agent';
import { Avatar } from '@/components/Avatar';
import { CallPill } from '@/components/CallPill';
import { ComputerCallHint } from '@/components/ComputerCallHint';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { IconButton } from '@/components/IconButton';
import { Sheet } from '@/components/Sheet';
import { OfflineHelp } from '@/components/OfflineHelp';
import { goBack, Screen } from '@/components/Screen';
import { SettingsGroup, SettingsRow } from '@/components/SettingsGroup';
import { StatusLabel } from '@/components/StatusLabel';
import { useNow } from '@/hooks/useNow';
import { STATUS_POLL_MS, useResource } from '@/hooks/useResource';
import { space, type, usePalette } from '@/theme/tokens';
import { chatController, useChatList } from '@/threads/chats';
import { useChatExport } from '@/threads/useChatExport';

interface Detail {
  agent: Agent;
  calls: CallHistoryItem[];
  voiceLabel: string | undefined;
}

/** Agent detail (UX_UI_SPEC §8): organized around Call, details below, never a dashboard. */
export default function AgentDetailScreen() {
  const palette = usePalette();
  const now = useNow();
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<ErrorCopy | undefined>(undefined);
  const chats = useChatList();
  const [clearVisible, setClearVisible] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<ErrorCopy | undefined>();
  const [newVisible, setNewVisible] = useState(false);
  const [startingNew, setStartingNew] = useState(false);
  const [newError, setNewError] = useState<ErrorCopy | undefined>();

  const load = useCallback(
    async (signal: AbortSignal): Promise<Detail> => {
      const api = twringApi();
      if (api === undefined) throw new Error('not configured');
      const [agent, calls, voices] = await Promise.all([
        api.getAgent(id, signal),
        api.callHistory(signal).catch(() => [] as CallHistoryItem[]),
        api.listVoices(signal).catch(() => undefined),
      ]);
      return {
        agent,
        calls: calls.filter((call) => call.agent_id === id),
        voiceLabel:
          voices === undefined ? undefined : savedVoiceLabel(agent.voice_id, voices.voices),
      };
    },
    [id],
  );
  // Polled while open so the computer's online status stays current.
  const detail = useResource(load, { pollMs: STATUS_POLL_MS });
  const exporter = useChatExport(detail.data?.agent);

  function confirmDelete(agent: Agent) {
    const aiApp = isAiApp(agent);
    Alert.alert(
      aiApp ? `Remove ${agent.name}?` : `Delete ${agent.name}?`,
      aiApp
        ? removeAiAppCopy(agent.name)
        : 'Twring removes its connection settings and saved key. Your agent itself is not changed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: aiApp ? 'Remove' : 'Delete',
          style: 'destructive',
          onPress: () => {
            setDeleting(true);
            setDeleteError(undefined);
            twringApi()
              ?.deleteAgent(agent.id)
              .then(goBack, (reason: unknown) => setDeleteError(apiErrorCopy(reason)))
              .finally(() => setDeleting(false));
          },
        },
      ],
    );
  }

  if (detail.data === undefined) {
    return (
      <Screen back>
        {detail.error !== undefined ? (
          <ErrorNotice error={detail.error} onRetry={() => detail.reload()} />
        ) : (
          <ActivityIndicator accessibilityLabel="Loading agent" color={palette.textSecondary} />
        )}
      </Screen>
    );
  }

  const { agent, calls, voiceLabel } = detail.data;
  const aiApp = isAiApp(agent);
  const status = agentStatusFor(agent);
  const lastCall = calls[0];
  const editable = canEditAgent(agent);
  const offline = agent.connector_online === false || agent.connector_removed === true;
  const canStartNew = agent.protocol === 'cord-connector' || agent.protocol === 'openai-chat';

  return (
    <Screen
      back
      headerRight={
        editable ? (
          <IconButton
            icon="pencil"
            accessibilityLabel="Edit agent"
            onPress={() => router.push({ pathname: '/agents/[id]/edit', params: { id: agent.id } })}
          />
        ) : undefined
      }
      refreshing={detail.refreshing}
      onRefresh={() => detail.reload({ refresh: true })}
    >
      {detail.error !== undefined && (
        <ErrorNotice error={detail.error} onRetry={() => detail.reload()} />
      )}
      {deleteError !== undefined && <ErrorNotice error={deleteError} />}
      {clearError !== undefined && <ErrorNotice error={clearError} />}
      {exporter.error !== undefined && (
        <ErrorNotice error={exporter.error} onRetry={exporter.start} />
      )}
      {exporter.note !== undefined && (
        <Text style={[type.caption, { color: palette.textSecondary }]}>{exporter.note}</Text>
      )}

      <View style={styles.identity}>
        <Avatar
          id={agent.id}
          name={agent.name}
          avatarVersion={agent.avatar_version}
          size={56}
          online={agent.connector_online}
        />
        <View style={styles.identityText}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={[type.title, { color: palette.textPrimary }]}
          >
            {agent.name}
          </Text>
          <StatusLabel label={status.label} tone={status.tone} />
        </View>
        {canCall(agent) && (
          <CallPill
            accessibilityLabel={offline ? `Call ${agent.name}, offline` : `Call ${agent.name}`}
            disabled={offline}
            onPress={() => callAgent(agent)}
          />
        )}
      </View>

      {agent.connector_online === false && agent.connector_removed !== true && (
        <OfflineHelp protocol={agent.protocol} color={palette.textSecondary} />
      )}

      {aiApp && (
        <View style={styles.reach}>
          <Text style={[type.body, { color: palette.textSecondary }]}>
            {aiAppReachability(agent.name, showComputerCallHint(agent))}
          </Text>
          {showComputerCallHint(agent) && <ComputerCallHint name={agent.name} />}
        </View>
      )}

      {agent.shared === true && (
        <Text style={[type.caption, styles.note, { color: palette.textSecondary }]}>
          {SHARED_AGENT_NOTE}
        </Text>
      )}

      {!aiApp && editable && (
        <SettingsGroup title="Settings">
          <SettingsRow
            label="Voice"
            value={voiceLabel ?? agent.voice_id}
            accessibilityHint="Choose how this agent sounds"
            onPress={() =>
              router.push({ pathname: '/agents/[id]/voice', params: { id: agent.id } })
            }
          />
          <SettingsRow
            label="Words to recognise"
            value={keytermSummary(agent.keyterms)}
            accessibilityHint="Add or remove names and places"
            divider={agent.protocol !== 'mcp-app'}
            onPress={() =>
              router.push({ pathname: '/agents/[id]/words', params: { id: agent.id } })
            }
          />
          {agent.protocol !== 'mcp-app' && (
            <SettingsRow
              label="Connection"
              value={`${status.label}${agent.last_tested_at !== undefined ? ` · tested ${formatWhen(agent.last_tested_at, now)}` : ''}`}
              divider={false}
            />
          )}
        </SettingsGroup>
      )}

      {!aiApp && (
        <SettingsGroup title="Calls">
          <SettingsRow
            label="Call history"
            value={
              lastCall !== undefined
                ? `Last call · ${formatWhen(lastCall.started_at, now)}`
                : 'No calls yet'
            }
            divider={calls.length > 0}
          />
          {calls.slice(0, 5).map((call) => {
            const row = historyRow(call, now);
            return (
              <View
                key={row.key}
                accessible
                accessibilityLabel={row.accessibilityLabel}
                style={styles.history}
              >
                <Text style={[type.caption, { color: palette.textSecondary }]}>{row.when}</Text>
                <Text
                  style={[type.caption, { color: palette.textTertiary }]}
                >{`${row.duration} · ${row.outcome}`}</Text>
              </View>
            );
          })}
        </SettingsGroup>
      )}

      {!aiApp && (chats.available || canStartNew) && (
        <SettingsGroup title="Conversation">
          {chats.available && (
            <SettingsRow
              label="Photos and files"
              accessibilityHint="Shows every photo and file in this chat"
              onPress={() =>
                router.push({
                  pathname: '/agents/[id]/media',
                  params: { id: agent.id, name: agent.name },
                })
              }
            />
          )}
          {canStartNew && (
            <SettingsRow
              label="Start a new conversation"
              accessibilityHint="Asks before starting fresh"
              divider={chats.available}
              onPress={() => setNewVisible(true)}
            />
          )}
          {chats.available &&
            (exporter.progress === undefined ? (
              <SettingsRow
                label="Export chat"
                accessibilityHint="Shares the whole chat as a text file"
                onPress={exporter.start}
              />
            ) : (
              <SettingsRow
                label={`Preparing ${exporter.progress.toLocaleString('en-US')} messages`}
                value="Cancel"
                accessibilityHint="Stops the export"
                onPress={exporter.cancel}
              />
            ))}
          {chats.available && (
            <SettingsRow
              label="Clear chat"
              danger
              accessibilityHint="Asks before deleting your messages"
              divider={false}
              onPress={() => setClearVisible(true)}
            />
          )}
        </SettingsGroup>
      )}

      {(!aiApp || editable) && (
        <SettingsGroup title="Advanced">
          {!aiApp && (
            <SettingsRow
              label="Connection details"
              accessibilityHint="Shows how Twring reaches this agent"
              divider={editable}
              onPress={() =>
                router.push({ pathname: '/agents/[id]/connection', params: { id: agent.id } })
              }
            />
          )}
          {editable && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={aiApp ? `Remove ${agent.name}` : 'Delete agent'}
              accessibilityHint="Asks before removing this agent from Twring"
              accessibilityState={{ disabled: deleting }}
              disabled={deleting}
              onPress={() => confirmDelete(agent)}
              style={({ pressed }) => [
                styles.dangerRow,
                { opacity: deleting ? 0.5 : pressed ? 0.6 : 1 },
              ]}
            >
              <Text style={[type.body, { color: palette.danger }]}>
                {aiApp ? `Remove ${agent.name}` : 'Delete agent'}
              </Text>
            </Pressable>
          )}
        </SettingsGroup>
      )}
      <Sheet
        visible={clearVisible}
        title={`Clear chat with ${agent.name}?`}
        onClose={() => setClearVisible(false)}
      >
        <View style={styles.clearSheet}>
          <Text
            style={[type.body, { color: palette.textSecondary }]}
          >{`This deletes your messages with ${agent.name} from Twring. ${agent.name} keeps its own memory.`}</Text>
          <GhostButton
            label="Clear chat"
            tone="danger"
            disabled={clearing}
            onPress={() => {
              setClearing(true);
              void twringApi()
                ?.clearChat(agent.id)
                .then(
                  () => {
                    setClearVisible(false);
                    chatController()?.forgetChat(agent.id);
                    chats.refresh();
                  },
                  (error: unknown) => setClearError(apiErrorCopy(error)),
                )
                .finally(() => setClearing(false));
            }}
          />
          <GhostButton label="Cancel" onPress={() => setClearVisible(false)} />
        </View>
      </Sheet>
      <Sheet
        visible={newVisible}
        title={`Start a new conversation with ${agent.name}?`}
        onClose={() => {
          if (!startingNew) setNewVisible(false);
        }}
      >
        <View style={styles.clearSheet}>
          {newError !== undefined && <ErrorNotice error={newError} />}
          <Text
            style={[type.body, { color: palette.textSecondary }]}
          >{`${agent.name} starts fresh in Twring: it won't carry over what you said in earlier calls and chats here. Your messages stay. Use this if ${agent.name} seems stuck, or after you change its model or settings.`}</Text>
          <GhostButton
            label="Start new conversation"
            disabled={startingNew}
            onPress={() => {
              setStartingNew(true);
              setNewError(undefined);
              const api = twringApi();
              if (api === undefined) {
                setNewError(apiErrorCopy(new Error('not configured')));
                setStartingNew(false);
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
                  () => undefined,
                );
                return;
              }
              void api
                .newConversation(agent.id)
                .then(
                  () => setNewVisible(false),
                  (error: unknown) => {
                    setNewError(apiErrorCopy(error));
                    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
                      () => undefined,
                    );
                  },
                )
                .finally(() => setStartingNew(false));
            }}
          />
          {startingNew && (
            <ActivityIndicator
              accessibilityLabel="Starting new conversation"
              color={palette.textSecondary}
            />
          )}
          <GhostButton label="Cancel" disabled={startingNew} onPress={() => setNewVisible(false)} />
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  identityText: { flex: 1, gap: space.xs },
  reach: { gap: space.sm },
  note: { paddingHorizontal: 14, paddingVertical: space.sm },
  history: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: space.sm,
  },
  dangerRow: {
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 12,
    justifyContent: 'center',
  },
  clearSheet: { gap: 14 },
});
