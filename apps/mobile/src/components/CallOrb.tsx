import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import type { OrbLook } from '@/call/wave';
import { callPalette as palette } from '@/theme/tokens';

import { MiniWave } from './MiniWave';

export function CallOrb({ mode }: { mode: OrbLook }) {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(progress);
    progress.value = 0;
    if (reducedMotion || (mode !== 'you' && mode !== 'working')) return;
    progress.value = withRepeat(
      withTiming(1, {
        duration: mode === 'you' ? 1500 : 3200,
        easing: mode === 'you' ? Easing.out(Easing.quad) : Easing.inOut(Easing.sin),
      }),
      -1,
      mode === 'working',
    );
    return () => cancelAnimation(progress);
  }, [mode, progress, reducedMotion]);

  const pulse = useAnimatedStyle(() => ({
    opacity: mode === 'you' && !reducedMotion ? 1 - progress.value : 0,
    transform: [{ scale: 1 + progress.value * 0.45 }],
  }));
  const breath = useAnimatedStyle(() => ({
    opacity: mode === 'working' && !reducedMotion ? 0.53 + progress.value * 0.47 : 1,
  }));
  const waveColor =
    mode === 'you'
      ? palette.onAccent
      : mode === 'agent' || mode === 'working'
        ? palette.speaking
        : mode === 'reconnecting'
          ? palette.warning
          : mode === 'connecting'
            ? palette.textMuted
            : palette.accent;

  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.frame}
    >
      {mode === 'you' && <Animated.View style={[styles.pulse, pulse]} />}
      <Animated.View style={[styles.orb, lookStyle(mode), breath]}>
        <MiniWave size={22} color={waveColor} active={mode === 'you' || mode === 'agent'} />
      </Animated.View>
    </View>
  );
}

function lookStyle(mode: OrbLook) {
  switch (mode) {
    case 'you':
      return styles.you;
    case 'agent':
      return styles.agent;
    case 'working':
      return styles.working;
    case 'connecting':
      return styles.connecting;
    case 'reconnecting':
      return styles.reconnecting;
    case 'idle':
      return styles.idle;
  }
}

const styles = StyleSheet.create({
  frame: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  orb: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulse: {
    position: 'absolute',
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: palette.accent,
  },
  you: { backgroundColor: palette.accent, boxShadow: '0 0 28px rgba(25,214,242,0.8)' },
  agent: {
    backgroundColor: 'rgba(232,234,238,0.06)',
    borderWidth: 2,
    borderColor: palette.speaking,
    boxShadow: '0 0 22px rgba(232,234,238,0.33)',
  },
  working: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1.5,
    borderColor: palette.speaking,
  },
  idle: { backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.borderStrong },
  connecting: { borderWidth: 1.5, borderColor: palette.textMuted },
  reconnecting: {
    backgroundColor: 'rgba(255,181,71,0.06)',
    borderWidth: 1.5,
    borderColor: palette.warning,
    boxShadow: '0 0 18px rgba(255,181,71,0.27)',
  },
});
