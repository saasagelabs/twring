import { isActive, type Agent, type CallState } from '@twring/contracts';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
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

import { routeLabel, type AudioOutput } from '@/call/audio-routes';
import { callAgentLocation } from '@/agents/labels';
import { twringApi } from '@/api';
import type { CallView } from '@/call/controller';
import {
  INBOUND_STALE_MS,
  SPEECH_FLOOR_DBFS,
  activityText,
  formatDuration,
  noticeText,
  statusLabel,
} from '@/call/labels';
import { audioRoutes, callController, useAudioRoutes, useCallView } from '@/call/session';
import { callLook, waveIntensity } from '@/call/wave';
import { ApprovalCard } from '@/components/ApprovalCard';
import { CallControl } from '@/components/CallControl';
import { CallFeedback } from '@/components/call/CallFeedback';
import { CallOrb } from '@/components/CallOrb';
import { ConnectionPill } from '@/components/ConnectionPill';
import { GhostButton } from '@/components/GhostButton';
import { Icon, type IconName } from '@/components/Icon';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Sheet } from '@/components/Sheet';
import { StatusPill } from '@/components/StatusPill';
import { Waveform } from '@/components/Waveform';
import { showAudioRoutePicker } from '@/platform/audio-route';
import { ringPlatform } from '@/platform/ring';
import { connectionPill } from '@/theme/call-visuals';
import { callPalette as palette, space, type } from '@/theme/tokens';

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
  const label = view.muted
    ? 'You are muted'
    : !fresh
      ? 'Waiting for audio…'
      : hearing
        ? 'Twring hears you'
        : 'Say something';
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

function latestWords(text: string, max = 220): string {
  if (text.length <= max) return text;
  const cut = text.indexOf(' ', text.length - max);
  return `…${text.slice(cut === -1 ? text.length - max : cut + 1)}`;
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
/**
 * The reply and caption areas keep a fixed height (lines × line height, scaled with the phone's
 * text size): text growing or clearing must not re-center the panels and tilt the screen.
 */
const REPLY_LINES = 3;
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
                backgroundColor: output === current ? 'rgba(25,214,242,0.07)' : 'transparent',
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

function MiniControl({
  icon,
  label,
  active,
  expanded,
  disabled,
  onPress,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={active === undefined ? 'button' : 'switch'}
      accessibilityLabel={label}
      accessibilityState={{ checked: active, expanded, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={styles.miniHit}
    >
      <View style={[styles.miniCircle, active && styles.miniActive]}>
        <Icon
          name={icon}
          size={14}
          color={active ? palette.background : palette.textSecondary}
          strokeWidth={1.9}
        />
      </View>
    </Pressable>
  );
}

function ActiveCall({
  view,
  title,
  location,
}: {
  view: CallView;
  title: string;
  location?: string;
}) {
  const { fontScale } = useWindowDimensions();
  const connected = view.connectedAt !== undefined;
  const routes = useAudioRoutes();
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

  useEffect(() => {
    if (!polling) return;
    let poll: ReturnType<typeof setInterval> | undefined;
    const resume = () => {
      void audioRoutes.refresh();
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Minimize call"
          accessibilityHint="The call keeps going"
          onPress={minimize}
          style={styles.minimize}
        >
          <Icon name="chevDown" size={22} color={palette.textPrimary} />
        </Pressable>
        {connectionPill(status) ? (
          <ConnectionPill {...connectionPill(status)!} />
        ) : (
          <View style={styles.connectionSlot} />
        )}
        <View style={styles.topSlot} />
      </View>

      <View style={styles.panels}>
        <View style={styles.speakerPanel}>
          <View style={styles.panelHeader}>
            <View style={styles.speakerName}>
              <View
                style={[
                  styles.speakerDot,
                  {
                    backgroundColor:
                      look.who === 'agent' ? palette.speaking : 'rgba(255,255,255,0.55)',
                  },
                ]}
              />
              <Text
                numberOfLines={1}
                style={[
                  type.microLabel,
                  styles.agentName,
                  { color: look.who === 'agent' ? '#FFFFFF' : palette.textTertiary },
                ]}
              >
                {title.toUpperCase()}
              </Text>
            </View>
            {location !== undefined && (
              <Text style={[type.caption, styles.serverLabel]}>{location}</Text>
            )}
          </View>
          <View
            style={styles.waveFrame}
            onLayout={(event) => setWaveWidth(event.nativeEvent.layout.width)}
          >
            {waveWidth > 0 && (
              <Waveform
                color={palette.speaking}
                intensity={agentIntensity}
                width={waveWidth}
                height={78}
                mode={look.agentWave}
              />
            )}
          </View>
          <View style={styles.clockRow}>
            {view.connectedAt !== undefined && <CallClock connectedAt={view.connectedAt} />}
          </View>
          <View
            accessibilityLiveRegion="polite"
            style={[styles.replyFrame, { height: REPLY_LINES * REPLY_LINE_HEIGHT * fontScale }]}
          >
            {view.reply !== undefined && (
              <Text
                accessibilityLabel={`Agent: ${view.reply.text}`}
                numberOfLines={REPLY_LINES}
                style={styles.reply}
              >
                {latestWords(view.reply.text)}
                {status === 'AGENT_SPEAKING' && !reducedMotion && <Caret />}
              </Text>
            )}
            {view.notice !== undefined && (
              <Text accessibilityRole="alert" style={[type.caption, styles.notice]}>
                {noticeText(view.notice)}
              </Text>
            )}
          </View>
        </View>

        <View style={styles.centerRow}>
          {connected ? (
            <MiniControl
              icon={view.muted ? 'micOff' : 'mic'}
              label="Mute microphone"
              active={view.muted}
              disabled={ending}
              onPress={toggleMute}
            />
          ) : (
            <View style={styles.miniHit} />
          )}
          <CallOrb mode={look.orb} />
          {connected ? (
            <MiniControl
              icon={audioIcon}
              label={audioLabel}
              expanded={routesOpen}
              disabled={ending}
              onPress={chooseAudio}
            />
          ) : (
            <View style={styles.miniHit} />
          )}
        </View>

        <View style={styles.speakerPanel}>
          <View style={styles.panelHeader}>
            <View style={styles.speakerName}>
              <View style={[styles.speakerDot, { backgroundColor: palette.accent }]} />
              <Text style={[type.microLabel, styles.youName]}>YOU</Text>
            </View>
          </View>
          <View style={styles.waveFrame}>
            {waveWidth > 0 && (
              <Waveform
                color={palette.userSpeaking}
                intensity={youIntensity}
                width={waveWidth}
                height={78}
                mode={look.youWave}
              />
            )}
          </View>
          <View
            accessibilityLiveRegion="polite"
            style={[
              styles.captionFrame,
              { height: CAPTION_LINES * CAPTION_LINE_HEIGHT * fontScale },
            ]}
          >
            {view.caption !== undefined && (
              <Text
                accessibilityLabel={`You: ${view.caption.text}`}
                numberOfLines={CAPTION_LINES}
                style={styles.caption}
              >
                “{latestWords(view.caption.text, 120)}”
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
          <View style={styles.controlSlot} />
        )}
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
          <View style={styles.controlSlot} />
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
            onPress={() => {
              if (!ending) void callController()?.hangUp();
            }}
          />
        </View>
      </View>

      <View style={styles.statusArea}>
        <StatusPill
          label={
            view.muted && status !== 'RECONNECTING'
              ? 'You are muted'
              : statusLabel(view.call, view.connectedAt)
          }
          detail={detail}
          reserveDetail
          tone={look.pill.tone}
          active={look.pill.active}
        />
        {connected ? <HearingLabel view={view} /> : <Text style={styles.hearing}> </Text>}
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
  retry,
}: {
  view: CallView;
  title: string;
  retry: () => void;
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
      <ScrollView
        contentContainerStyle={styles.outcomeScrollContent}
        style={styles.outcomeScroll}
        keyboardShouldPersistTaps="handled"
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
              <Text selectable style={[type.mono, styles.outcomeCode]}>
                {failed.code}
                {failed.correlationId !== undefined ? ` · ref ${failed.correlationId}` : ''}
              </Text>
            </>
          )}
        </Animated.View>
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
        <FinishedCall view={view} title={title} retry={retry} />
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
  topSlot: { width: 36, height: 36 },
  minimize: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  connectionSlot: { height: 32 },
  panels: { flex: 1, minHeight: 0 },
  speakerPanel: { flex: 1, minHeight: 0, justifyContent: 'center' },
  panelHeader: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  speakerName: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  speakerDot: { width: 6, height: 6, borderRadius: 3 },
  agentName: { letterSpacing: 1.6, flexShrink: 1 },
  youName: { color: palette.accent, letterSpacing: 1.6 },
  serverLabel: { color: palette.textTertiary },
  waveFrame: { width: '100%', height: 78, justifyContent: 'center', marginVertical: 6 },
  clockRow: { minHeight: 18, alignItems: 'flex-end' },
  clock: { color: '#FFFFFF', textAlign: 'right', fontVariant: ['tabular-nums'] },
  replyFrame: {
    paddingHorizontal: 4,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reply: {
    ...type.body,
    color: '#FFFFFF',
    fontSize: 15,
    lineHeight: REPLY_LINE_HEIGHT,
    textAlign: 'center',
  },
  notice: { color: palette.reconnecting, textAlign: 'center' },
  centerRow: {
    minHeight: 64,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
  },
  miniHit: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  miniCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniActive: { backgroundColor: '#FFFFFF', borderWidth: 0 },
  captionFrame: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  caption: {
    color: palette.textTertiary,
    fontSize: 13,
    lineHeight: CAPTION_LINE_HEIGHT,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'flex-start',
    paddingVertical: 10,
  },
  controlSlot: { minWidth: 64 },
  statusArea: { alignItems: 'stretch', paddingTop: 2, paddingBottom: 6, gap: 6 },
  hearing: { color: palette.textTertiary, textAlign: 'center' },
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
  outcomeTitle: { color: '#FFFFFF', textAlign: 'center' },
  outcomeDetail: { color: palette.textSecondary, textAlign: 'center', marginTop: 10 },
  outcomeCode: { color: palette.textTertiary, textAlign: 'center', marginTop: 10 },
  actions: { gap: 10, paddingBottom: space.xl },
});
