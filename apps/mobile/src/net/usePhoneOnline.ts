import { useNetInfo, type NetInfoState } from '@react-native-community/netinfo';

/** Shown in place of the computer's Online/Offline while this phone has no network. */
export const PHONE_OFFLINE_LABEL = 'Waiting for network';

/**
 * False only when the phone reports no connection. Unknown (null, as at start) counts as
 * online, so headers never flicker to offline before the first reading.
 */
export function phoneOnlineFrom(state: Pick<NetInfoState, 'isConnected'>): boolean {
  return state.isConnected !== false;
}

/** Whether this phone itself has a network connection (the computer's state is separate). */
export function usePhoneOnline(): boolean {
  return phoneOnlineFrom(useNetInfo());
}
