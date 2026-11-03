import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { serveMcp } from './mcp';

describe('stdio MCP', () => {
  it('answers protocol methods and routes validated tools with JSON only', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => chunks.push(chunk));
    const calls: string[] = [];
    const running = serveMcp(
      input,
      output,
      {
        ring: (reason, wait) => {
          calls.push(`ring:${reason}:${wait}`);
          return Promise.resolve('answered');
        },
        message: (message, files) => {
          calls.push(`message:${message}:${files.join(',')}`);
          return Promise.resolve('sent');
        },
        status: () => Promise.resolve('Linked; online.'),
        words: () => Promise.resolve('Calls will listen for: Gowri.'),
      },
      '0.4.0',
    );
    const send = (id: number, method: string, params?: unknown) =>
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    send(1, 'initialize', { protocolVersion: '2025-06-18' });
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    send(2, 'tools/list');
    send(3, 'tools/call', { name: 'ring_owner', arguments: { reason: 'Help', wait: true } });
    send(4, 'tools/call', { name: 'message_owner', arguments: { files: ['report.pdf'] } });
    send(5, 'tools/call', { name: 'message_owner', arguments: {} });
    send(6, 'tools/call', { name: 'twring_status', arguments: {} });
    send(7, 'ping');
    send(8, 'unknown');
    input.end();
    await running;
    const lines = chunks
      .join('')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            id: number;
            result?: Record<string, unknown>;
            error?: { code: number };
          },
      );
    expect(lines).toHaveLength(8);
    expect(lines[0]?.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'twring', version: '0.4.0' },
    });
    expect(
      (lines[1]?.result?.tools as { name: string; inputSchema: unknown }[]).map(
        (tool) => tool.name,
      ),
    ).toEqual(['ring_owner', 'message_owner', 'twring_status', 'add_words']);
    expect(
      (lines[1]?.result?.tools as { inputSchema: { type: string } }[]).every(
        (tool) => tool.inputSchema.type === 'object',
      ),
    ).toBe(true);
    expect(calls).toEqual(['ring:Help:true', 'message::report.pdf']);
    expect(lines[4]?.result).toMatchObject({ isError: true });
    expect(lines[7]?.error?.code).toBe(-32601);
  });

  it('adds words the agent’s calls should hear right, and refuses an empty list', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => chunks.push(chunk));
    const calls: string[] = [];
    const running = serveMcp(
      input,
      output,
      {
        ring: () => Promise.resolve('answered'),
        message: () => Promise.resolve('sent'),
        status: () => Promise.resolve('Linked; online.'),
        words: (words) => {
          calls.push(words.join('|'));
          return Promise.resolve(`Calls will listen for: ${words.join(', ')}.`);
        },
      },
      '0.4.0',
    );
    const send = (id: number, params: unknown) =>
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params })}\n`);
    send(1, { name: 'add_words', arguments: { words: ['Gowri', 'Lightsail'] } });
    send(2, { name: 'add_words', arguments: { words: [] } });
    send(3, { name: 'add_words', arguments: { words: ['x'.repeat(51)] } });
    input.end();
    await running;
    const lines = chunks
      .join('')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { result?: { isError?: boolean; content: { text: string }[] } },
      );
    expect(calls).toEqual(['Gowri|Lightsail']);
    expect(lines[0]?.result?.content[0]?.text).toBe('Calls will listen for: Gowri, Lightsail.');
    expect(lines[1]?.result?.isError).toBe(true);
    expect(lines[2]?.result?.isError).toBe(true);
  });
});
