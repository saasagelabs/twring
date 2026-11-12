import type { Attachment } from '@twring/contracts';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { font } from '@/theme/fonts';
import { type } from '@/theme/tokens';

export function ImageViewer({
  file,
  source,
  onClose,
  onShare,
}: {
  file?: Attachment;
  source?: { uri: string; headers?: Record<string, string> };
  onClose: () => void;
  onShare: () => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [note, setNote] = useState('');
  return (
    <Modal
      visible={!!file}
      animationType={reduced ? 'none' : 'fade'}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* A Modal renders outside the app's root view on Android: gestures need their own root. */}
      <GestureHandlerRootView style={styles.screen}>
        <View style={[styles.controls, { paddingTop: insets.top + 8 }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close photo"
            onPress={onClose}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Close</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Share photo"
            onPress={() =>
              void onShare().catch(() => setNote("Couldn't share that photo. Try again."))
            }
            style={styles.button}
          >
            <Text style={styles.buttonText}>Share</Text>
          </Pressable>
        </View>
        {file && source && (
          <ZoomablePhoto key={file.id} source={source} name={file.name} reduced={reduced} />
        )}
        {!!note && (
          <Text accessibilityLiveRegion="polite" style={styles.note}>
            {note}
          </Text>
        )}
      </GestureHandlerRootView>
    </Modal>
  );
}

function ZoomablePhoto({
  source,
  name,
  reduced,
}: {
  source: { uri: string; headers?: Record<string, string> };
  name: string;
  reduced: boolean;
}) {
  const scale = useSharedValue(1);
  const saved = useSharedValue(1);
  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = Math.max(1, Math.min(4, saved.value * event.scale));
    })
    .onEnd(() => {
      saved.value = scale.value;
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const next = scale.value > 1 ? 1 : 2;
      scale.value = withTiming(next, { duration: reduced ? 0 : 180 });
      saved.value = next;
    });
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, doubleTap)}>
      <Animated.View style={[styles.photo, style]}>
        <Image
          source={source}
          cachePolicy="memory"
          contentFit="contain"
          style={StyleSheet.absoluteFill}
          accessibilityLabel={`Photo, ${name}`}
        />
      </Animated.View>
    </GestureDetector>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
  controls: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  button: { minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  buttonText: { color: '#fff', fontFamily: font.bodyEmphasis, fontSize: type.body.fontSize },
  photo: { width: '100%', height: '75%' },
  note: { color: '#fff', fontFamily: font.body, fontSize: type.body.fontSize, textAlign: 'center' },
});
