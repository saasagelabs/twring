export type PickerKind = 'Photos' | 'Camera' | 'File';

/** iOS presents the next controller only after React Native dismisses the sheet. */
export function pickerSelection(
  platform: string,
  kind: PickerKind,
): {
  pending: PickerKind | null;
  launchNow: PickerKind | null;
} {
  return platform === 'ios'
    ? { pending: kind, launchNow: null }
    : { pending: null, launchNow: kind };
}

export function takeDismissedPicker(pending: PickerKind | null): PickerKind | null {
  return pending;
}

/**
 * Holds the picker chosen while the sheet closes. `take` returns it once, so whichever comes first,
 * the sheet's dismissal or the fallback timer, launches it and the other does nothing.
 */
export function pickerQueue(): { hold(kind: PickerKind | null): void; take(): PickerKind | null } {
  let held: PickerKind | null = null;
  return {
    hold(kind) {
      held = kind;
    },
    take() {
      const kind = held;
      held = null;
      return kind;
    },
  };
}
