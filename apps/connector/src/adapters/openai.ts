import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { LocalAgentError, type LocalAgentAdapter, type LocalAgentEvent } from '../events';
import { withFilePaths, type LocalFile } from '../turn-files';

const deltaSchema = z.object({
  choices: z
    .array(z.object({ delta: z.object({ content: z.string().nullable().optional() }) }))
    .min(1),
});

export function checkOpenAIUrl(input: string): string {
  const url = new URL(input);
  const local =
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new Error('The OpenAI address must use https:// (http:// only for localhost).');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('The OpenAI address has unsupported URL parts.');
  return url.toString().replace(/\/+$/, '');
}

export class OpenAIAdapter implements LocalAgentAdapter {
  private key: string | undefined;
  private active: AbortController | undefined;
  constructor(
    private readonly options: {
      id: string;
      url: string;
      model: string;
      keyEnv?: string;
      resume?: string;
    },
  ) {
    this.key = options.resume;
  }
  sessionRef(): string | undefined {
    return this.key;
  }
  close(): void {
    this.active?.abort();
  }
  async *sendTurn(
    text: string,
    signal: AbortSignal,
    options?: { files?: LocalFile[] },
  ): AsyncIterable<LocalAgentEvent> {
    if (signal.aborted) return;
    this.key ??= `twring-${this.options.id}-${randomBytes(8).toString('hex')}`;
    const controller = new AbortController();
    this.active = controller;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const key = this.options.keyEnv === undefined ? undefined : process.env[this.options.keyEnv];
      const response = await fetch(`${checkOpenAIUrl(this.options.url)}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: this.options.model,
          stream: true,
          messages: [{ role: 'user', content: withFilePaths(text, options?.files ?? []) }],
          user: this.key,
        }),
        signal: controller.signal,
      });
      if (!response.ok || response.body === null)
        throw new LocalAgentError('agent_failed', `The agent returned HTTP ${response.status}`);
      const decoder = new TextDecoder();
      let pending = '';
      let done = false;
      for await (const unknownChunk of response.body) {
        const chunk: unknown = unknownChunk;
        if (!(chunk instanceof Uint8Array)) throw new Error('malformed SSE');
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 1_000_000) throw new Error('stream line too long');
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end).trimEnd();
          pending = pending.slice(end + 1);
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) throw new Error('malformed SSE');
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            done = true;
            break;
          }
          const parsed = deltaSchema.safeParse(JSON.parse(data));
          if (!parsed.success) throw new Error('malformed SSE');
          const content = parsed.data.choices[0]?.delta.content;
          if (content) yield { type: 'text', text: content };
        }
        if (done) break;
      }
      if (!done) throw new Error('incomplete SSE');
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof LocalAgentError) throw error;
      throw new LocalAgentError(
        'agent_failed',
        'The agent sent an invalid stream or could not be reached',
      );
    } finally {
      signal.removeEventListener('abort', abort);
      this.active = undefined;
      controller.abort();
    }
  }
}
