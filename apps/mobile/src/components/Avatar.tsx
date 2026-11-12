import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { avatarInitial } from '@/theme/call-visuals';
import { cachedAgentAvatar } from '@/agents/avatar-cache';
import { twringApi } from '@/api';
import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';

function PulseRing({
  size,
  delay,
  reducedMotion,
}: {
  size: number;
  delay: number;
  reducedMotion: boolean;
}) {
  const progress = useSharedValue(0);
  useEffect(() => {
    if (reducedMotion) {
      cancelAnimation(progress);
      progress.value = 0;
    } else {
      progress.value = withDelay(delay, withRepeat(withTiming(1, { duration: 1800 }), -1));
    }
    return () => cancelAnimation(progress);
  }, [delay, progress, reducedMotion]);
  const motion = useAnimatedStyle(() => ({
    opacity: reducedMotion ? 0.55 : 0.7 * (1 - progress.value),
    transform: [{ scale: reducedMotion ? (delay ? 1.2 : 1) : 1 + progress.value * 0.4 }],
  }));
  return (
    <Animated.View
      style={[
        styles.ring,
        { width: size + 16, height: size + 16, borderRadius: (size + 16) / 2 },
        motion,
      ]}
    />
  );
}

/** A glass initial with optional presence indicator. Decorative: the name is always nearby. */
export function Avatar({
  id,
  name,
  avatarVersion,
  size = 52,
  online,
  ringing = false,
}: {
  id: string;
  name: string;
  avatarVersion?: number;
  size?: number;
  online?: boolean;
  ringing?: boolean;
}) {
  const palette = usePalette();
  const [photo, setPhoto] = useState<{ version: number; uri: string } | undefined>();
  useEffect(() => {
    let active = true;
    const api = twringApi();
    if (avatarVersion === undefined || api === undefined) return;
    void cachedAgentAvatar(api, id, avatarVersion).then(
      (uri) => {
        if (active) setPhoto({ version: avatarVersion, uri });
      },
      () => {
        if (active) setPhoto(undefined);
      },
    );
    return () => {
      active = false;
    };
  }, [avatarVersion, id]);
  const reducedMotion = useReducedMotion();
  const dotSize = Math.max(8, size * 0.2);
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ width: size, height: size }}
    >
      {ringing && <PulseRing size={size} delay={0} reducedMotion={reducedMotion} />}
      {ringing && <PulseRing size={size} delay={900} reducedMotion={reducedMotion} />}
      <View
        style={[
          styles.avatar,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: palette.surfaceRaised,
            borderColor: online ? palette.accent : palette.border,
            borderWidth: online ? 1.5 : 1,
            boxShadow: online ? '0 0 12px rgba(25,214,242,0.27)' : undefined,
          },
        ]}
      >
        {photo !== undefined && photo.version === avatarVersion ? (
          <Image
            source={{ uri: photo.uri }}
            style={{ width: size, height: size, borderRadius: size / 2 }}
            onError={() => setPhoto(undefined)}
          />
        ) : (
          <Text
            allowFontScaling={false}
            style={{ fontFamily: font.title, color: palette.textPrimary, fontSize: size * 0.42 }}
          >
            {avatarInitial(name)}
          </Text>
        )}
      </View>
      {online !== undefined && !ringing && (
        <View
          style={[
            styles.dot,
            {
              width: dotSize,
              height: dotSize,
              borderRadius: dotSize / 2,
              right: size * 0.02,
              bottom: size * 0.02,
              backgroundColor: online ? palette.accent : '#3A3D42',
              boxShadow: online ? `0 0 8px ${palette.accent}` : undefined,
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', top: -8, left: -8, borderWidth: 2, borderColor: '#E8EAEE' },
  dot: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#000000',
  },
});
