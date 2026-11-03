import { z } from 'zod';
import { mcpClientIdSchema, type McpClientKind } from '@twring/contracts';
import { newAgentId } from '../calls/ids';
import { defaultVoiceId } from '../agents/voices';
import { Mutex, type Collection } from '../store/collection';
import { revisionOf, type AgentRecord, type AgentRepository } from '../store/repositories';

export const connectedAppBlockSchema = z.object({
  user_id: z.string().min(1),
  client_id: mcpClientIdSchema,
  blocked_at: z.iso.datetime(),
  name: z.string().max(60).optional(),
});
export type ConnectedAppBlock = z.infer<typeof connectedAppBlockSchema>;

export function displayName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return 'AI app';
  const name = raw.trim();
  const lower = name.toLowerCase();
  if (lower.includes('claude code') || lower.includes('claude-code')) return 'Claude Code';
  if (lower.includes('codex')) return 'Codex';
  if (lower.includes('cursor')) return 'Cursor';
  if (lower.includes('gemini cli') || lower.includes('gemini-cli')) return 'Gemini CLI';
  if (lower.includes('claude')) return 'Claude';
  if (lower.includes('chatgpt') || lower.includes('openai')) return 'ChatGPT';
  if (lower.includes('grok') || lower.includes('xai')) return 'Grok';
  if (lower.includes('gemini')) return 'Gemini';
  return name.slice(0, 60).trim();
}

export function mcpClientKind(raw: unknown): McpClientKind | undefined {
  if (typeof raw !== 'string') return undefined;
  const lower = raw.trim().toLowerCase();
  if (lower.includes('claude code') || lower.includes('claude-code')) return 'claude-code';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('cursor')) return 'cursor';
  if (lower.includes('gemini cli') || lower.includes('gemini-cli')) return 'gemini-cli';
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('chatgpt') || lower.includes('openai')) return 'chatgpt';
  if (lower.includes('grok') || lower.includes('xai')) return 'grok';
  if (lower.includes('gemini')) return 'gemini';
  return undefined;
}

/** The owner removed this app in Connected AI apps; it stays out until they allow it again. */
export class ConnectedAppBlocked extends Error {
  constructor() {
    super(
      'This app was removed from Twring. Allow it again in Twring Settings, Connected AI apps.',
    );
    this.name = 'ConnectedAppBlocked';
  }
}

/** last_used_at is shown as a relative time; writing it at most once a minute is plenty. */
const TOUCH_EVERY_MS = 60_000;

export class McpContacts {
  private readonly createLock = new Mutex();
  constructor(
    private readonly agents: AgentRepository,
    private readonly blocks: Collection<ConnectedAppBlock>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async isBlocked(userId: string, clientId: string): Promise<boolean> {
    return (await this.blocks.read()).some(
      (row) => row.user_id === userId && row.client_id === clientId,
    );
  }

  async getOrCreate(userId: string, clientId: string): Promise<AgentRecord> {
    return this.createLock.run(async () => {
      if (await this.isBlocked(userId, clientId)) {
        throw new ConnectedAppBlocked();
      }
      const endpoint = `mcp-app://${clientId}`;
      const found = (await this.agents.list(userId)).find(
        (row) => row.protocol === 'mcp-app' && row.endpoint_url === endpoint,
      );
      if (found) return found;
      const at = this.now().toISOString();
      return this.agents.create({
        id: newAgentId(),
        user_id: userId,
        name: 'AI app',
        protocol: 'mcp-app',
        endpoint_url: endpoint,
        voice_id: defaultVoiceId(),
        status: 'ready',
        created_at: at,
        updated_at: at,
      });
    });
  }

  async recordName(userId: string, agent: AgentRecord, raw: unknown): Promise<AgentRecord> {
    const kind = mcpClientKind(raw);
    if ((typeof raw !== 'string' || !raw.trim()) && kind === undefined) return agent;
    const current = await this.agents.get(userId, agent.id);
    if (!current) return agent;
    const patch = {
      ...(!current.name_set_by_owner && { name: displayName(raw) }),
      ...(kind !== undefined && { mcp_client: kind }),
    };
    if (Object.keys(patch).length === 0) return current;
    return (
      (await this.agents.update(
        userId,
        agent.id,
        { ...patch, ifRevision: revisionOf(current) },
        this.now(),
      )) ??
      (await this.agents.get(userId, agent.id)) ??
      agent
    );
  }

  async touch(userId: string, agent: AgentRecord): Promise<void> {
    const last = agent.last_used_at === undefined ? 0 : Date.parse(agent.last_used_at);
    if (this.now().getTime() - last < TOUCH_EVERY_MS) return;
    await this.agents.update(
      userId,
      agent.id,
      { last_used_at: this.now().toISOString() },
      this.now(),
    );
  }

  async list(userId: string): Promise<{
    apps: Array<{
      agent_id?: string;
      client_id: string;
      name: string;
      blocked: boolean;
      last_used_at?: string;
    }>;
  }> {
    const agents = (await this.agents.list(userId)).filter((row) => row.protocol === 'mcp-app');
    const blocks = (await this.blocks.read()).filter((row) => row.user_id === userId);
    return {
      apps: [
        ...agents.map((row) => ({
          agent_id: row.id,
          client_id: row.endpoint_url.slice('mcp-app://'.length),
          name: row.name,
          blocked: false,
          ...(row.last_used_at && { last_used_at: row.last_used_at }),
        })),
        ...blocks.map((row) => ({
          client_id: row.client_id,
          name: row.name ?? 'AI app',
          blocked: true,
        })),
      ],
    };
  }

  async block(
    userId: string,
    clientId: string,
    remove: (agentId: string) => Promise<void>,
    knownName?: string,
  ): Promise<void> {
    await this.createLock.run(async () => {
      const contacts = (await this.agents.list(userId)).filter(
        (agent) => agent.protocol === 'mcp-app' && agent.endpoint_url === `mcp-app://${clientId}`,
      );
      // Keep the name, so the blocked row in Connected AI apps still says which app it was.
      const name = contacts[0]?.name ?? knownName;
      await this.blocks.update((rows) => ({
        items: rows.some((row) => row.user_id === userId && row.client_id === clientId)
          ? rows
          : [
              ...rows,
              {
                user_id: userId,
                client_id: clientId,
                blocked_at: this.now().toISOString(),
                ...(name !== undefined && { name }),
              },
            ],
        result: undefined,
      }));
      for (const agent of contacts) {
        await remove(agent.id);
        await this.agents.delete(userId, agent.id);
      }
    });
  }

  async allow(userId: string, clientId: string): Promise<void> {
    await this.blocks.update((rows) => ({
      items: rows.filter((row) => row.user_id !== userId || row.client_id !== clientId),
      result: undefined,
    }));
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.blocks.update((rows) => ({
      items: rows.filter((row) => row.user_id !== userId),
      result: undefined,
    }));
  }
}
