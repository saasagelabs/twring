import { describe, expect, it } from 'vitest';
import {
  aiAppEmptyChat,
  aiAppReachability,
  aiAppReplyStatus,
  canCall,
  computerCallHint,
  isAiApp,
  showComputerCallHint,
} from './ai-app';
import { agentStatusFor } from './labels';
import { agentStatusLine } from './order';

describe('AI app presentation', () => {
  const app = {
    protocol: 'mcp-app' as const,
    status: 'ready' as const,
    connector_online: false,
    connector_removed: true,
  };
  it('uses a neutral AI app status and hides calling', () => {
    expect(isAiApp(app)).toBe(true);
    expect(canCall(app)).toBe(false);
    expect(canCall({ protocol: 'cord-connector' })).toBe(true);
    expect(agentStatusLine(app)).toBe('AI app');
    expect(agentStatusFor(app)).toEqual({ label: 'AI app', tone: 'neutral' });
  });
  it('gives the owner accurate contact copy', () => {
    expect(aiAppReachability('Claude')).toBe("Claude rings and messages you. It can't take calls.");
    expect(aiAppReachability('Claude Code', true)).toBe('Claude Code rings and messages you.');
    expect(aiAppReplyStatus('Claude')).toBe('Claude reads this when it checks');
    expect(aiAppEmptyChat('Claude')).toContain('Reply anytime');
  });
  it('shows the computer call hint only for recognized coding app contacts', () => {
    for (const mcp_client of ['claude-code', 'codex', 'cursor', 'gemini-cli'] as const) {
      expect(showComputerCallHint({ protocol: 'mcp-app', mcp_client })).toBe(true);
    }
    expect(showComputerCallHint({ protocol: 'mcp-app' })).toBe(false);
    expect(showComputerCallHint({ protocol: 'mcp-app', mcp_client: 'claude' })).toBe(false);
    expect(showComputerCallHint({ protocol: 'mcp-app', mcp_client: 'chatgpt' })).toBe(false);
    expect(showComputerCallHint({ protocol: 'cord-connector', mcp_client: 'codex' })).toBe(false);
    expect(computerCallHint('Claude Code')).toEqual({
      title: 'Call Claude Code too',
      body: 'Set it up on your computer once. Then you can call it.',
      action: 'Set up calling',
    });
  });
});
