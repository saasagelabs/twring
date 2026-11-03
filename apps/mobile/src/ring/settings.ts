import type { RingSettings } from './protocol';

/** What the Settings screen edits. Times are "HH:MM" in the phone's time zone. */
export interface RingSettingsForm {
  dnd: boolean;
  quietEnabled: boolean;
  start: string;
  end: string;
  afterCallResult?: 'ring' | 'message';
}

export const DEFAULT_QUIET_START = '22:00';
export const DEFAULT_QUIET_END = '07:00';

export function formFromSettings(settings: RingSettings): RingSettingsForm {
  return {
    dnd: settings.dnd,
    quietEnabled: settings.quiet_hours?.enabled ?? false,
    start: settings.quiet_hours?.start ?? DEFAULT_QUIET_START,
    end: settings.quiet_hours?.end ?? DEFAULT_QUIET_END,
    afterCallResult: settings.after_call_result ?? 'ring',
  };
}

/** "7:5" is not a time; "7:05", "07:05" and "0705" are 07:05. Undefined when not a time. */
export function normalizeClock(text: string): string | undefined {
  const match = /^\s*(\d{1,2}):?(\d{2})\s*$/.exec(text);
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export type SettingsCheck =
  { ok: true; settings: RingSettings } | { ok: false; field: 'start' | 'end' };

/**
 * The request for `PUT /v1/me/ring-settings`. Quiet hours are only sent once turned on at least
 * once (`previous` had them, or they are on now), so the times are kept when switched off.
 */
export function settingsFromForm(
  form: RingSettingsForm,
  timeZone: string,
  previous?: RingSettings,
  chatsAvailable = false,
): SettingsCheck {
  const everSet = form.quietEnabled || (previous?.quiet_hours ?? null) !== null;
  const afterCall = chatsAvailable
    ? { after_call_result: form.afterCallResult ?? 'ring' }
    : previous?.after_call_result === undefined
      ? {}
      : { after_call_result: previous.after_call_result };
  if (!everSet) return { ok: true, settings: { dnd: form.dnd, quiet_hours: null, ...afterCall } };
  const start = normalizeClock(form.start);
  if (start === undefined) return { ok: false, field: 'start' };
  const end = normalizeClock(form.end);
  if (end === undefined) return { ok: false, field: 'end' };
  return {
    ok: true,
    settings: {
      dnd: form.dnd,
      ...afterCall,
      quiet_hours: { enabled: form.quietEnabled, start, end, tz: timeZone },
    },
  };
}

/** Resolve a save to the form the screen should display, including on a failed PUT. */
export async function persistRingSettings(
  request: RingSettings,
  previous: RingSettings,
  update: (settings: RingSettings) => Promise<RingSettings>,
): Promise<
  | { ok: true; settings: RingSettings; form: RingSettingsForm }
  | { ok: false; error: unknown; form: RingSettingsForm }
> {
  try {
    const settings = await update(request);
    return { ok: true, settings, form: formFromSettings(settings) };
  } catch (error) {
    return { ok: false, error, form: formFromSettings(previous) };
  }
}

/** The phone's IANA time zone (e.g. "Asia/Kolkata"); UTC when the runtime cannot say. */
export function deviceTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** One line for the Settings row. */
export function ringSummary(settings: RingSettings): string {
  if (settings.dnd) return 'Do not disturb is on. Agents cannot ring you.';
  const quiet = settings.quiet_hours;
  if (quiet?.enabled === true) return `Quiet from ${quiet.start} to ${quiet.end}.`;
  return 'Agents can ring you any time.';
}
