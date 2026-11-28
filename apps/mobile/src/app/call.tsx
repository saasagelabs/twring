import { isActive, type Agent, type AgentProtocol, type CallState } from '@twring/contracts';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  cancelAnimation,
  FadeIn,
  FadeInUp,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { routeFailureText, routeLabel, type AudioOutput } from '@/call/audio-routes';
import { callAgentLocation } from '@/agents/labels';
import { twringApi } from '@/api';
import type { CallView } from '@/call/controller';
import { CAPTION_TAIL_CHARS, captionTail, readableReply, REPLY_TAIL_CHARS } from '@/call/captions';
import {
  INBOUND_STALE_MS,
  SPEECH_FLOOR_DBFS,
  activityText,
  formatDuration,
  noticeText,
  statusLabel,
} from '@/call/labels';
import {
  audioRoutes,
  audioRoutesWatched,
  callController,
  useAudioRoutes,
  useCallInterruption,
  useCallView,
} from '@/call/session';
import { INTERRUPTION_NOTICE } from '@/call/call-interruption';
import { activeWave, hearingLabel, ringKey } from '@/call/portrait';
import { callLook, waveIntensity } from '@/call/wave';
import { ApprovalCard } from '@/components/ApprovalCard';
import { Avatar } from '@/components/Avatar';
import { CallControl } from '@/components/CallControl';
import { CallBackButton } from '@/components/call/CallBackButton';
import { CallFeedback } from '@/components/call/CallFeedback';
import { RingMeWhenDone } from '@/components/call/RingMeWhenDone';
import { TranscriptToChat } from '@/components/call/TranscriptToChat';
import { ConnectionPill } from '@/components/ConnectionPill';
import { playCallFeedback } from '@/platform/haptics';
import { GhostButton } from '@/components/GhostButton';
import { Icon, type IconName } from '@/components/Icon';
import { OfflineHelp } from '@/components/OfflineHelp';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Sheet } from '@/components/Sheet';
import { Waveform } from '@/components/Waveform';
import { showAudioRoutePicker } from '@/platform/audio-route';
import { ringPlatform } from '@/platform/ring';
import { connectionPill } from '@/theme/call-visuals';
import { callPalette as palette, space, type } from '@/theme/tokens';
import { useTimeLeftNotice } from '@/usage/useTimeLeftNotice';

function useNow(enabled: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const handle = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(handle);
  }, [enabled, ms]);
  return now;
}

function detailText(state: CallState): string | undefined {
  if (state.status === 'RECONNECTING') return 'Your call will pick up where it left off.';
  return activityText(state);
}

function close() {
  callController()?.reset();
  ringPlatform.setShowWhenLocked(false);
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function minimize() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function HearingLabel({ view }: { view: CallView }) {
  const now = useNow(true);
  const fresh = view.inbound !== undefined && now - view.inbound.at < INBOUND_STALE_MS;
  const hearing = fresh && view.inbound!.peakDbfs > SPEECH_FLOOR_DBFS;
  const label = hearingLabel({ status: view.call.status, muted: view.muted, fresh, hearing });
  return (
    <Text
      accessibilityLabel={`Microphone at Twring: ${label}`}
      style={[type.caption, styles.hearing]}
    >
      {label}
    </Text>
  );
}

function CallClock({ connectedAt }: { connectedAt: number }) {
  const now = useNow(true);
  const text = formatDuration(now - connectedAt);
  return (
    <Text accessibilityLabel={`Call time ${text}`} style={[type.mono, styles.clock]}>
      {text}
    </Text>
  );
}

function Caret() {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reducedMotion) return;
    opacity.value = withRepeat(withTiming(0, { duration: 500 }), -1, true);
    return () => cancelAnimation(opacity);
  }, [opacity, reducedMotion]);
  const motion = useAnimatedStyle(() => ({ opacity: opacity.value }));
  if (reducedMotion) return null;
  return <Animated.Text style={[styles.reply, motion]}>▍</Animated.Text>;
}

function routeIcon(output: AudioOutput | undefined): IconName {
  switch (output) {
    case 'speaker':
      return 'volume';
    case 'earpiece':
      return 'phone';
    case 'bluetooth':
      return 'bluetooth';
    case 'headset':
      return 'headset';
    case undefined:
      return 'volume';
  }
}

const ROUTE_POLL_MS = 2000;
const ROUTE_FAILURE_MS = 4000;

/**
 * The line for a route switch that did not land: shown for 4 s or until that route does land,
 * with the error haptic and the same words for the screen reader.
 */
function useRouteFailure(): string | undefined {
  const [shown, setShown] = useState<{ target: AudioOutput; at: number }>();
  useEffect(
    () =>
      audioRoutes.subscribe(() => {
        const { current, failed } = audioRoutes.getState();
        if (failed === undefined) {
          setShown((line) => (line !== undefined && current === line.target ? undefined : line));
          return;
        }
        setShown({ target: failed, at: Date.now() });
        playCallFeedback('error');
        AccessibilityInfo.announceForAccessibility(routeFailureText(failed));
      }),
    [],
  );
  useEffect(() => {
    if (shown === undefined) return;
    const timer = setTimeout(() => setShown(undefined), ROUTE_FAILURE_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  return shown === undefined ? undefined : routeFailureText(shown.target);
}
/**
 * The reply and caption areas keep a fixed height (lines × line height, scaled with the phone's
 * text size): text growing or clearing must not re-center the panels and tilt the screen. Text is
 * bottom-anchored, so earlier lines roll up and off the top like captions. A short window (under
 * 700 dp, the same cut as the smaller avatar) gets one reply line fewer to keep the controls on
 * screen at large text sizes.
 */
const REPLY_LINES = 4;
const REPLY_LINES_COMPACT = 3;
const REPLY_LINE_HEIGHT = 22;
const CAPTION_LINES = 2;
const CAPTION_LINE_HEIGHT = 19;

function RouteSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { outputs, current } = useAudioRoutes();
  const openPicker = useRef(false);
  // Apple's picker opens once the sheet is gone: on onDismiss, or after a short wait if iOS never
  // reports it. Taken once either way.
  const showPicker = () => {
    if (!openPicker.current) return;
    openPicker.current = false;
    void audioRoutes.choose('earpiece').then(showAudioRoutePicker);
  };
  return (
    <Sheet visible={visible} title="Audio output" onClose={onClose} onDismiss={showPicker}>
      <View accessibilityRole="radiogroup" accessibilityLabel="Audio output">
        {outputs.map((output) => (
          <Pressable
            key={output}
            accessibilityRole="radio"
            accessibilityLabel={routeLabel(output)}
            accessibilityState={{ checked: output === current }}
            onPress={() => {
              void audioRoutes.choose(output);
              onClose();
            }}
            style={({ pressed }) => [
              styles.routeRow,
              {
                backgroundColor: output === current ? palette.accentTint : 'transparent',
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Icon
              name={routeIcon(output)}
              size={18}
              color={output === current ? palette.accent : palette.textSecondary}
            />
            <Text style={[type.body, styles.routeName]}>{routeLabel(output)}</Text>
            {output === current && (
              <Icon name="check" size={16} color={palette.accent} strokeWidth={2.2} />
            )}
          </Pressable>
        ))}
        {outputs.length === 0 && (
          <Text style={[type.caption, styles.routeRow, styles.hearing]}>
            Looking for audio outputs…
          </Text>
        )}
        {Platform.OS === 'ios' && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Bluetooth and more"
            onPress={() => {
              openPicker.current = true;
              onClose();
              setTimeout(showPicker, 700);
            }}
            style={styles.routeRow}
          >
            <Icon name="bluetooth" size={18} color={palette.textSecondary} />
            <Text style={[type.body, styles.routeName]}>Bluetooth &amp; more</Text>
          </Pressable>
        )}
      </View>
    </Sheet>
  );
}

function ActiveCall({
  view,
  title,
  location,
  agentId,
  avatarVersion,
}: {
  view: CallView;
  title: string;
  location?: string;
  agentId?: string;
  avatarVersion?: number;
}) {
  const { fontScale, height: windowHeight } = useWindowDimensions();
  const compact = windowHeight < 700;
  const replyLines = compact ? REPLY_LINES_COMPACT : REPLY_LINES;
  const avatarSize = compact ? 80 : 104;
  const waveHeight = compact ? 56 : 78;
  const connected = view.connectedAt !== undefined;
  const clockNow = useNow(connected);
  const timeLeft = useTimeLeftNotice(view.connectedAt, clockNow);
  const routes = useAudioRoutes();
  const routeFailure = useRouteFailure();
  const [routesOpen, setRoutesOpen] = useState(false);
  const [waveWidth, setWaveWidth] = useState(0);
  const agentIntensity = useSharedValue(0.18);
  const youIntensity = useSharedValue(0.18);
  const reducedMotion = useReducedMotion();
  const status = view.call.status;
  const ending = status === 'ENDING';
  const polling = connected && !ending;
  const detail = detailText(view.call);
  const look = callLook(status, view.muted, detail !== undefined);
  const ringColor = palette[ringKey(look)];
  const wave = activeWave(look);
  const live = look.orb !== 'connecting' && look.orb !== 'reconnecting';
  const { paused } = useCallInterruption();
  const showMuted = view.muted && status !== 'RECONNECTING';
  const statusText = paused
    ? INTERRUPTION_NOTICE
    : showMuted
      ? 'You are muted'
      : statusLabel(view.call, view.connectedAt);
  const statusColor = showMuted
    ? palette.textSecondary
    : look.orb === 'idle' || look.orb === 'connecting'
      ? palette.textPrimary
      : ringColor;

  useEffect(() => {
    if (!polling) return;
    let poll: ReturnType<typeof setInterval> | undefined;
    const resume = () => {
      void audioRoutes.refresh();
      // Route events arrive natively (screen off too); polling is only the fallback.
      if (audioRoutesWatched) return;
      poll ??= setInterval(() => void audioRoutes.refresh(), ROUTE_POLL_MS);
    };
    const pause = () => {
      if (poll !== undefined) clearInterval(poll);
      poll = undefined;
    };
    if (AppState.currentState !== 'background') resume();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') resume();
      else if (state === 'background') pause();
    });
    return () => {
      pause();
      appState.remove();
    };
  }, [polling]);

  useEffect(() => {
    const levels = callController()?.levels;
    const apply = () => {
      const sample = levels?.getLevels();
      agentIntensity.value = look.who === 'agent' ? waveIntensity(sample?.remote ?? 0) : 0.18;
      youIntensity.value =
        look.who === 'you' && !view.muted ? waveIntensity(sample?.local ?? 0) : 0.18;
    };
    apply();
    return levels?.subscribe(apply);
  }, [agentIntensity, youIntensity, look.who, view.muted]);

  const audioLabel =
    routes.current !== undefined ? `Audio output, ${routeLabel(routes.current)}` : 'Audio output';
  const audioIcon = routeIcon(routes.current);
  const chooseAudio = () => setRoutesOpen((open) => !open);
  const toggleMute = () => void callController()?.setMuted(!view.muted);

  return (
    <>
      <View style={styles.topBar}>
        <View style={styles.topSide}>
          <CallBackButton onPress={minimize} hint="The call keeps going" showLabel />
        </View>
        {connectionPill(status) ? (
          <ConnectionPill {...connectionPill(status)!} />
        ) : (
          <View style={styles.connectionSlot} />
        )}
        <View style={styles.topSide} />
      </View>

      <View style={styles.body}>
        <View style={styles.portrait}>
          <View
            style={[
              styles.ring,
              {
                width: avatarSize + 12,
                height: avatarSize + 12,
                borderRadius: (avatarSize + 12) / 2,
                borderColor: ringColor,
                // Hex colours only: the working and connecting greys are rgba and never glow.
                boxShadow:
                  live && !reducedMotion && ringColor.startsWith('#')
                    ? `0 0 24px ${ringColor}55`
                    : undefined,
              },
            ]}
          >
            <Avatar
              id={agentId ?? title}
              name={title}
              avatarVersion={avatarVersion}
              size={avatarSize}
            />
          </View>
          <Text numberOfLines={1} style={[type.title, styles.name]}>
            {title}
          </Text>
          <Text numberOfLines={1} style={[type.caption, styles.serverLabel]}>
            {location ?? ' '}
          </Text>
        </View>

        <View accessibilityLiveRegion="polite" style={styles.statusBlock}>
          <Text
            numberOfLines={1}
            style={[
              type.headline,
              styles.statusLabel,
              { color: statusColor },
              status === 'AGENT_WORKING' && !showMuted && styles.italic,
            ]}
          >
            {statusText || ' '}
          </Text>
          <Text numberOfLines={1} style={[type.caption, styles.detail]}>
            {detail ?? ' '}
          </Text>
          <View style={styles.clockRow}>
            {view.connectedAt !== undefined && <CallClock connectedAt={view.connectedAt} />}
          </View>
          {timeLeft !== undefined && <Text style={[type.caption, styles.detail]}>{timeLeft}</Text>}
        </View>

        <View
          style={[styles.waveFrame, { height: waveHeight }]}
          onLayout={(event) => setWaveWidth(event.nativeEvent.layout.width)}
        >
          {waveWidth > 0 && (
            <Waveform
              color={
                wave.who === 'agent'
                  ? palette.speaking
                  : wave.who === 'you'
                    ? palette.userSpeaking
                    : palette.textTertiary
              }
              intensity={wave.who === 'you' ? youIntensity : agentIntensity}
              width={waveWidth}
              height={waveHeight}
              mode={wave.mode}
            />
          )}
        </View>

        <View style={styles.captions}>
          <Text
            numberOfLines={1}
            style={[
              type.microLabel,
              styles.speakerLabel,
              { color: look.who === 'agent' ? palette.textPrimary : palette.textTertiary },
            ]}
          >
            {title.toUpperCase()}
          </Text>
          <View
            accessibilityLiveRegion="polite"
            style={[styles.replyFrame, { height: replyLines * REPLY_LINE_HEIGHT * fontScale }]}
          >
            {view.reply !== undefined && (
              <Text accessibilityLabel={replyLabel(view.reply)} style={styles.reply}>
                {captionTail(view.reply.text, REPLY_TAIL_CHARS)}
                {status === 'AGENT_SPEAKING' && !reducedMotion && <Caret />}
              </Text>
            )}
            {view.notice !== undefined && (
              <Text accessibilityRole="alert" style={[type.caption, styles.notice]}>
                {noticeText(view.notice)}
              </Text>
            )}
          </View>
          <Text style={[type.microLabel, styles.speakerLabel, styles.youName]}>YOU</Text>
          <View
            accessibilityLiveRegion="polite"
            style={[
              styles.captionFrame,
              { height: CAPTION_LINES * CAPTION_LINE_HEIGHT * fontScale },
            ]}
          >
            {view.caption !== undefined && (
              <Text accessibilityLabel={`You: ${view.caption.text}`} style={styles.caption}>
                “{captionTail(view.caption.text, CAPTION_TAIL_CHARS)}”
              </Text>
            )}
          </View>
        </View>
      </View>

      <View style={styles.controls}>
        {connected ? (
          <View
            accessible
            accessibilityRole="switch"
            accessibilityLabel="Mute microphone"
            accessibilityHint={view.muted ? 'Twring cannot hear you' : undefined}
            accessibilityState={{ checked: view.muted, disabled: ending }}
            onAccessibilityTap={() => {
              if (!ending) toggleMute();
            }}
            style={styles.sideSlot}
          >
            <CallControl
              icon={view.muted ? 'micOff' : 'mic'}
              label={view.muted ? 'Muted' : 'Mute'}
              accessibilityLabel="Mute microphone"
              variant={view.muted ? 'active' : 'default'}
              onPress={() => {
                if (!ending) toggleMute();
              }}
            />
          </View>
        ) : (
          <View style={styles.sideSlot} />
        )}
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel="End call"
          accessibilityState={{ disabled: ending }}
          onAccessibilityTap={() => {
            if (!ending) void callController()?.hangUp();
          }}
        >
          <CallControl
            icon="phoneDown"
            label="End"
            accessibilityLabel="End call"
            variant="danger"
            size="large"
            onPress={() => {
              if (!ending) void callController()?.hangUp();
            }}
          />
        </View>
        {connected ? (
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={audioLabel}
            accessibilityHint="Choose speaker, phone, or headset"
            accessibilityState={{
              disabled: ending,
              expanded: routesOpen,
            }}
            onAccessibilityTap={() => {
              if (!ending) chooseAudio();
            }}
            style={styles.sideSlot}
          >
            <CallControl
              icon={audioIcon}
              label="Audio"
              accessibilityLabel={audioLabel}
              onPress={() => {
                if (!ending) chooseAudio();
              }}
            />
          </View>
        ) : (
          <View style={styles.sideSlot} />
        )}
      </View>

      <View style={styles.hearingArea}>
        {routeFailure !== undefined ? (
          <Text style={[type.caption, styles.routeFailure]}>{routeFailure}</Text>
        ) : connected ? (
          <HearingLabel view={view} />
        ) : (
          <Text style={styles.hearing}> </Text>
        )}
      </View>

      <RouteSheet visible={routesOpen} onClose={() => setRoutesOpen(false)} />
      {view.approval !== undefined && (
        <Animated.View
          key={view.approval.id}
          entering={reducedMotion ? FadeIn.duration(250) : FadeInUp.duration(300)}
          style={styles.approvalOverlay}
        >
          <LinearGradient
            colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.85)']}
            style={StyleSheet.absoluteFill}
          />
          <ApprovalCard
            approval={view.approval}
            error={view.approvalError}
            onDecision={(decision) => void callController()?.decideApproval(decision)}
          />
        </Animated.View>
      )}
    </>
  );
}

function FinishedCall({
  view,
  title,
  agent,
  retry,
  protocol,
}: {
  view: CallView;
  title: string;
  agent: Agent | undefined;
  retry: () => void;
  /** How the called agent reaches Twring, once loaded: picks the offline help. */
  protocol?: AgentProtocol;
}) {
  const { call } = view;
  const duration =
    view.connectedAt !== undefined && view.finishedAt !== undefined
      ? formatDuration(view.finishedAt - view.connectedAt)
      : undefined;
  const failed = call.status === 'FAILED' ? call.error : undefined;
  const needsSettings = failed?.code === 'MIC_PERMISSION_DENIED';
  const [waveWidth, setWaveWidth] = useState(0);

  return (
    // The rating note opens the keyboard: keep Send and Done above it, as the chat screen does.
    <KeyboardAvoidingView behavior="padding" style={styles.outcomeKeyboard}>
      <View style={styles.topBar}>
        <CallBackButton onPress={close} />
      </View>
      <ScrollView
        contentContainerStyle={styles.outcomeScrollContent}
        style={styles.outcomeScroll}
        keyboardShouldPersistTaps="handled"
        // The rating makes the page a little taller than the screen: no bar sliding at the side.
        showsVerticalScrollIndicator={false}
      >
        <Animated.View
          entering={FadeIn.duration(220)}
          accessibilityRole={failed !== undefined ? 'alert' : undefined}
          style={styles.outcomeContent}
        >
          <Text style={[type.microLabel, styles.outcomeAgent]}>{title.toUpperCase()}</Text>
          <View
            style={styles.outcomeWave}
            onLayout={(event) => setWaveWidth(event.nativeEvent.layout.width)}
          >
            {waveWidth > 0 && (
              <Waveform
                color={palette.speaking}
                intensity={0}
                width={waveWidth}
                height={40}
                mode="flat"
              />
            )}
          </View>
          <Text accessibilityRole="header" style={[type.display, styles.outcomeTitle]}>
            {statusLabel(call, view.connectedAt) || 'Call ended'}
          </Text>
          {duration !== undefined && (
            <Text
              accessibilityLabel={`Call lasted ${duration}`}
              style={[type.mono, styles.outcomeDetail]}
            >{`Call lasted ${duration}`}</Text>
          )}
          {failed !== undefined && (
            <>
              <Text style={[type.body, styles.outcomeDetail]}>{failed.message}</Text>
              <Text
                selectable
                accessibilityLabel={`Reference code ${reference(failed)}`}
                style={[type.caption, styles.outcomeCode]}
              >{`Reference: ${reference(failed)}`}</Text>
              {failed.code === 'AGENT_OFFLINE' && (
                <OfflineHelp
                  protocol={protocol ?? 'cord-connector'}
                  color={palette.textSecondary}
                  align="center"
                />
              )}
            </>
          )}
        </Animated.View>
        <RingMeWhenDone
          key={('callId' in call ? call.callId : undefined) ?? 'none'}
          call={call}
          connectedAt={view.connectedAt}
          agent={agent}
        />
        <TranscriptToChat
          key={`transcript-${('callId' in call ? call.callId : undefined) ?? 'none'}`}
          call={call}
          connectedAt={view.connectedAt}
          agent={agent}
        />
        {(call.status === 'ENDED' || call.status === 'FAILED') &&
          call.callId !== undefined &&
          view.connectedAt !== undefined &&
          view.finishedAt !== undefined &&
          view.finishedAt - view.connectedAt >= 5_000 && (
            <CallFeedback key={call.callId} callId={call.callId} />
          )}
      </ScrollView>
      <View style={styles.actions}>
        {needsSettings ? (
          <>
            <PrimaryButton label="Open Settings" onPress={() => void Linking.openSettings()} />
            <GhostButton label="Done" onPress={close} />
          </>
        ) : failed !== undefined && failed.retryable ? (
          <>
            <PrimaryButton label="Try again" onPress={retry} />
            <GhostButton label="Done" onPress={close} />
          </>
        ) : failed !== undefined ? (
          <GhostButton label="Done" onPress={close} />
        ) : (
          <>
            <PrimaryButton label="Call again" onPress={retry} />
            <GhostButton label="Done" onPress={close} />
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

export default function CallScreen() {
  const view = useCallView();
  const active = isActive(view.call);
  const params = useLocalSearchParams<{ agentId?: string; name?: string }>();
  const agentId = typeof params.agentId === 'string' ? params.agentId : undefined;
  const [agent, setAgent] = useState<Agent | undefined>(undefined);
  useEffect(() => {
    if (agentId === undefined) return;
    const api = twringApi();
    if (api === undefined) return;
    const controller = new AbortController();
    void api.listAgents(controller.signal).then(
      (agents) => {
        if (!controller.signal.aborted) setAgent(agents.find((item) => item.id === agentId));
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [agentId]);
  const title =
    typeof params.name === 'string' && params.name !== '' ? params.name : 'Twring test line';
  const retry = () =>
    void callController()?.start(agentId !== undefined ? { agent_id: agentId } : {}, title);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (active) {
        minimize();
        return true;
      }
      close();
      return true;
    });
    return () => subscription.remove();
  }, [active]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      {active ? (
        <ActiveCall
          view={view}
          title={title}
          location={callAgentLocation(agent?.id === agentId ? agent : undefined)}
          agentId={agentId}
          avatarVersion={agent?.id === agentId ? agent?.avatar_version : undefined}
        />
      ) : view.call.status === 'IDLE' ? (
        <>
          <View style={styles.outcomeCenter}>
            <Text style={[type.body, styles.outcomeDetail]}>Not in a call</Text>
          </View>
          <View style={styles.actions}>
            <GhostButton label="Close" onPress={close} />
          </View>
        </>
      ) : (
        <FinishedCall
          view={view}
          title={title}
          agent={agent?.id === agentId ? agent : undefined}
          retry={retry}
          protocol={agent?.id === agentId ? agent?.protocol : undefined}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.background, paddingHorizontal: space.xl },
  topBar: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // Equal sides keep the connection pill centred whatever width "Back" takes at large text.
  topSide: { flex: 1, minWidth: 48, alignItems: 'flex-start' },
  connectionSlot: { height: 32 },
  body: { flex: 1, minHeight: 0, justifyContent: 'space-evenly' },
  portrait: { alignItems: 'center', gap: 6 },
  ring: { borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  name: { color: palette.textPrimary, textAlign: 'center' },
  serverLabel: { color: palette.textTertiary, textAlign: 'center' },
  statusBlock: { alignItems: 'center', gap: 2 },
  statusLabel: { textAlign: 'center' },
  italic: { fontStyle: 'italic' },
  detail: { color: palette.textSecondary, textAlign: 'center' },
  clockRow: { minHeight: 18, alignItems: 'center' },
  clock: { color: palette.textTertiary, textAlign: 'center', fontVariant: ['tabular-nums'] },
  waveFrame: { width: '100%', justifyContent: 'center' },
  captions: { alignItems: 'stretch' },
  speakerLabel: { letterSpacing: 1.6, textAlign: 'center' },
  youName: { color: palette.accent, marginTop: 4 },
  replyFrame: {
    paddingHorizontal: 4,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  reply: {
    ...type.body,
    color: palette.textPrimary,
    fontSize: type.body.fontSize,
    lineHeight: REPLY_LINE_HEIGHT,
    textAlign: 'center',
  },
  notice: { color: palette.reconnecting, textAlign: 'center' },
  captionFrame: { alignItems: 'center', justifyContent: 'flex-end', overflow: 'hidden' },
  caption: {
    color: palette.textTertiary,
    fontSize: type.caption.fontSize,
    lineHeight: CAPTION_LINE_HEIGHT,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    paddingVertical: 10,
  },
  sideSlot: { width: 72, alignItems: 'center' },
  hearingArea: { paddingTop: 2, paddingBottom: 6 },
  hearing: { color: palette.textTertiary, textAlign: 'center' },
  routeFailure: { color: palette.reconnecting, textAlign: 'center', paddingHorizontal: 16 },
  routeRow: {
    minHeight: 56,
    paddingHorizontal: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  routeName: { color: palette.textPrimary, flex: 1 },
  approvalOverlay: {
    position: 'absolute',
    top: '42%',
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  outcomeCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  outcomeKeyboard: { flex: 1 },
  outcomeScroll: { flex: 1 },
  outcomeScrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    paddingVertical: space.lg,
  },
  outcomeContent: { width: '100%', alignItems: 'center' },
  outcomeAgent: { color: palette.textTertiary, letterSpacing: 1.6 },
  outcomeWave: { width: '100%', height: 40, marginTop: 26, marginBottom: 22 },
  outcomeTitle: { color: palette.textPrimary, textAlign: 'center' },
  outcomeDetail: { color: palette.textSecondary, textAlign: 'center', marginTop: 10 },
  outcomeCode: { color: palette.textTertiary, textAlign: 'center', marginTop: 10 },
  actions: { gap: 10, paddingBottom: space.xl },
});

/** The reply as a screen reader hears it: a sentence at a time, never word by word. */
function replyLabel(reply: { text: string; final: boolean }): string {
  const readable = readableReply(reply.text, reply.final);
  return readable === '' ? 'Agent' : `Agent: ${readable}`;
}

/** The failure's code and server reference, for support. */
function reference(failed: { code: string; correlationId?: string }): string {
  return failed.correlationId === undefined
    ? failed.code
    : `${failed.code} · ref ${failed.correlationId}`;
}
