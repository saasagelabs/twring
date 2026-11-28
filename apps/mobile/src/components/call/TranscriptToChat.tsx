import type { Agent, CallState } from '@twring/contracts';
import { router } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';

import { twringApi } from '@/api';
import { apiErrorCopy } from '@/api/errors';
import {
  canOfferTranscript,
  createTranscriptToChat,
  transcriptSwitchOn,
  type TranscriptState,
  type TranscriptToChatModel,
} from '@/call/transcript-to-chat';
import { ErrorNotice } from '@/components/ErrorNotice';
import { TextButton } from '@/components/TextButton';
import { Toggle } from '@/components/Toggle';
import { playCallFeedback } from '@/platform/haptics';
import { chatController } from '@/threads/chats';
import { callPalette as palette, space, type } from '@/theme/tokens';

const noopSubscribe = () => () => undefined;
const zero = () => 0;
const LABEL = 'Transcripts in chat';

/** What the row says under its label, and whether it offers "Open chat". */
function subtitle(state: TranscriptState, agentName: string): { text: string; open: boolean } {
  switch (state.kind) {
    case 'on_at_end':
      return { text: 'Transcript is in your chat.', open: true };
    case 'sent':
      return { text: 'Transcript sent to your chat.', open: true };
    case 'gone':
      return {
        text: "This call's words are no longer kept. Your next calls will have one.",
        open: false,
      };
    case 'sending':
      return { text: 'Sending the transcript to your chat.', open: false };
    case 'loading':
    case 'off':
    case 'saving':
    case 'save_failed':
    case 'send_failed':
    case 'private':
      return { text: `Send this call and later calls to your chat with ${agentName}`, open: false };
  }
}

/**
 * After a call, a switch that puts this call's transcript (and every later call's) in the agent's
 * chat. Hidden for a private chat: transcripts never go there.
 */
export function TranscriptToChat({
  call,
  connectedAt,
  agent,
}: {
  call: CallState;
  connectedAt: number | undefined;
  agent: Pick<Agent, 'id' | 'name'> | undefined;
}) {
  // Reads a mutable controller after subscribing: the React Compiler must not cache those reads.
  'use no memo';
  const chats = chatController();
  const reducedMotion = useReducedMotion();
  const callId = 'callId' in call ? call.callId : undefined;
  const [, setRevision] = useState(0);
  // The screen is keyed by call, so one model per call; undefined without a call or a server.
  const [model] = useState<TranscriptToChatModel | undefined>(() => {
    const api = twringApi();
    if (callId === undefined || api === undefined) return undefined;
    return createTranscriptToChat(
      {
        callId,
        ringSettings: () => api.ringSettings(),
        updateRingSettings: (settings) => api.updateRingSettings(settings),
        sendCallTranscript: (id) => api.sendCallTranscript(id),
      },
      () => setRevision((revision) => revision + 1),
    );
  });
  const loadedRef = useRef(false);
  useSyncExternalStore(chats?.subscribe ?? noopSubscribe, chats?.getRevision ?? zero);

  const visible = canOfferTranscript({
    call,
    connectedAt,
    agentKnown: agent !== undefined,
    chatsAvailable: chats?.getAvailability() === true,
    privateChat: agent !== undefined && chats?.isPrivate(agent.id) === true,
  });

  useEffect(() => {
    if (!visible || model === undefined || loadedRef.current) return;
    loadedRef.current = true;
    void model.load();
  }, [visible, model]);

  if (!visible || agent === undefined || model === undefined) return null;
  const state = model.getState();
  if (state.kind === 'loading' || state.kind === 'private') return null;

  const on = transcriptSwitchOn(state);
  const busy = state.kind === 'saving' || state.kind === 'sending';
  const change = (next: boolean) => {
    if (busy) return;
    if (next) playCallFeedback('connected');
    void model.setOn(next);
  };
  const { text, open } = subtitle(state, agent.name);
  const hint = on
    ? 'Turns off transcripts. Later calls will not be sent to the chat'
    : `Sends this call and later calls to your chat with ${agent.name}`;

  return (
    <Animated.View entering={reducedMotion ? undefined : FadeIn.duration(200)} style={styles.box}>
      <View
        accessible
        accessibilityRole="switch"
        accessibilityLabel={LABEL}
        accessibilityHint={hint}
        accessibilityState={{ checked: on, disabled: busy }}
        accessibilityActions={[{ name: 'activate' }]}
        onAccessibilityAction={() => change(!on)}
        style={styles.row}
      >
        <View style={styles.words}>
          <Text style={[type.body, styles.label]}>{LABEL}</Text>
          <Text accessibilityLiveRegion="polite" style={[type.caption, styles.subtitle]}>
            {text}
          </Text>
        </View>
        <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <Toggle accessibilityLabel={LABEL} value={on} disabled={busy} onValueChange={change} />
        </View>
      </View>
      {open && (
        <TextButton
          label="Open chat"
          accessibilityHint={`Opens your chat with ${agent.name}`}
          onPress={() =>
            router.push({ pathname: '/chats/[agentId]', params: { agentId: agent.id } })
          }
        />
      )}
      {(state.kind === 'save_failed' || state.kind === 'send_failed') && (
        <ErrorNotice error={apiErrorCopy(state.error)} onRetry={() => void model.retry()} />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: { width: '100%', gap: space.xs, alignItems: 'center' },
  row: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    paddingVertical: space.sm,
  },
  words: { flex: 1, gap: space.xs },
  label: { color: palette.textPrimary },
  subtitle: { color: palette.textSecondary },
});
