import { isActive, type ThreadMessage } from '@twring/contracts';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import {
  AccessibilityInfo,
  Alert,
  FlatList,
  Share,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { KeyboardAvoidingView, KeyboardGestureArea } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { agentStatusFor, callRefusal } from '@/agents/labels';
import { aiAppEmptyChat, canCall, isAiApp, showComputerCallHint } from '@/agents/ai-app';
import { autoListenTarget } from '@/threads/auto-listen';
import { ApiError, twringApi } from '@/api';
import { callAgent } from '@/call/call-agent';
import { callController, useCallView } from '@/call/session';
import { Avatar } from '@/components/Avatar';
import { ComputerCallHint } from '@/components/ComputerCallHint';
import { SealedAttachments } from '@/components/chat/SealedAttachments';
import { Bubble } from '@/components/chat/Bubble';
import { ChatApproval, ChatSealedApproval } from '@/components/chat/ChatApproval';
import { CallCard } from '@/components/chat/CallCard';
import { Composer } from '@/components/chat/Composer';
import { DateSeparator } from '@/components/chat/DateSeparator';
import { NewReplyPill, UnreadDivider } from '@/components/chat/NewReplyPill';
import { LinkSheet } from '@/components/chat/LinkSheet';
import { MessageActionSheet, ReplyBar } from '@/components/chat/MessageActions';
import { ListenButton, stopMessageSpeech } from '@/components/chat/ListenButton';
import { Notice } from '@/components/chat/Notice';
import { StatusLine } from '@/components/chat/StatusLine';
import { latestOwn, statusLineContent } from '@/components/chat/status-line';
import { StreamingReply } from '@/components/chat/WorkingRow';
import { CallButton } from '@/components/CallButton';
import { OnCallChip } from '@/components/OnCallChip';
import { useOnCall } from '@/call/on-call';
import { ErrorNotice } from '@/components/ErrorNotice';
import { noticeAction } from '@/e2e/devices';
import {
  interruptedNotice,
  labelFor,
  MISSING_MESSAGE,
  sealedBubble,
  SERVER_READABLE_MARK,
} from '@/e2e/private-state';
import { PrivateBanner, VoiceNoteWarning } from '@/components/chat/PrivateChat';
import { GhostButton } from '@/components/GhostButton';
import { IconButton } from '@/components/IconButton';
import { Skeleton } from '@/components/Skeleton';
import { useNow } from '@/hooks/useNow';
import { useVoiceConsent } from '@/hooks/useVoiceConsent';
import { ringPlatform } from '@/platform/ring';
import { STATUS_POLL_MS, useResource } from '@/hooks/useResource';
import { font } from '@/theme/fonts';
import { type, usePalette } from '@/theme/tokens';
import { chatController, useChat, useDraft } from '@/threads/chats';
import { canRetry } from '@/threads/outbox';
import {
  firstUnreadSeq,
  initialPill,
  nextPill,
  pillLabel,
  replyIds,
  shouldAnnounce,
  type PillState,
} from '@/threads/scroll-state';
import { callDuration, dateLabel, failedSendText } from '@/threads/presentation';
import type { PreparedFile } from '@/threads/files';
import { File } from 'expo-file-system';
import { apiErrorCopy } from '@/api/errors';
import {
  ACTION_LABELS,
  DELETE_CONFIRM,
  DISCARD_CONFIRM,
  deleteFailureCopy,
  messageActions,
  type MessageAction,
} from '@/threads/message-actions';

/** The message a long press or screen-reader action is about. */
interface ActionTarget {
  /** The server id; absent for a message still only on this phone. */
  id?: string;
  /** A message still only on this phone: its outbox id. */
  clientId?: string;
  text: string;
  /** "yourself" or the agent's name, for the reply bar. */
  from: string;
  actions: MessageAction[];
}

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
      voice?: { uri: string; durationMs: number; serverReadable?: true };
      files?: PreparedFile[];
      error?: unknown;
      errorCode?: string;
    }
  | { key: string; kind: 'working' }
  | { key: string; kind: 'unread' };
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
  const liveCall = useOnCall();
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
  const [draft, setDraft] = useDraft(id);
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
  const [actionTarget, setActionTarget] = useState<ActionTarget>();
  const [replyTo, setReplyTo] = useState<{ id: string; from: string; text: string }>();
  const [copiedKey, setCopiedKey] = useState<string>();
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const [removed, setRemoved] = useState(false);
  /** A recorded voice note waiting for "Send anyway" in a private chat. */
  const [heldVoice, setHeldVoice] = useState<{ uri: string; durationMs: number }>();
  const heldUri = useRef<string>(undefined);
  const voiceConsent = useVoiceConsent(id, !!chat.private);
  const discardHeld = () => {
    if (heldUri.current === undefined) return;
    try {
      new File(heldUri.current).delete();
    } catch {
      /* cache may already be gone */
    }
    heldUri.current = undefined;
  };
  // Leaving the chat with a note still held deletes the recording, as "Don't send" does.
  useEffect(() => () => discardHeld(), []);
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
  // Private chats (ADR-044): opened on this phone only, and the label only while it is true.
  const openedById = useMemo(
    () => (chat.opened ? new Map(chat.opened.map((entry) => [entry.id, entry])) : undefined),
    [chat.opened],
  );
  const privateLabel = labelFor({
    private: chat.private,
    messages,
    readableMessages: chat.readableMessages,
  });
  // The read marker as the chat opened: later reads move it, but the divider stays put.
  const [openedReadSeq] = useState(
    () =>
      chatController()
        ?.getSummaries()
        .find((thread) => thread.agent_id === id)?.read_seq,
  );
  // Fixed once the first page is in: new replies never move the divider.
  const [unreadSeq, setUnreadSeq] = useState<number>();
  const unreadFixed = useRef(false);
  useEffect(() => {
    if (unreadFixed.current || messagePage.loading) return;
    unreadFixed.current = true;
    setUnreadSeq(firstUnreadSeq(messages, openedReadSeq));
  }, [messagePage.loading, messages, openedReadSeq]);
  const name = agent.data?.name ?? 'Agent';
  const aiApp = isAiApp(agent.data);
  const autoListenId = autoListenTarget(messages, listen === '1' && !messagePage.loading);
  useEffect(() => {
    if (autoListenId) router.setParams({ listen: undefined });
  }, [autoListenId]);
  const offline = agent.data ? callRefusal(agent.data) !== undefined : true;
  const lastUser = latestOwn(messages);
  const working = !!chat.state.progress || lastUser?.working === true;
  const start = () => {
    if (agent.data && canCall(agent.data) && !offline) {
      stopMessageSpeech();
      setCallForThisChat(true);
      callAgent(agent.data);
    }
  };
  const streaming = working && !!chat.state.progress?.text;
  const rows = useMemo(() => {
    const ordered: Row[] = [];
    let previous = '';
    // A failed send stays where it was sent, among the messages; one still sending stays last
    // (the phone's clock may run behind the server's).
    const failed = chat.pending
      .filter((pending) => pending.state === 'failed')
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const placed = new Set<string>();
    const placeFailedBefore = (createdAt: string) => {
      for (const pending of failed) {
        if (
          placed.has(pending.clientId) ||
          !(Date.parse(pending.createdAt) < Date.parse(createdAt))
        )
          continue;
        const label = dateLabel(pending.createdAt, now);
        if (label !== previous) {
          ordered.push({ key: `date-${pending.clientId}`, kind: 'date', label });
          previous = label;
        }
        ordered.push({ key: pending.clientId, kind: 'pending', ...pending });
        placed.add(pending.clientId);
      }
    };
    for (const message of messages) {
      if (
        message.kind === 'ring' &&
        (message.outcome === 'answered' || message.outcome === 'cancelled')
      )
        continue;
      placeFailedBefore(message.created_at);
      const label = dateLabel(message.created_at, now);
      if (label !== previous) {
        ordered.push({ key: `date-${message.seq}`, kind: 'date', label });
        previous = label;
      }
      if (message.seq === unreadSeq) ordered.push({ key: 'unread', kind: 'unread' });
      ordered.push({ key: message.id, kind: 'message', message });
    }
    for (const pending of chat.pending)
      if (!placed.has(pending.clientId))
        ordered.push({ key: pending.clientId, kind: 'pending', ...pending });
    if (streaming) ordered.push({ key: 'working', kind: 'working' });
    return ordered.reverse();
  }, [messages, chat.pending, streaming, now, unreadSeq]);
  const list = useRef<FlatList<Row>>(null);
  // Open at the first unread message, once, when there is one.
  const jumped = useRef(false);
  const unreadIndex = rows.findIndex((row) => row.kind === 'unread');
  useEffect(() => {
    if (jumped.current || unreadIndex < 0) return;
    // Marked done only when it runs: rows shifting before then reschedule it with the new index.
    const timer = setTimeout(() => {
      jumped.current = true;
      list.current?.scrollToIndex({ index: unreadIndex, viewPosition: 1, animated: false });
    }, 0);
    return () => clearTimeout(timer);
  }, [unreadIndex]);
  // The "New reply" pill: scroll position and replies feed one pure state (threads/scroll-state).
  const [pill, setPill] = useState<PillState>(initialPill);
  const scroll = useRef({ distanceFromBottom: 0, viewportHeight: 0 });
  const ids = useMemo(() => replyIds(messages), [messages]);
  const idsRef = useRef(ids);
  useEffect(() => {
    idsRef.current = ids;
  }, [ids]);
  const updatePill = useCallback(() => {
    setPill((previous) => nextPill(previous, { ids: idsRef.current, ...scroll.current }));
  }, []);
  useEffect(updatePill, [ids, updatePill]);
  // Screen readers hear the pill once per burst of replies, not per streamed word.
  const pillRef = useRef(pill);
  useEffect(() => {
    if (shouldAnnounce(pillRef.current, pill))
      AccessibilityInfo.announceForAccessibilityWithOptions(pillLabel(pill.count), {
        queue: true,
      });
    pillRef.current = pill;
  }, [pill]);
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Inverted: offset 0 is the newest message.
      scroll.current = {
        distanceFromBottom: event.nativeEvent.contentOffset.y,
        viewportHeight: event.nativeEvent.layoutMeasurement.height,
      };
      updatePill();
    },
    [updatePill],
  );
  const toBottom = () => list.current?.scrollToOffset({ offset: 0, animated: true });
  const send = () => {
    if (draft.trim() || files.length) {
      if (files.length) chat.sendFiles(draft.trim(), files, replyTo?.id);
      else chat.send(draft.trim(), replyTo?.id);
      setReplyTo(undefined);
      setDraft('');
      toBottom();
      unsentFiles.current = [];
      setFiles([]);
    }
  };
  const latestId = lastUser?.id;
  const latestPending = chat.pending.at(-1);
  const latestPendingId = latestPending?.clientId;
  const statusContent = statusLineContent({
    name,
    aiApp,
    working,
    activity: chat.state.progress?.activity,
    pending: latestPending,
    latest: lastUser,
  });
  const stop = () => {
    const target = chat.state.progress?.messageId ?? latestId;
    if (target) void chat.stop(target);
  };
  const confirmDiscard = (clientId: string) =>
    Alert.alert('Delete message?', DISCARD_CONFIRM, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => chat.discard(clientId) },
    ]);
  const openActions = (target: ActionTarget) => {
    if (!target.actions.length) return;
    void Haptics.selectionAsync().catch(() => undefined);
    setActionTarget(target);
  };
  const runAction = (target: ActionTarget, action: MessageAction, key: string) => {
    setActionTarget(undefined);
    switch (action) {
      case 'reply':
        if (target.id) setReplyTo({ id: target.id, from: target.from, text: target.text });
        return;
      case 'copy':
        void Clipboard.setStringAsync(target.text);
        setCopiedKey(key);
        clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopiedKey(undefined), 2000);
        return;
      case 'share':
        void Share.share({ message: target.text }).catch(() => undefined);
        return;
      case 'delete': {
        const clientId = target.clientId;
        if (clientId) {
          confirmDiscard(clientId);
          return;
        }
        const messageId = target.id;
        if (!messageId) return;
        Alert.alert('Delete message?', DELETE_CONFIRM, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              if (replyTo?.id === messageId) setReplyTo(undefined);
              chat.deleteMessage(messageId).catch((error: unknown) => {
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
                  () => undefined,
                );
                Alert.alert("Couldn't delete", deleteFailureCopy(error));
              });
            },
          },
        ]);
        return;
      }
    }
  };
  const actionProps = (target: ActionTarget, key: string) => ({
    actions: target.actions.map((action) => ({ name: action, label: ACTION_LABELS[action] })),
    onAction: (name: string) => {
      const action = target.actions.find((entry) => entry === name);
      if (action) runAction(target, action, key);
    },
    onLongPress: () => {
      actionKey.current = key;
      openActions(target);
    },
    copied: copiedKey === key,
  });
  const actionKey = useRef('');
  const render = ({ item }: { item: Row }) => {
    if (item.kind === 'date') return <DateSeparator label={item.label} />;
    if (item.kind === 'unread') return <UnreadDivider />;
    if (item.kind === 'working')
      return <StreamingReply name={name} text={chat.state.progress?.text} onLink={setUrl} />;
    if (item.kind === 'pending') {
      const pendingTarget: ActionTarget = {
        clientId: item.clientId,
        text: item.voice ? '' : item.text,
        from: 'yourself',
        actions: messageActions({
          kind: 'pending',
          text: item.voice ? '' : item.text,
          failed: item.state === 'failed',
        }),
      };
      return (
        <View>
          <Bubble
            {...actionProps(pendingTarget, item.clientId)}
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
          {item.state === 'failed' && item.clientId !== latestPendingId && (
            <View style={styles.status}>
              <Text
                style={{
                  color: palette.danger,
                  fontFamily: font.mono,
                  fontSize: type.microLabel.fontSize,
                }}
              >
                {failedSendText(
                  name,
                  item.errorCode,
                  item.error ? apiErrorCopy(item.error).message : undefined,
                )}
              </Text>
              {!canRetry(item) ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Delete"
                  style={styles.retry}
                  onPress={() => confirmDiscard(item.clientId)}
                >
                  <Text style={[styles.retryLabel, { color: palette.accent }]}>Delete</Text>
                </Pressable>
              ) : (
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
    }
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
    if (message.kind === 'sealed') {
      const card = openedById?.get(message.id);
      if (card?.state === 'approval')
        return (
          <ChatSealedApproval
            title={card.title}
            description={card.description}
            expiresAt={card.expiresAt}
            answered={message.approval?.state === 'answered'}
            updatedAt={message.updated_at}
            name={name}
            onDecide={(decision) =>
              chat.decideSealedApproval(message.id, card.approvalId, decision)
            }
          />
        );
      // Messages from the computer that never reached this phone: one quiet row per gap.
      const gap = openedById?.get(`${message.id}:gap`)?.state === 'missing_before';
      const gapRow = gap ? (
        <View accessible accessibilityLabel={MISSING_MESSAGE}>
          <Notice text={MISSING_MESSAGE} />
        </View>
      ) : null;
      const bubble = sealedBubble(message, openedById, name);
      if (bubble === undefined) return gapRow;
      const sealedTarget: ActionTarget = {
        id: message.id,
        text: bubble.opened ? bubble.text : '',
        from: bubble.own ? 'yourself' : name,
        actions: bubble.actions,
      };
      const bubbleView = (
        <Bubble
          {...actionProps(sealedTarget, message.id)}
          quote={bubble.quote}
          text={bubble.text}
          muted={!bubble.opened}
          time={timeOf(message.created_at)}
          sender={bubble.own ? 'You' : name}
          own={bubble.own}
          onLink={setUrl}
        >
          {bubble.files && (
            <SealedAttachments
              files={bubble.files}
              open={(file) =>
                chatController()?.openSealedFile(id, file) ??
                Promise.resolve({ error: 'couldnt_open' as const })
              }
            />
          )}
        </Bubble>
      );
      const interrupted = interruptedNotice(message, bubble, name);
      if (!gap && !interrupted) return bubbleView;
      return (
        <View>
          {gapRow}
          {bubbleView}
          {interrupted && (
            <Notice
              text={interrupted.text}
              {...(interrupted.draft && {
                action: 'Ask again',
                onPress: () => setDraft(interrupted.draft),
              })}
            />
          )}
        </View>
      );
    }
    if (message.kind !== 'agent_text' && message.kind !== 'user_text') return null;
    const own = message.kind === 'user_text';
    const target: ActionTarget = {
      id: message.id,
      text: message.text,
      from: own ? 'yourself' : name,
      actions: messageActions({ kind: 'message', message }),
    };
    const quote = message.kind === 'user_text' ? message.quote : undefined;
    return (
      <View>
        <Bubble
          {...actionProps(target, message.id)}
          quote={quote && { from: quote.from === 'owner' ? 'You' : name, text: quote.text }}
          text={message.text}
          voiceDuration={message.kind === 'user_text' ? message.voice?.duration_s : undefined}
          time={timeOf(message.created_at)}
          sender={own ? 'You' : name}
          own={own}
          onLink={setUrl}
          agentId={id}
          attachments={message.attachments}
          caption={
            !own && message.partial
              ? 'Cut off'
              : !own && message.cut
                ? 'The full reply is longer.'
                : // In a private chat, a message the server could read is marked (Task 24).
                  chat.private
                  ? SERVER_READABLE_MARK
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
              numberOfLines={1}
              ellipsizeMode="tail"
              style={[styles.subtitle, { color: palette.textSecondary }]}
            >
              {/* Working shows once, in the status line above the message box. */}
              {aiApp
                ? 'AI app'
                : agent.data?.connector_online === false
                  ? 'Offline · check your computer is on'
                  : agent.data
                    ? agentStatusFor(agent.data).label
                    : ''}
            </Text>
          </View>
        </Pressable>
        {liveCall.active ? (
          <OnCallChip startedAt={liveCall.connectedAt} />
        ) : (
          canCall(agent.data) && (
            <CallButton name={name} variant="fill" disabled={offline} onPress={start} />
          )
        )}
      </View>
      {privateLabel && <PrivateBanner label={privateLabel.text} />}
      <KeyboardAvoidingView behavior="padding" style={styles.body}>
        <View style={styles.body}>
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
                {!aiApp && (
                  <GhostButton label={`Call ${name}`} onPress={start} disabled={offline} />
                )}
              </View>
            )}
          {rows.length > 0 && (
            <KeyboardGestureArea interpolator="ios" style={styles.body}>
              <FlatList
                ref={list}
                inverted
                // Scrolled up, a streaming or new reply must not move what the reader sees; at the
                // bottom, new rows keep the list pinned to the newest message.
                maintainVisibleContentPosition={{
                  minIndexForVisible: 0,
                  autoscrollToTopThreshold: 48,
                }}
                onScroll={onScroll}
                scrollEventThrottle={100}
                onScrollToIndexFailed={(info) => {
                  list.current?.scrollToOffset({
                    offset: info.averageItemLength * info.index,
                    animated: false,
                  });
                }}
                keyboardDismissMode="interactive"
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
            </KeyboardGestureArea>
          )}
          {pill.show && rows.length > 0 && <NewReplyPill count={pill.count} onPress={toBottom} />}
          {(removed || agent.error || messagePage.error || chat.privateNotice !== undefined) && (
            // Opaque, so a notice laid over the messages stays readable.
            <View
              pointerEvents="box-none"
              style={[styles.notices, { backgroundColor: palette.background }]}
            >
              {removed && <Notice text="This agent was removed." />}
              {chat.privateNotice !== undefined && !removed && (
                <ErrorNotice
                  error={{ message: chat.privateNotice, retryable: true }}
                  actionLabel={noticeAction(chat.privateNotice)}
                  onRetry={() =>
                    router.push({ pathname: '/private/pair', params: { agentId: id } })
                  }
                />
              )}
              {agent.error && !removed && (
                <ErrorNotice error={agent.error} onRetry={() => agent.reload()} />
              )}
              {messagePage.error && !removed && (
                <ErrorNotice error={messagePage.error} onRetry={() => messagePage.reload()} />
              )}
            </View>
          )}
        </View>
        {!removed && (
          <View>
            {heldVoice && (
              <VoiceNoteWarning
                onSend={() => {
                  // The person's consent: the server may read this voice note, and this chat's
                  // later ones.
                  voiceConsent.give();
                  chat.sendVoice(heldVoice.uri, heldVoice.durationMs, replyTo?.id, {
                    serverReadable: true,
                  });
                  heldUri.current = undefined;
                  setReplyTo(undefined);
                  setHeldVoice(undefined);
                }}
                onCancel={() => {
                  discardHeld();
                  setHeldVoice(undefined);
                }}
              />
            )}
            {replyTo && (
              <ReplyBar
                from={replyTo.from}
                text={replyTo.text}
                onCancel={() => setReplyTo(undefined)}
              />
            )}
            <StatusLine
              name={name}
              content={statusContent}
              onStop={stop}
              onRetry={(clientId) => chat.retry(clientId)}
              onDelete={confirmDiscard}
            />
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
              askBeforeVoice={!!chat.private && voiceConsent.given !== true}
              onVoiceConsent={voiceConsent.give}
              onVoiceSend={(uri, durationMs) => {
                // A voice note is turned into text on the server: in a private chat it goes once
                // the person said yes for this chat, before recording or after it.
                if (chat.private && voiceConsent.latest.current === true) {
                  chat.sendVoice(uri, durationMs, replyTo?.id, { serverReadable: true });
                  setReplyTo(undefined);
                  return;
                }
                if (chat.private) {
                  discardHeld();
                  heldUri.current = uri;
                  setHeldVoice({ uri, durationMs });
                  return;
                }
                chat.sendVoice(uri, durationMs, replyTo?.id);
                setReplyTo(undefined);
              }}
              disabled={onCall}
            />
          </View>
        )}
      </KeyboardAvoidingView>
      <LinkSheet url={url} onClose={() => setUrl(undefined)} />
      <MessageActionSheet
        target={actionTarget}
        onClose={() => setActionTarget(undefined)}
        onChoose={(action) => {
          if (actionTarget) runAction(actionTarget, action, actionKey.current);
        }}
      />
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
  body: { flex: 1 },
  notices: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 18,
    paddingBottom: 8,
    gap: 8,
  },
  list: { paddingHorizontal: 18, paddingVertical: 12 },
  status: { alignSelf: 'flex-end', flexDirection: 'row', alignItems: 'center', gap: 4 },
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
