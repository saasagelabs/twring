import type { ApprovalAction } from '@twring/contracts';

/** Fixed action wording shared with the gateway's spoken approval prompt (ADR-029). */
export function approvalPhrase(action: ApprovalAction): string {
  switch (action) {
    case 'edit_files':
      return 'change files';
    case 'delete_files':
      return 'delete files';
    case 'run_command':
      return 'run a command';
    case 'read_files':
      return 'read files';
    case 'fetch_web':
      return 'open a web page';
    case 'other':
      return 'do something that needs your OK';
  }
}

/** Whole seconds left, rounded up like the incoming-call countdown. */
export function approvalCountdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
