import { beforeEach, describe, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({
  currentState: String('active'),
  listeners: new Set<(state: string) => void>(),
}));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return app.currentState;
    },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      app.listeners.add(listener);
      return { remove: () => app.listeners.delete(listener) };
    },
  },
}));
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));

import { onForeground } from './foreground';

const emit = (state: string) => app.listeners.forEach((listener) => listener(state));

beforeEach(() => {
  app.currentState = 'active';
  app.listeners.clear();
});

describe('onForeground', () => {
  it('fires once per return to the app, not on repeated active events', () => {
    const listener = vi.fn();
    const stop = onForeground(listener);
    emit('active');
    expect(listener).not.toHaveBeenCalled();
    emit('inactive');
    emit('background');
    emit('active');
    emit('active');
    expect(listener).toHaveBeenCalledTimes(1);
    emit('background');
    emit('active');
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    emit('background');
    emit('active');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('fires when subscribed while in the background', () => {
    app.currentState = 'background';
    const listener = vi.fn();
    onForeground(listener);
    emit('active');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
