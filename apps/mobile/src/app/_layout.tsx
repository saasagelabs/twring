import { registerGlobals } from '@livekit/react-native';
import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { LogBox, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useAuth } from '@/auth';
import { checkAccess, useAccess, useAccessIdentity } from '@/access/store';
import { mobileEnv } from '@/config/env';
import { initSentry, setCrashUser, wrapRoot } from '@/observability/sentry';
import { callBackgroundService } from '@/platform/call-service';
import { useRingCoordinator } from '@/ring/service';
import { watchServerIdentity } from '@/servers/switching';
import { FONT_ASSETS } from '@/theme/fonts';
import { callPalette } from '@/theme/tokens';
import { ActiveCallBar } from '@/components/ActiveCallBar';

// WebRTC globals must exist before any LiveKit code runs.
registerGlobals();

// LiveKit logs expected network churn (drops, retries, closed peers) at error level. The call state
// machine already handles and shows these; in development builds the LogBox toast they raise sat
// on top of the End button. Release builds have no LogBox.
if (__DEV__) {
  LogBox.ignoreLogs([
    /error reading from signal stream/,
    /fetch failed: java\.net\./,
    /could not createOffer with closed peer connection/,
    /ping timeout triggered/,
  ]);
}
initSentry(mobileEnv);
// No call exists at JS startup: clear a call service orphaned by a JS reload (ADR-019).
void callBackgroundService.stop().catch(() => undefined);
// Keep the splash up until the stored session is read, so no protected screen flashes (ADR-021).
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(FONT_ASSETS);
  const [fontsTimedOut, setFontsTimedOut] = useState(false);
  const auth = useAuth();
  const access = useAccess();
  const accessIdentity = useAccessIdentity();
  // Also loading until the saved servers are read (useAuth waits for them).
  const loading = auth.status === 'loading';
  const fontsReady = fontsLoaded || fontError !== null || fontsTimedOut;
  // Sign-in off (development only) lets the app run against an AUTH_MODE=dev gateway.
  const signedIn = auth.status === 'signed_in' || auth.status === 'disabled';
  const sameAccount =
    auth.status === 'disabled' || (auth.status === 'signed_in' && accessIdentity === auth.userId);
  const member = signedIn && sameAccount && access.status === 'member';
  const accessPending =
    signedIn && (!sameAccount || access.status === 'unknown' || access.status === 'checking');

  useEffect(() => {
    void checkAccess(auth);
  }, [auth]);

  // A self-hosted server is re-checked at start and on return to the front.
  useEffect(() => watchServerIdentity(), []);

  useEffect(() => {
    // Incoming calls must not wait longer than 1.5 seconds for optional font assets.
    const timeout = setTimeout(() => setFontsTimedOut(true), 1500);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!loading && !accessPending && fontsReady) SplashScreen.hide();
  }, [loading, accessPending, fontsReady]);

  // Crash reports carry only a hash of the signed-in user.
  const userId = auth.status === 'signed_in' ? auth.userId : undefined;
  useEffect(() => setCrashUser(userId), [userId]);

  // Agents can ring this phone while someone is signed in (Android).
  useRingCoordinator(member && !loading);

  if (loading || accessPending || !fontsReady) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={DarkTheme}>
        <View style={{ flex: 1 }}>
          <ActiveCallBar />
          <Stack screenOptions={{ headerShown: false }}>
            {/*
          Every app screen is listed here: a screen left out would be reachable while signed out.
          Signed out, the only screens are Sign in, Pair with your own server and Privacy. Pair is
          also open signed in, so a pair link always lands: it asks to sign out first.
        */}
            <Stack.Protected guard={member}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
              <Stack.Screen name="connect" />
              <Stack.Screen name="dev-components" />
              <Stack.Screen name="agents/[id]/index" />
              <Stack.Screen name="agents/[id]/edit" />
              <Stack.Screen name="chats/[agentId]" />
              <Stack.Screen name="settings/connected-apps" />
              <Stack.Screen name="settings/feedback" />
              <Stack.Screen name="settings/voice-accounts" />
              <Stack.Screen name="agents/[id]/voice" />
              <Stack.Screen name="agents/[id]/words" />
              {/*
            The active call resists accidental dismissal: no swipe-to-close. It fades in over a dark
            background (the call is always dark); other pushes keep the platform default.
          */}
              <Stack.Screen
                name="call"
                options={{
                  presentation: 'fullScreenModal',
                  animation: 'fade',
                  gestureEnabled: false,
                  contentStyle: { backgroundColor: callPalette.background },
                }}
              />
              {/* An agent ringing: over everything, and over the lock screen while it rings. */}
              <Stack.Screen
                name="incoming/[inviteId]"
                options={{
                  presentation: 'fullScreenModal',
                  animation: 'fade',
                  gestureEnabled: false,
                  contentStyle: { backgroundColor: callPalette.background },
                }}
              />
            </Stack.Protected>
            <Stack.Protected guard={signedIn && !member}>
              <Stack.Screen name="waitlist" options={{ gestureEnabled: false }} />
            </Stack.Protected>
            <Stack.Protected guard={!signedIn}>
              <Stack.Screen name="sign-in" options={{ gestureEnabled: false }} />
            </Stack.Protected>
            <Stack.Screen name="pair" />
            <Stack.Screen name="privacy" />
          </Stack>
        </View>
        <StatusBar style="light" />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

export default wrapRoot(RootLayout);
