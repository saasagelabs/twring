import { isActive, type ThreadMessage } from '@twring/contracts';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { agentStatusFor, callRefusal } from '@/agents/labels';
import {
  aiAppEmptyChat,
  aiAppReplyStatus,
  canCall,
  isAiApp,
  showComputerCallHint,
} from '@/agents/ai-app';
import { autoListenTarget } from '@/threads/auto-listen';
import { ApiError, twringApi } from '@/api';
import { callAgent } from '@/call/call-agent';
import { callController, useCallView } from '@/call/session';
import { Avatar } from '@/components/Avatar';
import { ComputerCallHint } from '@/components/ComputerCallHint';
import { Bubble } from '@/components/chat/Bubble';
import { ChatApproval } from '@/components/chat/ChatApproval';
import { CallCard } from '@/components/chat/CallCard';
import { Composer } from '@/components/chat/Composer';
import { DateSeparator } from '@/components/chat/DateSeparator';
import { LinkSheet } from '@/components/chat/LinkSheet';
import { ListenButton, stopMessageSpeech } from '@/components/chat/ListenButton';
import { Notice } from '@/components/chat/Notice';
import { WorkingRow } from '@/components/chat/WorkingRow';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { Icon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { Skeleton } from '@/components/Skeleton';
import { useNow } from '@/hooks/useNow';
import { ringPlatform } from '@/platform/ring';
import { STATUS_POLL_MS, useResource } from '@/hooks/useResource';
import { font } from '@/theme/fonts';
import { type, usePalette, radius } from '@/theme/tokens';
import { useChat } from '@/threads/chats';
import { callDuration, dateLabel, messageStatus } from '@/threads/presentation';
import type { PreparedFile } from '@/threads/files';
import { File } from 'expo-file-system';
import { apiErrorCopy } from '@/api/errors';

type Row =
  | { key: string; kind: 'date'; label: string }
  | { key: string; kind: 'message'; message: ThreadMessage }
  | {
      key: string;
      kind: 'pending';
      text: string;
      clientId: string;
      state: 'sending' | 'failed';
      createdAt: string;
      voice?: { uri: string; durationMs: number };
      files?: PreparedFile[];
      error?: unknown;
    }
  | { key: string; kind: 'working' };
const timeOf = (date: string) =>
  new Date(date).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });

export default function ChatScreen() {
  const { agentId, listen } = useLocalSearchParams<{ agentId: string; listen?: string }>();
  const id = typeof agentId === 'string' ? agentId : '';
  useFocusEffect(
    useCallback(() => {
      if (id) ringPlatform.clearMessages(id);
      return () => stopMessageSpeech();
    }, [id]),
  );
  const palette = usePalette();
  const now = useNow();
  const chat = useChat(id);
  const call = useCallView();
  const [callForThisChat, setCallForThisChat] = useState(false);
  const onCall = callForThisChat && isActive(call.call);
  useEffect(() => {
    if (isActive(call.call)) stopMessageSpeech();
  }, [call.call]);
  useEffect(() => {
    const controller = callController();
    return controller?.subscribe(() => {
      if (!isActive(controller.getView().call)) setCallForThisChat(false);
    });
  }, []);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<PreparedFile[]>([]);
  const unsentFiles = useRef<PreparedFile[]>([]);
  useEffect(() => {
    unsentFiles.current = files;
  }, [files]);
  useEffect(
    () => () => {
      for (const file of unsentFiles.current) {
        try {
          new File(file.uri).delete();
        } catch {
          /* cache may already be gone */
        }
      }
    },
    [],
  );
  const [url, setUrl] = useState<string>();
  const [removed, setRemoved] = useState(false);
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        return await (twringApi()?.getAgent(id, signal) ??
          Promise.reject(new Error('Not configured')));
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'http' && error.status === 404)
          setRemoved(true);
        throw error;
      }
    },
    [id],
  );
  const agent = useResource(load, { pollMs: STATUS_POLL_MS });
  // A message from the agent proves it is reachable now; refresh its status rather than wait for the poll.
  const latestRev = chat.state.maxRev;
  const reloadAgent = agent.reload;
  useEffect(() => {
    if (latestRev > 0) reloadAgent({ silent: true });
  }, [latestRev, reloadAgent]);
  const loadMessages = useCallback(
    async (signal: AbortSignal) => {
      const api = twringApi();
      if (!api) throw new Error('Not configured');
      return api.listMessages(id, { limit: 50 }, signal);
    },
    [id],
  );
  const messagePage = useResource(loadMessages);
  const messages = useMemo(
    () =>
      chat.state.messages.length
        ? chat.state.messages
        : [...(messagePage.data?.messages ?? [])].sort((a, b) => a.seq - b.seq),
    [chat.state.messages, messagePage.data?.messages],
  );
  const name = agent.data?.name ?? 'Agent';
  const aiApp = isAiApp(agent.data);
  const autoListenId = autoListenTarget(messages, listen === '1' && !messagePage.loading);
  useEffect(() => {
    if (autoListenId) router.setParams({ listen: undefined });
  }, [autoListenId]);
  const offline = agent.data ? callRefusal(agent.data) !== undefined : true;
  const lastUser = [...messages].reverse().find((entry) => entry.kind === 'user_text');
  const working =
    !!chat.state.progress || (lastUser?.kind === 'user_text' && lastUser.status === 'working');
  const start = () => {
    if (agent.data && canCall(agent.data) && !offline) {
      stopMessageSpeech();
      setCallForThisChat(true);
      callAgent(agent.data);
    }
  };
  const rows = useMemo(() => {
    const ordered: Row[] = [];
    let previous = '';
    for (const message of messages) {
      if (
        message.kind === 'ring' &&
        (message.outcome === 'answered' || message.outcome === 'cancelled')
      )
        continue;
      const label = dateLabel(message.created_at, now);
      if (label !== previous) {
        ordered.push({ key: `date-${message.seq}`, kind: 'date', label });
        previous = label;
      }
      ordered.push({ key: message.id, kind: 'message', message });
    }
    for (const pending of chat.pending)
      ordered.push({ key: pending.clientId, kind: 'pending', ...pending });
    if (working) ordered.push({ key: 'working', kind: 'working' });
    return ordered.reverse();
  }, [messages, chat.pending, working, now]);
  const send = () => {
    if (draft.trim() || files.length) {
      if (files.length) chat.sendFiles(draft.trim(), files);
      else chat.send(draft.trim());
      setDraft('');
      unsentFiles.current = [];
      setFiles([]);
    }
  };
  const latestId = lastUser?.id;
  const latestPendingId = chat.pending.at(-1)?.clientId;
  const render = ({ item }: { item: Row }) => {
    if (item.kind === 'date') return <DateSeparator label={item.label} />;
    if (item.kind === 'working')
      return (
        <WorkingRow
          name={name}
          activity={chat.state.progress?.activity}
          text={chat.state.progress?.text}
          onStop={() => {
            if (chat.state.progress?.messageId ?? latestId)
              void chat.stop(chat.state.progress?.messageId ?? latestId!);
          }}
          onLink={setUrl}
        />
      );
    if (item.kind === 'pending')
      return (
        <View>
          <Bubble
            text={
              item.voice
                ? `Voice note · ${callDuration(Math.round(item.voice.durationMs / 1000))} · ${item.state === 'failed' ? 'Failed' : 'Sending…'}`
                : item.text
            }
            time={timeOf(item.createdAt)}
            sender="You"
            own
            agentId={id}
            pendingFiles={item.files}
            onLink={setUrl}
          />
          {(!aiApp || item.clientId === latestPendingId || item.state === 'failed') && (
            <View style={styles.status}>
              <Text
                style={{
                  color: item.state === 'failed' ? palette.danger : palette.textTertiary,
                  fontFamily: font.mono,
                  fontSize: type.microLabel.fontSize,
                }}
              >
                {item.state === 'failed' && item.error
                  ? `Didn't go through: ${apiErrorCopy(item.error).message}`
                  : aiApp
                    ? aiAppReplyStatus(name)
                    : messageStatus(item.state, name)}
              </Text>
              {item.state === 'failed' && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry"
                  style={styles.retry}
                  onPress={() => chat.retry(item.clientId)}
                >
                  <Text style={[styles.retryLabel, { color: palette.accent }]}>Retry</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>
      );
    const message = item.message;
    if (message.kind === 'call' || message.kind === 'ring')
      return (
        <CallCard
          message={message}
          name={name}
          time={timeOf(message.created_at)}
          onCallBack={aiApp ? undefined : start}
          callBackDisabled={offline}
        />
      );
    if (message.kind === 'approval')
      return (
        <ChatApproval
          message={message}
          name={name}
          onDecide={(decision) => chat.decideApproval(message.id, decision)}
        />
      );
    if (message.kind === 'notice' && message.code === 'new_session')
      return <Notice text={`New conversation: ${name} won't remember earlier messages.`} />;
    if (message.kind !== 'agent_text' && message.kind !== 'user_text') return null;
    const own = message.kind === 'user_text';
    return (
      <View>
        <Bubble
          text={message.text}
          voiceDuration={message.kind === 'user_text' ? message.voice?.duration_s : undefined}
          time={timeOf(message.created_at)}
          sender={own ? 'You' : name}
          own={own}
          onLink={setUrl}
          agentId={id}
          attachments={message.attachments}
          caption={
            !own
              ? message.partial
                ? 'Cut off'
                : message.cut
                  ? 'The full reply is longer.'
                  : undefined
              : undefined
          }
        />
        {message.kind === 'agent_text' && !!message.text && (
          <ListenButton
            agentId={id}
            messageId={message.id}
            name={name}
            autoPlay={message.id === autoListenId}
          />
        )}
        {own && message.id === latestId && chat.pending.length === 0 && (
          <Text
            accessibilityLiveRegion="polite"
            style={[
              styles.statusText,
              { color: message.status === 'failed' ? palette.danger : palette.textTertiary },
            ]}
          >
            {aiApp
              ? aiAppReplyStatus(name)
              : messageStatus(message.status, name, message.error_code)}
          </Text>
        )}
        {own && message.status === 'interrupted' && (
          <Notice
            text={`Interrupted: ${name} may have started this. Its answer will appear here if it finishes.`}
            action="Ask again"
            onPress={() => setDraft(message.text)}
          />
        )}
      </View>
    );
  };
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: palette.background }]}>
      <View style={styles.top}>
        <IconButton icon="back" accessibilityLabel="Back" onPress={() => router.back()} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${name} info`}
          onPress={() => router.push({ pathname: '/agents/[id]', params: { id } })}
          style={styles.identity}
        >
          <Avatar
            id={id}
            name={name}
            avatarVersion={agent.data?.avatar_version}
            size={36}
            online={aiApp ? undefined : !offline}
          />
          <View style={styles.titleBlock}>
            <Text numberOfLines={1} style={[styles.name, { color: palette.textPrimary }]}>
              {name}
            </Text>
            <Text
              numberOfLines={2}
              style={[
                styles.subtitle,
                {
                  color: working ? palette.accent : palette.textSecondary,
                  fontStyle: working ? 'italic' : 'normal',
                },
              ]}
            >
              {aiApp
                ? 'AI app'
                : working
                  ? 'Working…'
                  : agent.data?.connector_online === false
                    ? 'Offline · start it on your computer'
                    : agent.data
                      ? agentStatusFor(agent.data).label
                      : ''}
            </Text>
          </View>
        </Pressable>
        {canCall(agent.data) && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Call ${name}`}
            accessibilityState={{ disabled: offline }}
            disabled={offline}
            onPress={start}
            style={[
              styles.call,
              { backgroundColor: offline ? palette.surfaceRaised : palette.accent },
            ]}
          >
            <Icon name="phone" size={20} color={offline ? palette.textMuted : palette.onAccent} />
          </Pressable>
        )}
      </View>
      {removed && <Notice text="This agent was removed." />}
      {agent.error && !removed && (
        <ErrorNotice error={agent.error} onRetry={() => agent.reload()} />
      )}
      {messagePage.error && !removed && (
        <ErrorNotice error={messagePage.error} onRetry={() => messagePage.reload()} />
      )}
      {(agent.loading || messagePage.loading) && (
        <View style={styles.skeleton}>
          <Skeleton height={64} />
          <Skeleton height={88} />
          <Skeleton height={64} />
        </View>
      )}
      {!agent.loading &&
        !messagePage.loading &&
        !removed &&
        !messagePage.error &&
        rows.length === 0 && (
          <View style={styles.empty}>
            <Avatar
              id={id}
              name={name}
              avatarVersion={agent.data?.avatar_version}
              size={72}
              online={aiApp ? undefined : !offline}
            />
            <Text style={[type.title, { color: palette.textPrimary }]}>{name}</Text>
            <Text style={[type.body, { color: palette.textSecondary, textAlign: 'center' }]}>
              {aiApp ? aiAppEmptyChat(name) : `Messages and calls with ${name} appear here.`}
            </Text>
            {showComputerCallHint(agent.data) && <ComputerCallHint name={name} />}
            {!aiApp && <GhostButton label={`Call ${name}`} onPress={start} disabled={offline} />}
          </View>
        )}
      {rows.length > 0 && (
        <FlatList
          inverted
          data={rows}
          renderItem={render}
          keyExtractor={(item) => item.key}
          onEndReached={() => {
            void chat.loadOlder();
          }}
          onEndReachedThreshold={0.25}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
        />
      )}
      {!removed && (
        <KeyboardAvoidingView behavior="padding">
          <Composer
            name={name}
            value={draft}
            onChange={setDraft}
            onSend={send}
            files={files}
            filesAvailable={chat.filesAvailable}
            onAddFiles={(chosen) => setFiles((current) => [...current, ...chosen].slice(0, 5))}
            onRemoveFile={(clientId) =>
              setFiles((current) => {
                const removed = current.find((file) => file.clientId === clientId);
                if (removed) {
                  try {
                    new File(removed.uri).delete();
                  } catch {
                    /* cache may already be gone */
                  }
                }
                return current.filter((file) => file.clientId !== clientId);
              })
            }
            onVoiceSend={(uri, durationMs) => {
              chat.sendVoice(uri, durationMs);
            }}
            disabled={onCall}
          />
        </KeyboardAvoidingView>
      )}
      <LinkSheet url={url} onClose={() => setUrl(undefined)} />
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
  },
  identity: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 },
  titleBlock: { flex: 1 },
  name: { fontFamily: font.title, fontSize: type.headline.fontSize },
  subtitle: { fontFamily: font.caption, fontSize: type.caption.fontSize },
  call: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { paddingHorizontal: 18, paddingVertical: 12 },
  status: { alignSelf: 'flex-end', flexDirection: 'row', alignItems: 'center', gap: 4 },
  statusText: { alignSelf: 'flex-end', fontFamily: font.mono, fontSize: type.microLabel.fontSize },
  retry: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 },
  retryLabel: { fontFamily: font.bodyEmphasis, fontSize: type.caption.fontSize },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
  },
  skeleton: { gap: 12, padding: 22 },
});
