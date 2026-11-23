import type { Agent, CallState } from '@twring/contracts';
import { router } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';

import { apiErrorCopy } from '@/api/errors';
import { askToRing, canAskToRing, ringRequestState } from '@/call/ring-me';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { TextButton } from '@/components/TextButton';
import { playCallFeedback } from '@/platform/haptics';
import { chatController } from '@/threads/chats';
import { callPalette as palette, space, type } from '@/theme/tokens';

const noopSubscribe = () => () => undefined;
const zero = () => 0;

/** After a call, one tap asks the agent (in its chat) to ring this phone when its task is done. */
export function RingMeWhenDone({
  call,
  connectedAt,
  agent,
}: {
  call: CallState;
  connectedAt: number | undefined;
  agent: Pick<Agent, 'id' | 'name' | 'protocol' | 'connector_removed'> | undefined;
}) {
  // Reads a mutable controller after subscribing: the React Compiler must not cache those reads.
  'use no memo';
  const chats = chatController();
  const reducedMotion = useReducedMotion();
  const [clientId, setClientId] = useState<string | undefined>(undefined);
  const sentRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    void chats?.refreshList();
  }, [chats]);
  useSyncExternalStore(chats?.subscribe ?? noopSubscribe, chats?.getRevision ?? zero);

  const visible = canAskToRing({
    call,
    connectedAt,
    agent,
    chatsAvailable: chats?.getAvailability() === true,
  });
  if (!visible && clientId === undefined) return null;
  if (agent === undefined || chats === undefined) return null;

  const request = ringRequestState(clientId, chats.getPending(agent.id));
  const ask = () => {
    const before = sentRef.current;
    const sent = askToRing(sentRef, (text) => chats.send(agent.id, text));
    if (sent !== before) {
      setClientId(sent);
      playCallFeedback('connected');
    }
  };

  switch (request.kind) {
    case 'idle':
      return (
        <View style={styles.box}>
          <GhostButton
            label="Ring me when it's done"
            accessibilityHint={`Sends ${agent.name} a message asking it to ring you when it finishes`}
            onPress={ask}
          />
        </View>
      );
    case 'failed':
      return (
        <View style={styles.box}>
          <ErrorNotice
            error={apiErrorCopy(request.error)}
            onRetry={() => {
              if (clientId !== undefined) chats.retry(clientId);
            }}
          />
        </View>
      );
    case 'asked':
      return (
        <Animated.View
          entering={reducedMotion ? undefined : FadeIn.duration(200)}
          accessibilityLiveRegion="polite"
          style={[styles.box, styles.asked]}
        >
          <Text style={[type.body, styles.askedText]}>
            {`Asked ${agent.name} to ring you when it's done.`}
          </Text>
          <TextButton
            label="Open chat"
            accessibilityHint={`Opens your chat with ${agent.name}`}
            onPress={() =>
              router.push({ pathname: '/chats/[agentId]', params: { agentId: agent.id } })
            }
          />
        </Animated.View>
      );
  }
}

const styles = StyleSheet.create({
  box: { marginTop: space.lg },
  asked: { alignItems: 'center', gap: space.xs },
  askedText: { color: palette.textSecondary, textAlign: 'center' },
});
