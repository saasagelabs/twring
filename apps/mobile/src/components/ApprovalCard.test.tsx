import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock('../platform/haptics', () => ({ playApprovalFeedback: () => undefined }));
vi.mock('../theme/tokens', () => ({
  callPalette: {},
  radius: { xl: 0 },
  space: { md: 0, lg: 0 },
  type: { microLabel: {}, title: {}, body: {}, mono: {}, caption: {} },
}));
vi.mock('./GhostButton', () => ({ GhostButton: () => null }));
vi.mock('./PrimaryButton', () => ({ PrimaryButton: () => null }));
vi.mock('./Sheet', () => ({ Sheet: () => null }));
vi.mock('./StatusDot', () => ({ StatusDot: () => null }));

import { approvalDetails } from './ApprovalCard';

describe('approval details', () => {
  it('offers View details when a description exists and keeps the full text for the sheet', () => {
    const title = 'Run the full deploy command for the production service';
    const description = `deploy --region=example ${'--option=value '.repeat(30)}`;
    expect(
      approvalDetails({
        id: 'approval-1',
        agentName: 'Agent',
        action: 'run_command',
        title,
        description,
        expiresAt: 1000,
      }),
    ).toEqual({ title, description, showDetails: true });
  });

  it('also offers details for a title without a description', () => {
    expect(
      approvalDetails({
        id: 'approval-2',
        agentName: 'Agent',
        action: 'other',
        title: 'A very long title',
        expiresAt: 1000,
      }).showDetails,
    ).toBe(true);
  });
});
