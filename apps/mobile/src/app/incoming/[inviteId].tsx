import * as Haptics from 'expo-haptics';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { twringApi } from '@/api';
import { startCall } from '@/call/start';
import { Avatar } from '@/components/Avatar';
import { GhostButton } from '@/components/GhostButton';
import { Icon } from '@/components/Icon';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Sheet } from '@/components/Sheet';
import { Waveform } from '@/components/Waveform';
import { microphonePermission } from '@/platform/microphone';
import { ringPlatform } from '@/platform/ring';
import { charactersLeft, checkNote, QUICK_REPLIES } from '@/ring/decline-note';
import { sendDecline } from '@/ring/declines';
import {
  endedCopy,
  expiryOnPhone,
  INITIAL_INCOMING,
  inviteFrom,
  reduceIncoming,
  secondsLeft,
  type IncomingInvite,
} from '@/ring/invite-state';
import { DECLINE_NOTE_MAX, parsePush } from '@/ring/protocol';
import { setShowingInvite } from '@/ring/service';
import { chatAnswerRoute } from '@/ring/answer-route';
import { font } from '@/theme/fonts';
import { callPalette as palette, radius, space, type } from '@/theme/tokens';

/** How long "Missed call" / "Answered on another device" stays before the screen closes. */
const ENDED_LINGER_MS = 2500;
/** Used when neither the push nor the server said when the ring ends. */
const FALLBACK_RING_MS = 45_000;

type Params = {
  inviteId: string;
  answer?: string;
  agentId?: string;
  agentName?: string;
  reason?: string;
  expiresAt?: string;
  serverTime?: string;
};

function close() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/** The invite as far as the push (or deep link) told us, until the server answers. */
function inviteFromParams(params: Params, receivedAt: number): IncomingInvite {
  return {
    inviteId: params.inviteId,
    agentId: params.agentId ?? '',
    agentName: params.agentName?.trim() || 'Your agent',
    reason: params.reason?.trim() ?? '',
    expiresAt:
      params.expiresAt !== undefined && params.serverTime !== undefined
        ? expiryOnPhone(params.expiresAt, params.serverTime, receivedAt)
        : receivedAt + FALLBACK_RING_MS,
  };
}

function RoundAction({
  label,
  accessibilityLabel,
  onPress,
  disabled,
  glyph,
  connecting = false,
  ringing = false,
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled: boolean;
  glyph: 'answer' | 'decline';
  connecting?: boolean;
  ringing?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (glyph !== 'answer' || !ringing || reduceMotion) {
      cancelAnimation(pulse);
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 1500, easing: Easing.out(Easing.quad) }),
      -1,
    );
    return () => cancelAnimation(pulse);
  }, [glyph, pulse, reduceMotion, ringing]);
  const ringStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.6 : 0.7 * (1 - pulse.value),
    transform: [{ scale: reduceMotion ? 1 : 1 + pulse.value * 0.45 }],
  }));
  const answerAction = glyph === 'answer';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.actionCell, { opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }]}
    >
      <View style={[styles.round, answerAction ? styles.answerRound : styles.declineRound]}>
        {answerAction && ringing && (
          <Animated.View
            importantForAccessibility="no-hide-descendants"
            style={[styles.answerPulse, ringStyle]}
          />
        )}
        {connecting ? (
          <ActivityIndicator size="small" color={palette.onAccent} />
        ) : (
          <Icon
            name={answerAction ? 'phone' : 'phoneDown'}
            size={28}
            color={answerAction ? palette.onAccent : palette.onDanger}
            strokeWidth={2}
          />
        )}
      </View>
      <Text style={[styles.actionLabel, { color: answerAction ? palette.accent : palette.danger }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The incoming agent call: who is calling and why, Answer and Decline,
 * quick replies, and a countdown to when the ring ends. Shown over the lock screen while it rings.
 */
export default function IncomingCallScreen() {
  const params = useLocalSearchParams<Params>();
  const inviteId = typeof params.inviteId === 'string' ? params.inviteId : '';
  const [openedAt] = useState(() => Date.now());
  const [invite, setInvite] = useState<IncomingInvite>(() => inviteFromParams(params, openedAt));
  const [avatarPhoto, setAvatarPhoto] = useState<{ id: string; version?: number }>();
  useEffect(() => {
    if (!invite.agentId) return;
    const controller = new AbortController();
    void twringApi()
      ?.getAgent(invite.agentId, controller.signal)
      .then(
        (agent) => setAvatarPhoto({ id: agent.id, version: agent.avatar_version }),
        () => undefined,
      );
    return () => controller.abort();
  }, [invite.agentId]);
  const [state, dispatch] = useReducer(reduceIncoming, INITIAL_INCOMING);
  const [now, setNow] = useState(() => Date.now());
  const [replyOpen, setReplyOpen] = useState(false);
  const [reply, setReply] = useState('');
  const { width: windowWidth } = useWindowDimensions();
  const autoAnswered = useRef(false);
  const answered = useRef(false);

  // Over the lock screen only while this screen (then the call) shows.
  useEffect(() => {
    setShowingInvite(inviteId);
    ringPlatform.setShowWhenLocked(true);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    return () => {
      setShowingInvite(undefined);
      if (!answered.current) ringPlatform.setShowWhenLocked(false);
    };
  }, [inviteId]);

  // The server's view: details plus whether it is still ringing.
  useEffect(() => {
    const api = twringApi();
    if (api === undefined || inviteId === '') return;
    const controller = new AbortController();
    api.getInvite(inviteId, controller.signal).then(
      (loaded) => {
        setInvite(inviteFrom(loaded, Date.now()));
        dispatch({ type: 'LOADED', status: loaded.status });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) dispatch({ type: 'LOAD_FAILED', error });
      },
    );
    return () => controller.abort();
  }, [inviteId]);

  // Answered elsewhere, declined elsewhere, or the agent gave up.
  useEffect(
    () =>
      ringPlatform.onRingCancel((data) => {
        const push = parsePush({ type: 'cord.ring_cancel', ...(data as object) });
        if (push?.type === 'cord.ring_cancel' && push.invite_id === inviteId) {
          dispatch({ type: 'CANCELLED', status: push.status });
        }
      }),
    [inviteId],
  );

  // Countdown, corrected for the phone's clock.
  const live = state.phase === 'loading' || state.phase === 'ringing' || state.phase === 'failed';
  useEffect(() => {
    if (!live) return;
    const handle = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(handle);
  }, [live]);
  useEffect(() => {
    dispatch({ type: 'TICK', now, expiresAt: invite.expiresAt });
  }, [now, invite.expiresAt]);

  // The ring is over: stop the notification, say why, then leave.
  const ended = state.phase === 'ended';
  useEffect(() => {
    if (ended) ringPlatform.clearRing(inviteId);
  }, [ended, inviteId]);
  // Leaves only while this screen is in front: going back with the call screen on top would close
  // the call screen instead and leave this one stuck.
  useFocusEffect(
    useCallback(() => {
      if (!ended) return;
      const handle = setTimeout(close, ENDED_LINGER_MS);
      return () => clearTimeout(handle);
    }, [ended]),
  );

  // Android back declines nothing: it just leaves the screen (the notification keeps ringing).
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => subscription.remove();
  }, []);

  async function answer() {
    if (state.phase !== 'ringing' && state.phase !== 'failed') return;
    const api = twringApi();
    if (api === undefined) return;
    dispatch({ type: 'ANSWER' });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    ringPlatform.clearRing(inviteId);
    // Ask for the microphone before the server starts the call, so the agent never talks to a
    // call nobody can join. A denial still goes ahead: the call screen explains how to fix it.
    // An AI app's ring opens its chat instead, where the reply can be a voice note.
    await microphonePermission.request();
    try {
      const answer = await api.answerInvite(inviteId);
      const chatRoute = chatAnswerRoute(answer);
      if (chatRoute) {
        // An AI app's ring opens its chat, not a call: close the iOS system call screen.
        ringPlatform.endSystemCall?.();
        router.replace(chatRoute);
      } else if (answer.mode === 'call') {
        answered.current = true;
        startCall({ agentId: invite.agentId, name: invite.agentName }, answer.session);
      }
    } catch (error) {
      // iOS: the system call screen already shows the call as answered; nothing to join.
      ringPlatform.endSystemCall?.();
      dispatch({ type: 'ANSWER_FAILED', error });
    }
  }

  // "Answer" on the notification opens this screen with answer=1.
  useEffect(() => {
    if (params.answer === '1' && state.phase === 'ringing' && !autoAnswered.current) {
      autoAnswered.current = true;
      void answer();
    }
  });

  async function decline(note?: string) {
    const api = twringApi();
    dispatch({ type: 'DECLINE' });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    ringPlatform.clearRing(inviteId);
    if (api !== undefined) {
      const outcome = await sendDecline(
        (id, request) => api.declineInvite(id, request),
        inviteId,
        note === undefined ? {} : { note },
      );
      // Offline: send it later, like a Decline tapped on the notification.
      if (outcome === 'retry_later') ringPlatform.queueDecline(inviteId);
    }
    dispatch({ type: 'DECLINE_DONE' });
  }

  const busy = state.phase === 'answering' || state.phase === 'declining';
  const actionable = state.phase === 'ringing' || state.phase === 'failed';
  const left = secondsLeft(invite.expiresAt, now);
  const noteCheck = checkNote(reply);
  const ringing = state.phase === 'ringing';
  const canReply = state.phase !== 'ended';

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <Text style={[type.microLabel, styles.topLabel]}>TWRING CALL</Text>
      <View style={styles.centerContent}>
        <Avatar
          id={invite.agentId || invite.inviteId}
          name={invite.agentName}
          avatarVersion={avatarPhoto?.id === invite.agentId ? avatarPhoto.version : undefined}
          size={96}
          ringing={ringing}
        />
        <View style={styles.nameWrap}>
          <View
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
            pointerEvents="none"
            style={styles.nameWave}
          >
            <Waveform
              color={palette.speaking}
              width={Math.max(0, windowWidth - space.xl * 2)}
              height={90}
              intensity={ringing ? 0.45 : 0.18}
              animated={ringing}
            />
          </View>
          <Text accessibilityRole="header" numberOfLines={2} style={styles.name}>
            {invite.agentName}
          </Text>
        </View>
        {invite.reason !== '' && (
          <Text
            accessibilityLabel={`Reason: ${invite.reason}`}
            numberOfLines={2}
            style={styles.reason}
          >
            {invite.reason}
          </Text>
        )}
        {actionable && (
          <Text accessibilityLabel={`Rings for ${left} more seconds`} style={styles.clock}>
            {`Rings for ${left}s`}
          </Text>
        )}
        {state.phase === 'answering' && <Text style={styles.connecting}>Connecting…</Text>}
      </View>

      <View style={styles.bottom} accessibilityLiveRegion="polite">
        {state.phase === 'ended' && (
          <View accessibilityRole="alert" style={styles.notice}>
            <Text style={styles.endedTitle}>{endedCopy(state.why).title}</Text>
            <Text style={styles.endedDetail}>{endedCopy(state.why).detail}</Text>
          </View>
        )}
        {state.phase === 'failed' && (
          <Text
            accessibilityRole="alert"
            style={[type.body, styles.center, { color: palette.danger }]}
          >
            {state.error.message}
          </Text>
        )}

        {canReply && (
          <View style={styles.replyLinkWrap}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Type a reply"
              accessibilityHint="Declines the call with a short message"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => setReplyOpen(true)}
              style={({ pressed }) => [
                styles.replyLink,
                { opacity: busy ? 0.5 : pressed ? 0.8 : 1 },
              ]}
            >
              <Text style={styles.replyLinkText}>Reply to your agent</Text>
            </Pressable>
          </View>
        )}

        {state.phase === 'ended' ? null : state.phase === 'failed' ? (
          <View style={styles.failedActions}>
            <RoundAction
              label="Decline"
              accessibilityLabel={`Decline call from ${invite.agentName}`}
              glyph="decline"
              disabled={busy}
              onPress={() => void decline()}
            />
            <GhostButton label="Try again" tone="accent" onPress={() => void answer()} />
          </View>
        ) : (
          <View style={styles.actions}>
            <RoundAction
              label="Decline"
              accessibilityLabel={`Decline call from ${invite.agentName}`}
              glyph="decline"
              disabled={busy}
              onPress={() => void decline()}
            />
            <RoundAction
              label={state.phase === 'answering' ? 'Connecting…' : 'Answer'}
              accessibilityLabel={`Answer call from ${invite.agentName}`}
              glyph="answer"
              disabled={!actionable || busy}
              connecting={state.phase === 'answering'}
              ringing={ringing}
              onPress={() => void answer()}
            />
          </View>
        )}
      </View>
      <Sheet
        visible={replyOpen && canReply}
        title="Reply to your agent"
        onClose={() => setReplyOpen(false)}
      >
        <KeyboardAvoidingView behavior="padding" style={styles.replyBox}>
          <View style={styles.chips}>
            {QUICK_REPLIES.map((quick) => (
              <Pressable
                key={quick.note}
                accessibilityRole="button"
                accessibilityLabel={`Decline and reply: ${quick.label}`}
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => void decline(quick.note)}
                style={({ pressed }) => [styles.chipHit, { opacity: pressed ? 0.8 : 1 }]}
              >
                <View style={styles.chip}>
                  <Text style={styles.chipText}>{quick.label}</Text>
                </View>
              </Pressable>
            ))}
          </View>
          <TextInput
            accessibilityLabel="Reply to your agent"
            accessibilityHint={`Up to ${DECLINE_NOTE_MAX} characters. Declines the call.`}
            autoFocus
            maxLength={DECLINE_NOTE_MAX}
            placeholder="Type a reply"
            placeholderTextColor={palette.textSecondary}
            returnKeyType="send"
            value={reply}
            onChangeText={setReply}
            onSubmitEditing={() => {
              if (noteCheck.ok) void decline(noteCheck.note);
            }}
            style={styles.input}
          />
          <Text style={styles.counter}>{`${charactersLeft(reply)} left`}</Text>
          <PrimaryButton
            label="Send reply and decline"
            disabled={!noteCheck.ok || busy}
            onPress={() => {
              if (noteCheck.ok) void decline(noteCheck.note);
            }}
          />
        </KeyboardAvoidingView>
      </Sheet>
    </SafeAreaView>
  );
}

const ROUND = 72;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.background, paddingHorizontal: space.xl },
  topLabel: {
    color: palette.textTertiary,
    letterSpacing: 2.4,
    textAlign: 'center',
    paddingTop: 22,
  },
  centerContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
  nameWrap: {
    width: '100%',
    minHeight: 90,
    marginTop: 26,
    justifyContent: 'center',
    alignItems: 'center',
  },
  nameWave: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    // The wave sits behind the name as atmosphere; faded, so the name always reads first.
    opacity: 0.45,
  },
  name: {
    fontFamily: font.display,
    fontSize: 38,
    letterSpacing: -1.4,
    color: palette.textPrimary,
    textAlign: 'center',
    // A dark halo lifts the thin letters off the white wave lines.
    textShadowColor: '#000000',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 14,
    paddingHorizontal: 14,
  },
  reason: {
    ...type.body,
    color: palette.textSecondary,
    textAlign: 'center',
    lineHeight: 22.5,
    marginTop: 22,
    maxWidth: 310,
  },
  clock: {
    ...type.mono,
    color: palette.textTertiary,
    textAlign: 'center',
    marginTop: 16,
    fontVariant: ['tabular-nums'],
  },
  connecting: { ...type.mono, color: palette.accent, marginTop: 16 },
  bottom: { gap: 18, paddingBottom: 22 },
  notice: { gap: space.sm, alignItems: 'center' },
  endedTitle: { ...type.body, color: palette.textSecondary, textAlign: 'center' },
  endedDetail: { ...type.caption, color: palette.textSecondary, textAlign: 'center' },
  replyLinkWrap: { alignItems: 'center' },
  replyLink: { minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  replyLinkText: { fontFamily: font.interMedium, fontSize: 14, color: palette.accent },
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.xs },
  chipHit: { minHeight: 48, justifyContent: 'center' },
  chip: {
    height: 40,
    paddingHorizontal: 18,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: palette.borderAccent,
    backgroundColor: 'rgba(25,214,242,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontFamily: font.body, fontSize: 14, color: palette.accent },
  replyBox: { gap: space.md },
  input: {
    minHeight: 48,
    borderRadius: radius.md,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    color: palette.textPrimary,
    fontFamily: font.body,
    fontSize: 15,
  },
  counter: { fontFamily: font.monoRegular, fontSize: 12, color: palette.textTertiary },
  actions: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 10 },
  failedActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  actionCell: { alignItems: 'center', gap: 10, minWidth: 96, minHeight: 106 },
  round: {
    width: ROUND,
    height: ROUND,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  answerRound: { backgroundColor: palette.accent, boxShadow: '0 0 24px rgba(25,214,242,0.6)' },
  declineRound: { backgroundColor: palette.danger, boxShadow: '0 0 18px rgba(255,77,94,0.33)' },
  answerPulse: {
    position: 'absolute',
    top: -7,
    left: -7,
    width: ROUND + 14,
    height: ROUND + 14,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: palette.accent,
  },
  actionLabel: { fontFamily: font.interMedium, fontSize: 13 },
});
