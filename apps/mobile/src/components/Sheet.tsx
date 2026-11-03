import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';

export function Sheet({
  visible,
  title,
  onClose,
  onDismiss,
  children,
}: {
  visible: boolean;
  title?: string;
  onClose: () => void;
  onDismiss?: () => void;
  children: ReactNode;
}) {
  const palette = usePalette();
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(0);
  useEffect(() => {
    if (visible) {
      progress.value = 0;
      progress.value = withTiming(1, { duration: reducedMotion ? 250 : 300 });
    }
  }, [progress, reducedMotion, visible]);
  const motion = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: reducedMotion ? 0 : (1 - progress.value) * 320 }],
  }));
  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={onClose}
      onDismiss={onDismiss}
    >
      <View style={styles.modal}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close sheet"
          onPress={onClose}
          style={styles.overlay}
        />
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { backgroundColor: palette.sheet, borderColor: palette.border },
            motion,
          ]}
        >
          <View style={styles.handle} />
          {title && <Text style={[styles.title, { color: palette.textPrimary }]}>{title}</Text>}
          <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modal: { flex: 1, justifyContent: 'flex-end' },
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.7)' },
  sheet: {
    maxHeight: '80%',
    paddingTop: 12,
    paddingBottom: 26,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.2)',
    marginBottom: 16,
  },
  title: { fontFamily: font.title, fontSize: 20, letterSpacing: -0.4, paddingHorizontal: 24 },
  content: { paddingTop: 18, paddingHorizontal: 22 },
});
