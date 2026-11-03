export const COMPOSER_LIMIT = 4000;
export function canSend(text: string, files = 0): boolean {
  return text.trim().length > 0 || files > 0;
}
export function composerAction(
  text: string,
  disabled: boolean,
  files = 0,
): 'send' | 'mic' | 'none' {
  return disabled ? 'none' : canSend(text, files) ? 'send' : 'mic';
}
