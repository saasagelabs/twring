/** Voice ids for Grok voices; the server lists them only for people with their own xAI key. */
const GROK_PREFIX = 'xai-';

export interface VoiceGroup<V> {
  /** Undefined for the usual voices, which need no heading. */
  label: 'Grok' | undefined;
  voices: V[];
}

/** The usual voices first, then a "Grok" group when the server offers any. */
export function voiceGroups<V extends { id: string }>(voices: readonly V[]): VoiceGroup<V>[] {
  const usual = voices.filter((voice) => !voice.id.startsWith(GROK_PREFIX));
  const grok = voices.filter((voice) => voice.id.startsWith(GROK_PREFIX));
  const groups: VoiceGroup<V>[] = [];
  if (usual.length > 0) groups.push({ label: undefined, voices: usual });
  if (grok.length > 0) groups.push({ label: 'Grok', voices: grok });
  return groups;
}

/** True when an agent has a saved voice the server does not offer it any more. */
export function savedVoiceMissing(
  saved: string | undefined,
  voices: readonly { id: string }[],
): boolean {
  return saved !== undefined && !voices.some((voice) => voice.id === saved);
}

/** The saved voice's name; one that is no longer offered speaks Twring's default voice. */
export function savedVoiceLabel(
  saved: string,
  voices: readonly { id: string; label: string }[],
): string {
  return voices.find((voice) => voice.id === saved)?.label ?? 'Default voice';
}

/**
 * Which voice the picker shows as chosen. A saved voice the server no longer offers (a Grok voice
 * after the xAI key was removed) shows nothing chosen rather than a choice that is not there.
 */
export function pickerSelection(
  choice: string | undefined,
  saved: string | undefined,
  voices: readonly { id: string }[],
): string | undefined {
  if (choice !== undefined) return choice;
  return voices.some((voice) => voice.id === saved) ? saved : undefined;
}
