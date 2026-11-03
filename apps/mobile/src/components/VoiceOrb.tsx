import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { drivingLevel, type CallLevels, type VisualizerMode } from '@/call/levels';
import {
  CORE_MAX_GROWTH,
  HALO_GROWTH,
  HALO_REST,
  orbColor,
  orbRole,
  safeLevel,
} from '@/theme/call-visuals';
import { radius, type Palette } from '@/theme/tokens';

/** The whole orb, halos included, fits this square: switching modes never moves the screen. */
export const ORB_FRAME = 240;
const CORE = 112;
const GLOW = 360;
const HALO_OPACITY = [0.22, 0.12, 0.06] as const;
/** Level smoothing; shorter than the ~80 ms update interval would look jittery. */
const LEVEL_EASE_MS = 120;
const COLOR_MS = 200;

/** A soft ring that trails the core: springier (more lag) the further out it sits. */
function Halo({
  index,
  level,
  color,
}: {
  index: 0 | 1 | 2;
  level: SharedValue<number>;
  color: SharedValue<string>;
}) {
  const style = useAnimatedStyle(() => ({
    backgroundColor: color.value,
    transform: [
      {
        scale: withSpring(HALO_REST[index] + HALO_GROWTH[index] * level.value, {
          damping: 14 + index * 4,
          stiffness: 140 - index * 30,
        }),
      },
    ],
  }));
  return <Animated.View style={[styles.circle, { opacity: HALO_OPACITY[index] }, style]} />;
}

/** Three dots circling the core while the agent works: progress, never a waveform. */
function WorkingOrbit({ color, reducedMotion }: { color: string; reducedMotion: boolean }) {
  const turn = useSharedValue(0);
  useEffect(() => {
    if (reducedMotion) return;
    turn.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(turn);
  }, [turn, reducedMotion]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  return (
    <Animated.View style={[styles.orbit, style]}>
      {[0, 1, 2].map((dot) => (
        <View
          key={dot}
          style={[
            styles.orbitDot,
            {
              backgroundColor: color,
              opacity: 1 - dot * 0.3,
              transform: [{ rotate: `${dot * 32}deg` }, { translateY: -CORE * 0.78 }],
            },
          ]}
        />
      ))}
    </Animated.View>
  );
}

/** A slow ring pulse while the call connects: semantic "connecting", never speech. */
function ConnectingPulse({ color, reducedMotion }: { color: string; reducedMotion: boolean }) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (reducedMotion) return;
    pulse.value = withRepeat(
      withTiming(1, { duration: 1600, easing: Easing.out(Easing.quad) }),
      -1,
      false,
    );
    return () => cancelAnimation(pulse);
  }, [pulse, reducedMotion]);
  const style = useAnimatedStyle(() => ({
    opacity: reducedMotion ? 0.4 : 0.6 * (1 - pulse.value),
    transform: [{ scale: reducedMotion ? 1.4 : 1 + 0.9 * pulse.value }],
  }));
  return <Animated.View style={[styles.circle, styles.ring, { borderColor: color }, style]} />;
}

interface Props {
  mode: VisualizerMode;
  /** The call's level store; subscribed directly so level updates never re-render React. */
  levels: CallLevels | undefined;
  /** The call is still connecting: show a pulse instead of a still orb. */
  connecting?: boolean;
  palette: Palette;
}

/**
 * The call's presence. The core and halos grow only with a real signal: the caller's microphone
 * while they speak, the gateway's voice while the agent speaks. Listening breathes very slowly;
 * working circles three dots; reconnecting dims and stays still; a muted caller never moves it
 * (the mode is already "listening"). Reduced motion: levels still show, without easing, breathing,
 * or orbiting. Hidden from screen readers: the status lines say the same thing in words.
 */
export const VoiceOrb = memo(function VoiceOrb({ mode, levels, connecting, palette }: Props) {
  const reducedMotion = useReducedMotion();
  const kind = mode.kind;
  const target = orbColor(orbRole(kind), palette);
  const level = useSharedValue(0);
  const breath = useSharedValue(0);
  const color = useSharedValue(target);
  const dim = useSharedValue(kind === 'reconnecting' ? 0.45 : 1);

  useEffect(() => {
    color.value = reducedMotion ? target : withTiming(target, { duration: COLOR_MS });
    const opacity = kind === 'reconnecting' ? 0.45 : kind === 'idle' ? 0.7 : 1;
    dim.value = reducedMotion ? opacity : withTiming(opacity, { duration: COLOR_MS });
  }, [color, dim, target, kind, reducedMotion]);

  useEffect(() => {
    const apply = () => {
      const next = levels === undefined ? 0 : safeLevel(drivingLevel(kind, levels.getLevels()));
      level.value = reducedMotion ? next : withTiming(next, { duration: LEVEL_EASE_MS });
    };
    apply();
    return levels?.subscribe(apply);
  }, [levels, kind, level, reducedMotion]);

  // Listening only: a barely-there breath, slow enough never to read as speech.
  useEffect(() => {
    if (kind !== 'listening' || reducedMotion) {
      cancelAnimation(breath);
      breath.value = withTiming(0, { duration: COLOR_MS });
      return;
    }
    breath.value = withRepeat(
      withTiming(1, { duration: 3200, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    return () => cancelAnimation(breath);
  }, [kind, breath, reducedMotion]);

  const coreStyle = useAnimatedStyle(() => ({
    backgroundColor: color.value,
    transform: [{ scale: 1 + CORE_MAX_GROWTH * level.value + 0.03 * breath.value }],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    backgroundColor: color.value,
    opacity: 0.1 + 0.08 * level.value,
  }));
  const frameStyle = useAnimatedStyle(() => ({ opacity: dim.value }));

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.frame}
    >
      <Animated.View style={[styles.glow, glowStyle]} />
      <Animated.View style={[styles.frame, styles.layer, frameStyle]}>
        {([0, 1, 2] as const).map((index) => (
          <Halo key={index} index={index} level={level} color={color} />
        ))}
        {connecting === true && <ConnectingPulse color={target} reducedMotion={reducedMotion} />}
        <Animated.View style={[styles.circle, coreStyle]} />
        {kind === 'working' && (
          <WorkingOrbit color={palette.textSecondary} reducedMotion={reducedMotion} />
        )}
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  frame: {
    width: ORB_FRAME,
    height: ORB_FRAME,
    alignItems: 'center',
    justifyContent: 'center',
  },
  layer: { position: 'absolute' },
  circle: { position: 'absolute', width: CORE, height: CORE, borderRadius: radius.pill },
  ring: { backgroundColor: 'transparent', borderWidth: 2 },
  glow: {
    position: 'absolute',
    width: GLOW,
    height: GLOW,
    borderRadius: radius.pill,
    left: (ORB_FRAME - GLOW) / 2,
    top: (ORB_FRAME - GLOW) / 2,
  },
  orbit: {
    position: 'absolute',
    width: CORE,
    height: CORE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orbitDot: { position: 'absolute', width: 10, height: 10, borderRadius: radius.pill },
});
