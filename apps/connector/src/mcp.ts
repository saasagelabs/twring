import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { MAX_AGENT_KEYTERMS, agentKeytermSchema } from '@twring/contracts';

const ringArgs = z.object({ reason: z.string().min(1).max(140), wait: z.boolean().optional() });
const wordsArgs = z.object({
  words: z.array(agentKeytermSchema).min(1).max(MAX_AGENT_KEYTERMS),
});
const messageArgs = z
  .object({ text: z.string().optional(), files: z.array(z.string()).max(5).optional() })
  .refine((v) => Boolean(v.text?.trim()) || Boolean(v.files?.length));
const tools = [
  {
    name: 'ring_owner',
    description:
      "Ring your owner's phone through Twring, like a phone call. Use it only when they must talk or decide now, or asked you to ring: a finished task they want to hear about, or a decision only they can make. 'reason' is spoken to them when they answer (at most 140 characters, one standalone sentence). With 'wait', returns the outcome: answered, declined, missed, refused or cancelled. Don't retry a refusal in a loop. For results they can read later, use message_owner instead.",
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', maxLength: 140 }, wait: { type: 'boolean' } },
      required: ['reason'],
    },
  },
  {
    name: 'message_owner',
    description:
      "Send your owner a message in their Twring chat, without a call; they get a notification. Use it for results, reports, links and anything they can read later. 'files' are local paths: up to five photos, PDFs or text files, 10 MB each.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      },
    },
  },
  {
    name: 'twring_status',
    description:
      'Check whether this computer is linked to Twring and online, and which agents it offers.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_words',
    description:
      "Teach Twring words it mishears when your owner speaks to you (calls and voice notes): their name, people, projects, places or product names. Up to 40 words or short phrases (50 characters each) per agent; the owner can change them on the agent's Words page in the app. New words apply from the next call or voice note.",
    inputSchema: {
      type: 'object',
      properties: {
        words: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 50 },
          minItems: 1,
          maxItems: 40,
        },
      },
      required: ['words'],
    },
  },
] as const;

export interface McpHandlers {
  ring(reason: string, wait: boolean): Promise<string>;
  message(text: string, files: string[]): Promise<string>;
  status(): Promise<string>;
  words(words: string[]): Promise<string>;
}

export async function serveMcp(
  input: Readable,
  output: Writable,
  handlers: McpHandlers,
  version: string,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const write = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
  for await (const line of lines) {
    let request: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } });
      continue;
    }
    const { id, method } = request;
    if (method === 'notifications/initialized') continue;
    if (id === undefined) continue;
    const answer = (result: unknown) => write({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      const params = request.params as { protocolVersion?: unknown } | undefined;
      const known = ['2025-06-18', '2025-03-26', '2024-11-05'];
      answer({
        protocolVersion: known.includes(String(params?.protocolVersion))
          ? params?.protocolVersion
          : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'twring', version },
      });
    } else if (method === 'ping') answer({});
    else if (method === 'tools/list') answer({ tools });
    else if (method === 'tools/call') {
      const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
      try {
        let result: string;
        switch (params?.name) {
          case 'ring_owner': {
            const args = ringArgs.parse(params.arguments);
            result = await handlers.ring(args.reason, args.wait ?? false);
            break;
          }
          case 'message_owner': {
            const args = messageArgs.parse(params.arguments);
            result = await handlers.message(args.text ?? '', args.files ?? []);
            break;
          }
          case 'twring_status':
            result = await handlers.status();
            break;
          case 'add_words':
            result = await handlers.words(wordsArgs.parse(params.arguments).words);
            break;
          default:
            throw new Error('Unknown Twring tool.');
        }
        answer({ content: [{ type: 'text', text: result }] });
      } catch (error) {
        answer({
          isError: true,
          content: [
            {
              type: 'text',
              text:
                error instanceof z.ZodError
                  ? 'Check the tool arguments and try again.'
                  : error instanceof Error
                    ? error.message
                    : 'The tool failed.',
            },
          ],
        });
      }
    } else write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }
}
