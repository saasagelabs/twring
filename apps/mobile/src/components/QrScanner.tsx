import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef } from 'react';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { TextButton } from '@/components/TextButton';
import { font } from '@/theme/fonts';
import { radius, space, usePalette } from '@/theme/tokens';

export interface ScannerCopy {
  needCamera: string;
  cameraOff: string;
  viewfinder: string;
  typeInstead: string;
}

function Support({ children }: { children: string }) {
  const palette = usePalette();
  return <Text style={[styles.support, { color: palette.textSecondary }]}>{children}</Text>;
}

function ScannerOverlay() {
  const palette = usePalette();
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(progress);
      progress.value = 0;
    } else {
      progress.value = withRepeat(withTiming(1, { duration: 1200 }), -1, true);
    }
    return () => cancelAnimation(progress);
  }, [progress, reduceMotion]);
  const line = useAnimatedStyle(() => ({ transform: [{ translateY: progress.value * 198 }] }));
  return (
    <View pointerEvents="none" style={styles.scannerOverlay}>
      <View style={[styles.bracket, styles.topLeft, { borderColor: palette.accent }]} />
      <View style={[styles.bracket, styles.topRight, { borderColor: palette.accent }]} />
      <View style={[styles.bracket, styles.bottomLeft, { borderColor: palette.accent }]} />
      <View style={[styles.bracket, styles.bottomRight, { borderColor: palette.accent }]} />
      {!reduceMotion && (
        <Animated.View style={[styles.scanLine, { backgroundColor: palette.accent }, line]} />
      )}
    </View>
  );
}

/** The in-app QR scanner, with a clear way out when the camera is not allowed. */
export function QrScanner({
  copy,
  busy,
  attempt,
  onScanned,
  onTypeInstead,
}: {
  copy: ScannerCopy;
  busy: boolean;
  /** Changes after each failed try, so the scanner listens again after a short pause. */
  attempt: unknown;
  onScanned: (data: string) => void;
  onTypeInstead: () => void;
}) {
  const palette = usePalette();
  const [permission, requestPermission] = useCameraPermissions();
  // One scan at a time: the camera reports the same code many times a second.
  const handled = useRef(false);
  useEffect(() => {
    if (busy) return;
    // A pause first, so a wrong code still in view is not checked again many times a second.
    const timer = setTimeout(() => {
      handled.current = false;
    }, 2_000);
    return () => clearTimeout(timer);
  }, [busy, attempt]);

  if (permission === null) {
    return <ActivityIndicator accessibilityLabel="Checking camera access" />;
  }
  if (!permission.granted) {
    return (
      <View style={styles.block}>
        <Support>{permission.canAskAgain ? copy.needCamera : copy.cameraOff}</Support>
        {permission.canAskAgain && (
          <PrimaryButton label="Allow camera" onPress={() => void requestPermission()} />
        )}
        <View style={styles.inline}>
          <TextButton label={copy.typeInstead} onPress={onTypeInstead} />
        </View>
      </View>
    );
  }
  return (
    <View style={styles.block}>
      <View
        accessibilityLabel={copy.viewfinder}
        style={[styles.camera, { borderColor: palette.border }]}
      >
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={
            busy
              ? undefined
              : ({ data }) => {
                  if (handled.current) return;
                  handled.current = true;
                  onScanned(data);
                }
          }
        />
        <ScannerOverlay />
      </View>
      {busy && <ActivityIndicator accessibilityLabel="Checking the code" />}
      <View style={styles.inline}>
        <TextButton label={copy.typeInstead} onPress={onTypeInstead} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: space.lg },
  inline: { flexDirection: 'row' },
  support: { fontFamily: font.body, fontSize: 15, lineHeight: 22.5 },
  camera: {
    width: 260,
    height: 260,
    alignSelf: 'center',
    borderRadius: radius.xl,
    borderWidth: 1,
    overflow: 'hidden',
  },
  scannerOverlay: { position: 'absolute', width: 200, height: 200, top: 30, left: 30 },
  bracket: {
    position: 'absolute',
    width: 32,
    height: 32,
    borderWidth: 0,
    boxShadow: '0 0 10px #19D6F2',
  },
  topLeft: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3 },
  topRight: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3 },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3 },
  bottomRight: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3 },
  scanLine: {
    position: 'absolute',
    left: 4,
    right: 4,
    top: 0,
    height: 2,
    boxShadow: '0 0 10px #19D6F2',
  },
});
