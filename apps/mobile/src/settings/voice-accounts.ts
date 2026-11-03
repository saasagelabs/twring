import type { ListeningProvider, SpeechKeyListResponse, SpeechProvider } from '@twring/contracts';

export const SPEECH_PROVIDERS: readonly SpeechProvider[] = ['deepgram', 'cartesia', 'xai'];

/** The accounts that can do the listening half of a call, in the order the choice shows them. */
export const LISTENING_PROVIDERS: readonly ListeningProvider[] = ['deepgram', 'xai'];

/** The Listening choice appears only when the server says both listening keys are saved. */
export function listeningChoiceShown(
  state: Pick<SpeechKeyListResponse, 'listening' | 'listening_choice'> | undefined,
): boolean {
  return state?.listening_choice === true;
}

const LABELS: Record<SpeechProvider, string> = {
  deepgram: 'Deepgram',
  cartesia: 'Cartesia',
  xai: 'xAI',
};

export function providerLabel(provider: SpeechProvider): string {
  return LABELS[provider];
}

const COVERS: Record<SpeechProvider, string> = {
  deepgram: 'Listening and voice',
  cartesia: 'Voice',
  xai: 'Listening and voice',
};

/** What a person's key for this provider pays for, in plain words. */
export function providerCovers(provider: SpeechProvider): string {
  return COVERS[provider];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Added on 27 Oct · ends in 4f2a`: never more of the key than its last four characters. */
export function addedLine(added: { last4: string; added_at: string }): string {
  const date = new Date(added.added_at);
  const day = Number.isNaN(date.getTime())
    ? ''
    : ` on ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return `Added${day} · ends in ${added.last4}`;
}

export function removeConfirmMessage(provider: SpeechProvider): string {
  return `Remove your ${providerLabel(provider)} key? Twring's own voice account is used again.`;
}

/** The call-ended copy when the gateway says a person's own key was refused. */
export function keyRefusedCallMessage(provider: SpeechProvider): string {
  return `Your ${providerLabel(provider)} key was refused, so the call ended. Update it in Settings, Your own voice accounts.`;
}
