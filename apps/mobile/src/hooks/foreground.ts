import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * Calls `listener` each time the app comes back to the foreground (any state to 'active'), once
 * per return. Returns the unsubscribe.
 */
export function onForeground(listener: () => void): () => void {
  let last: AppStateStatus = AppState.currentState;
  const subscription = AppState.addEventListener('change', (next) => {
    const returning = next === 'active' && last !== 'active';
    last = next;
    if (returning) listener();
  });
  return () => subscription.remove();
}

/**
 * Runs `refresh` when the screen gains focus and when the app returns to the foreground while it
 * is focused, so a screen never shows what changed elsewhere as if it had not. `refresh` may
 * return a cleanup (an abort) that runs before the next refresh and on blur.
 */
export function useFocusRefresh(refresh: () => (() => void) | void): void {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  useFocusEffect(
    useCallback(() => {
      let cleanup = latest.current();
      const stop = onForeground(() => {
        cleanup?.();
        cleanup = latest.current();
      });
      return () => {
        stop();
        cleanup?.();
      };
    }, []),
  );
}
