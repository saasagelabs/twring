import type { LinkApproveResponse, PairingResponse } from '@twring/contracts';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Share, StyleSheet, Text, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import {
  AGENT_MESSAGE_COPY,
  agentSetupMessage,
  alreadyAddedFor,
  linkedFromConnector,
} from '@/agents/agent-message';
import { onPhoneClock, pairingTimedOut, timeLeft, waitForClaim } from '@/agents/computer';
import { apiErrorCopy, twringApi, type ErrorCopy } from '@/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { LinkComputer } from '@/components/LinkComputer';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { Skeleton } from '@/components/Skeleton';
import { TextButton } from '@/components/TextButton';
import { activeServerUrl, downloadsServerUrl } from '@/servers/active';
import { space, type, usePalette } from '@/theme/tokens';
import { font } from '@/theme/fonts';

type Phase =
  | { kind: 'loading' }
  | { kind: 'waiting'; pairing: PairingResponse }
  | { kind: 'expired' }
  | { kind: 'error'; copy: ErrorCopy };

/**
 * Copies with expo-clipboard; a build without that module offers the share sheet instead. Never
 * rejects: the share sheet failing too leaves the message on screen, selectable.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    await Share.share({ message: text }).catch(() => undefined);
    return false;
  }
}

/** The app's own server address cannot make a working command (a build misconfiguration). */
const NO_MESSAGE: ErrorCopy = {
  message: "This app can't make the message for your agent. Use one of the other ways below.",
  retryable: false,
};

/**
 * "On my computer or server", first option (ADR-027): a message the owner forwards to their agent.
 * The agent downloads cord-connect and links itself with the code in it; the phone waits for the
 * claim, then shows the usual agent picker.
 */
export function AgentMessage({
  onScan,
  onOtherWays,
}: {
  onScan: () => void;
  onOtherWays: () => void;
}) {
  const palette = usePalette();
  const reduceMotion = useReducedMotion();
  const api = twringApi();
  const server = activeServerUrl();
  const [current, setPhase] = useState<Phase>({ kind: 'loading' });
  const [linked, setLinked] = useState<
    { linked: LinkApproveResponse; alreadyAdded: string[] } | undefined
  >(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  // A fresh code whenever one is needed.
  useEffect(() => {
    if (api === undefined || current.kind !== 'loading') return;
    const controller = new AbortController();
    api.createPairing(controller.signal).then(
      (pairing) => setPhase({ kind: 'waiting', pairing: onPhoneClock(pairing, Date.now()) }),
      (reason: unknown) => {
        if (!controller.signal.aborted) setPhase({ kind: 'error', copy: apiErrorCopy(reason) });
      },
    );
    return () => controller.abort();
  }, [api, current.kind]);

  // Wait for the agent to claim the code.
  const waiting = current.kind === 'waiting' ? current.pairing : undefined;
  useEffect(() => {
    if (api === undefined || waiting === undefined) return;
    const controller = new AbortController();
    waitForClaim(api, waiting.pairing_id, controller.signal).then(
      async (status) => {
        if (controller.signal.aborted) return;
        const connector = status.connector;
        if (status.status === 'claimed' && connector !== undefined) {
          // A computer linked before (ADR-027 re-link) may already have agents on this phone.
          const saved = await api.listAgents(controller.signal).then(
            (agents) => alreadyAddedFor(agents, connector.id),
            () => [],
          );
          if (controller.signal.aborted) return;
          setLinked({ linked: linkedFromConnector(connector), alreadyAdded: saved });
        } else {
          setPhase({ kind: 'expired' });
        }
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [api, waiting]);

  // The countdown.
  useEffect(() => {
    if (waiting === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  const left = waiting === undefined ? undefined : timeLeft(waiting.expires_at, now);
  // The poll decides (a claim right at expiry still wins); the phone gives up on its own only
  // when the server stays silent past the grace.
  const timedOut = waiting !== undefined && pairingTimedOut(waiting.expires_at, now);
  // Never a broken command: with no usable one, say so and offer the other ways.
  const made =
    waiting === undefined
      ? undefined
      : agentSetupMessage(waiting.code, server, downloadsServerUrl());
  const phase: Phase = timedOut
    ? { kind: 'expired' }
    : waiting !== undefined && made === undefined
      ? { kind: 'error', copy: NO_MESSAGE }
      : current;

  if (linked !== undefined) {
    return (
      <LinkComputer
        linked={linked.linked}
        alreadyAdded={linked.alreadyAdded}
        onOtherWays={onOtherWays}
      />
    );
  }

  const message = made ?? '';
  const secondary = (
    <View style={styles.centered}>
      <TextButton label={AGENT_MESSAGE_COPY.scan} onPress={onScan} />
      <TextButton label={AGENT_MESSAGE_COPY.otherWays} onPress={onOtherWays} />
    </View>
  );

  function footer() {
    switch (phase.kind) {
      case 'waiting':
        return (
          <>
            <PrimaryButton
              label={AGENT_MESSAGE_COPY.share}
              onPress={() => void Share.share({ message }).catch(() => undefined)}
            />
            <GhostButton
              label={copied ? AGENT_MESSAGE_COPY.copied : AGENT_MESSAGE_COPY.copy}
              onPress={() => void copyText(message).then(setCopied)}
            />
            {secondary}
          </>
        );
      case 'expired':
        return (
          <>
            <PrimaryButton
              label={AGENT_MESSAGE_COPY.newMessage}
              onPress={() => setPhase({ kind: 'loading' })}
            />
            {secondary}
          </>
        );
      case 'loading':
      case 'error':
        return secondary;
    }
  }

  return (
    <Screen back footer={footer()}>
      <View style={styles.step}>
        <Text accessibilityRole="header" style={[styles.heading, { color: palette.textPrimary }]}>
          {AGENT_MESSAGE_COPY.title}
        </Text>
        <Text style={[styles.support, { color: palette.textSecondary }]}>
          {AGENT_MESSAGE_COPY.body}
        </Text>
        {phase.kind === 'loading' && (
          <View accessible accessibilityLabel="Getting a message">
            <Skeleton height={140} />
          </View>
        )}
        {phase.kind === 'error' && (
          <ErrorNotice error={phase.copy} onRetry={() => setPhase({ kind: 'loading' })} />
        )}
        {phase.kind === 'expired' && (
          <Text accessibilityRole="alert" style={[type.body, { color: palette.textPrimary }]}>
            {AGENT_MESSAGE_COPY.expired}
          </Text>
        )}
        {phase.kind === 'waiting' && (
          <>
            <Text
              selectable
              style={[
                styles.message,
                {
                  color: palette.textSecondary,
                  borderColor: palette.border,
                  backgroundColor: palette.surface,
                },
              ]}
            >
              {message}
            </Text>
            <View accessibilityLiveRegion="polite" style={styles.waiting}>
              {!reduceMotion && <ActivityIndicator color={palette.textSecondary} />}
              <Text style={[type.body, { color: palette.textSecondary }]}>
                {`${AGENT_MESSAGE_COPY.waiting} ${left ?? '0:00'} left.`}
              </Text>
            </View>
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  step: { gap: space.lg },
  centered: { alignItems: 'center' },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  message: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 14,
    fontFamily: font.monoRegular,
    fontSize: 12.5,
    lineHeight: 20,
  },
  heading: { fontFamily: font.display, fontSize: 30, letterSpacing: -0.8 },
  support: { fontFamily: font.body, fontSize: 15, lineHeight: 22.5 },
});
