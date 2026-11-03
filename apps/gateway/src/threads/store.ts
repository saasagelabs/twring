/* eslint-disable @typescript-eslint/require-await -- Keep the repository API async for a future database implementation. */
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  MAX_MESSAGES_PER_THREAD,
  FILE_QUOTA_BYTES,
  FILES_PER_DAY,
  type Attachment,
  MAX_QUEUED_PER_THREAD,
  MAX_STORED_AGENT_MESSAGE_CHARS,
  QUEUED_MESSAGE_TTL_MS,
  threadMessageSchema,
  type ThreadMessage,
  type ThreadSummary,
  type UserMessageStatus,
} from '@twring/contracts';

import { messageAad, sealedSecretSchema, type CredentialCipher } from '../store/cipher';
import { fileAad } from '../files/cipher';

export type FileRow = Attachment & {
  userId: string;
  agentId: string;
  messageId: string | null;
  direction: 'owner' | 'agent';
  clientId: string | null;
  sha256: string;
  createdAt: string;
};
type StoredFile = {
  id: string;
  user_id: string;
  agent_id: string;
  message_id: string | null;
  direction: 'owner' | 'agent';
  client_id: string | null;
  mime_type: Attachment['mime_type'];
  size_bytes: number;
  width: number | null;
  height: number | null;
  name: string;
  sha256: string;
  created_at: string;
};
export class FileStoreError extends Error {
  constructor(readonly code: 'storage_full' | 'files_daily_limit' | 'bad_attachment') {
    super(code);
  }
}

type Row = {
  id: string;
  thread_id: string;
  user_id: string;
  agent_id?: string;
  seq: number;
  rev: number;
  kind: ThreadMessage['kind'];
  body: string | null;
  status: string | null;
  client_id: string | null;
  turn_id: string | null;
  meta: string;
  created_at: string;
  updated_at: string;
};
type ThreadRow = {
  id: string;
  user_id: string;
  agent_id: string;
  last_message_at: string | null;
  read_seq: number;
  next_seq: number;
  next_rev: number;
};
type AppendInput =
  | (Pick<
      Extract<ThreadMessage, { kind: 'agent_text' }>,
      'kind' | 'text' | 'turn_id' | 'partial'
    > & { cut?: boolean; clientId?: string; attachmentIds?: string[] })
  | Pick<
      Extract<ThreadMessage, { kind: 'call' }>,
      'kind' | 'call_id' | 'duration_s' | 'outcome' | 'end_reason'
    >
  | Pick<
      Extract<ThreadMessage, { kind: 'ring' }>,
      'kind' | 'invite_id' | 'reason' | 'outcome' | 'note'
    >
  | Pick<
      Extract<ThreadMessage, { kind: 'approval' }>,
      'kind' | 'approval_id' | 'title' | 'description' | 'status' | 'expires_at'
    >
  | Pick<Extract<ThreadMessage, { kind: 'notice' }>, 'kind' | 'code'>;

export class ThreadStoreError extends Error {
  constructor(readonly code: 'queue_full' | 'message_unreadable') {
    super(code);
    this.name = 'ThreadStoreError';
  }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
function newId(prefix: 'thr' | 'msg'): string {
  return `${prefix}_${[...randomBytes(20)].map((byte) => ALPHABET[byte & 31]).join('')}`;
}

function cutText(text: string): { text: string; cut: boolean } {
  if (text.length <= MAX_STORED_AGENT_MESSAGE_CHARS) return { text, cut: false };
  let end = MAX_STORED_AGENT_MESSAGE_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(0, end), cut: true };
}

export class SqliteThreadStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly cipher: CredentialCipher,
    private readonly now: () => Date = () => new Date(),
    private readonly fileLimits: { quotaBytes: number; perDay: number } = {
      quotaBytes: FILE_QUOTA_BYTES,
      perDay: FILES_PER_DAY,
    },
  ) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at TEXT NOT NULL,
        last_message_at TEXT, read_seq INTEGER NOT NULL DEFAULT 0, next_seq INTEGER NOT NULL DEFAULT 1,
        next_rev INTEGER NOT NULL DEFAULT 1, UNIQUE(user_id, agent_id));
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, seq INTEGER NOT NULL, rev INTEGER NOT NULL, kind TEXT NOT NULL,
        body TEXT, status TEXT, client_id TEXT, turn_id TEXT, meta TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(thread_id, seq), UNIQUE(thread_id, client_id));
      CREATE INDEX IF NOT EXISTS messages_thread_rev ON messages(thread_id, rev);
      CREATE INDEX IF NOT EXISTS messages_user_turn ON messages(user_id, turn_id);
      CREATE INDEX IF NOT EXISTS messages_status ON messages(status);
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, message_id TEXT,
        direction TEXT NOT NULL CHECK(direction IN ('owner','agent')), client_id TEXT, mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, width INTEGER, height INTEGER, name TEXT NOT NULL, sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(user_id,agent_id,client_id));
      CREATE INDEX IF NOT EXISTS files_user_created ON files(user_id,created_at);
      CREATE INDEX IF NOT EXISTS files_message ON files(message_id);
      CREATE TABLE IF NOT EXISTS file_days(user_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(user_id,day));
    `);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private thread(userId: string, agentId: string): ThreadRow | undefined {
    return this.db
      .prepare('SELECT * FROM threads WHERE user_id=? AND agent_id=?')
      .get(userId, agentId) as ThreadRow | undefined;
  }

  private ensureThread(userId: string, agentId: string): ThreadRow {
    const existing = this.thread(userId, agentId);
    if (existing) return existing;
    this.db
      .prepare('INSERT INTO threads(id,user_id,agent_id,created_at) VALUES(?,?,?,?)')
      .run(newId('thr'), userId, agentId, this.now().toISOString());
    return this.thread(userId, agentId)!;
  }

  private decode(row: Row, agentId?: string): ThreadMessage {
    let text: string | undefined;
    if (row.body !== null) {
      try {
        text = this.cipher.open(
          sealedSecretSchema.parse(JSON.parse(row.body)),
          messageAad(row.user_id, row.thread_id, row.id),
        );
      } catch {
        throw new ThreadStoreError('message_unreadable');
      }
    }
    const resolvedAgentId =
      agentId ??
      row.agent_id ??
      (
        this.db
          .prepare('SELECT agent_id FROM threads WHERE id=? AND user_id=?')
          .get(row.thread_id, row.user_id) as { agent_id: string }
      ).agent_id;
    try {
      // Ring text (reason, decline note) is sealed as JSON in the body, never left in meta.
      const sealedFields =
        (row.kind === 'ring' || row.kind === 'approval') && text !== undefined
          ? (JSON.parse(text) as Record<string, unknown>)
          : {};
      const meta = JSON.parse(row.meta) as Record<string, unknown>;
      const attachmentIds = Array.isArray(meta.attachment_ids) ? meta.attachment_ids : [];
      const attachments =
        row.kind === 'user_text' || row.kind === 'agent_text'
          ? attachmentIds.flatMap((id) => {
              if (typeof id !== 'string') return [];
              const file = this.findFile(row.user_id, id);
              return file?.messageId === row.id ? [this.attachment(file)] : [];
            })
          : [];
      return threadMessageSchema.parse({
        id: row.id,
        agent_id: resolvedAgentId,
        seq: row.seq,
        rev: row.rev,
        created_at: row.created_at,
        updated_at: row.updated_at,
        kind: row.kind,
        ...(text === undefined || row.kind === 'ring' || row.kind === 'approval' ? {} : { text }),
        ...(row.status === null ? {} : { status: row.status }),
        ...(row.client_id === null ? {} : { client_id: row.client_id }),
        ...(row.turn_id === null ? {} : { turn_id: row.turn_id }),
        ...meta,
        ...(attachments.length && { attachments }),
        ...sealedFields,
      });
    } catch {
      throw new ThreadStoreError('message_unreadable');
    }
  }

  private file(row: StoredFile): FileRow {
    return {
      id: row.id,
      userId: row.user_id,
      agentId: row.agent_id,
      messageId: row.message_id,
      direction: row.direction,
      clientId: row.client_id,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      ...(row.width && { width: row.width }),
      ...(row.height && { height: row.height }),
      name: this.cipher.open(
        sealedSecretSchema.parse(JSON.parse(row.name)),
        fileAad(row.user_id, row.id),
      ),
      sha256: row.sha256,
      createdAt: row.created_at,
    };
  }

  attachment(file: FileRow): Attachment {
    return {
      id: file.id,
      name: file.name,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
      ...(file.width && { width: file.width }),
      ...(file.height && { height: file.height }),
    };
  }

  insertFile(input: Omit<FileRow, 'messageId' | 'createdAt'>): { file: FileRow; created: boolean } {
    return this.transaction(() => {
      if (input.clientId) {
        const old = this.db
          .prepare('SELECT * FROM files WHERE user_id=? AND agent_id=? AND client_id=?')
          .get(input.userId, input.agentId, input.clientId) as StoredFile | undefined;
        if (old) {
          if (old.direction !== input.direction) throw new FileStoreError('bad_attachment');
          return { file: this.file(old), created: false };
        }
      }
      const used = this.db
        .prepare('SELECT COALESCE(sum(size_bytes),0) AS n FROM files WHERE user_id=?')
        .get(input.userId) as { n: number };
      if (used.n + input.size_bytes > this.fileLimits.quotaBytes)
        throw new FileStoreError('storage_full');
      const day = this.now().toISOString().slice(0, 10);
      const daily = this.db
        .prepare('SELECT count FROM file_days WHERE user_id=? AND day=?')
        .get(input.userId, day) as { count: number } | undefined;
      if ((daily?.count ?? 0) >= this.fileLimits.perDay)
        throw new FileStoreError('files_daily_limit');
      const at = this.now().toISOString();
      const name = JSON.stringify(this.cipher.seal(input.name, fileAad(input.userId, input.id)));
      this.db
        .prepare(
          `INSERT INTO files(id,user_id,agent_id,message_id,direction,client_id,mime_type,size_bytes,width,height,name,sha256,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.id,
          input.userId,
          input.agentId,
          null,
          input.direction,
          input.clientId,
          input.mime_type,
          input.size_bytes,
          input.width ?? null,
          input.height ?? null,
          name,
          input.sha256,
          at,
        );
      this.db
        .prepare(
          'INSERT INTO file_days(user_id,day,count) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1',
        )
        .run(input.userId, day);
      return { file: this.findFile(input.userId, input.id)!, created: true };
    });
  }

  findFile(userId: string, fileId: string): FileRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM files WHERE id=? AND user_id=?')
      .get(fileId, userId) as StoredFile | undefined;
    return row && this.file(row);
  }

  fileOwner(fileId: string): { userId: string; agentId: string; attached: boolean } | undefined {
    const row = this.db
      .prepare(
        'SELECT user_id,agent_id,message_id FROM files WHERE id=? AND (message_id IS NULL OR message_id IN (SELECT id FROM messages))',
      )
      .get(fileId) as { user_id: string; agent_id: string; message_id: string | null } | undefined;
    return row && { userId: row.user_id, agentId: row.agent_id, attached: row.message_id !== null };
  }

  attachFiles(userId: string, agentId: string, messageId: string, fileIds: string[]): void {
    const kind = this.db
      .prepare('SELECT kind FROM messages WHERE id=? AND user_id=?')
      .get(messageId, userId) as { kind: string } | undefined;
    const direction = kind?.kind === 'agent_text' ? 'agent' : 'owner';
    for (const id of fileIds) {
      const file = this.db
        .prepare('SELECT direction,message_id FROM files WHERE id=? AND user_id=? AND agent_id=?')
        .get(id, userId, agentId) as { direction: string; message_id: string | null } | undefined;
      if (
        !file ||
        file.direction !== direction ||
        (file.message_id && file.message_id !== messageId)
      )
        throw new FileStoreError('bad_attachment');
      this.db
        .prepare('UPDATE files SET message_id=? WHERE id=? AND user_id=? AND agent_id=?')
        .run(messageId, id, userId, agentId);
    }
  }

  staleUnattachedFiles(olderThan: Date): string[] {
    return (
      this.db
        .prepare('SELECT id FROM files WHERE message_id IS NULL AND created_at<?')
        .all(olderThan.toISOString()) as { id: string }[]
    ).map((row) => row.id);
  }

  /** Files whose message was pruned from a full thread: no one can see them any more. */
  danglingFiles(): string[] {
    return (
      this.db
        .prepare(
          'SELECT id FROM files WHERE message_id IS NOT NULL AND message_id NOT IN (SELECT id FROM messages)',
        )
        .all() as { id: string }[]
    ).map((row) => row.id);
  }

  deleteFiles(ids: string[]): void {
    this.transaction(() => {
      for (const id of ids) this.db.prepare('DELETE FROM files WHERE id=?').run(id);
    });
  }

  private tryDecode(row: Row, agentId?: string): ThreadMessage | null {
    try {
      return this.decode(row, agentId);
    } catch (error) {
      if (error instanceof ThreadStoreError) return null;
      throw error;
    }
  }

  private insert(
    userId: string,
    thread: ThreadRow,
    kind: ThreadMessage['kind'],
    data: {
      text?: string;
      status?: string;
      clientId?: string;
      turnId?: string;
      meta?: Record<string, unknown>;
      attachmentIds?: string[];
    },
  ): ThreadMessage {
    const id = newId('msg');
    const at = this.now().toISOString();
    const body =
      data.text === undefined
        ? null
        : JSON.stringify(this.cipher.seal(data.text, messageAad(userId, thread.id, id)));
    this.db
      .prepare(
        `INSERT INTO messages(id,thread_id,user_id,seq,rev,kind,body,status,client_id,turn_id,meta,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        thread.id,
        userId,
        thread.next_seq,
        thread.next_rev,
        kind,
        body,
        data.status ?? null,
        data.clientId ?? null,
        data.turnId ?? null,
        JSON.stringify(data.meta ?? {}),
        at,
        at,
      );
    this.db
      .prepare(
        'UPDATE threads SET next_seq=next_seq+1,next_rev=next_rev+1,last_message_at=? WHERE id=? AND user_id=?',
      )
      .run(at, thread.id, userId);
    if (data.attachmentIds?.length)
      this.attachFiles(userId, thread.agent_id, id, data.attachmentIds);
    this.db
      .prepare(
        `DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE thread_id=? AND user_id=? AND (status IS NULL OR status!='queued') ORDER BY seq DESC LIMIT -1 OFFSET ?)`,
      )
      .run(thread.id, userId, MAX_MESSAGES_PER_THREAD);
    const row = this.db
      .prepare('SELECT * FROM messages WHERE id=? AND user_id=?')
      .get(id, userId) as Row;
    return this.decode(row, thread.agent_id);
  }

  async appendUserMessage(
    userId: string,
    agentId: string,
    input: {
      clientId: string;
      text: string;
      status: UserMessageStatus;
      voice?: { duration_s: number };
      attachmentIds?: string[];
    },
  ): Promise<{ message: ThreadMessage; created: boolean }> {
    return this.transaction(() => {
      const thread = this.ensureThread(userId, agentId);
      const existing = this.db
        .prepare('SELECT * FROM messages WHERE thread_id=? AND user_id=? AND client_id=?')
        .get(thread.id, userId, input.clientId) as Row | undefined;
      if (existing) return { message: this.decode(existing, agentId), created: false };
      if (input.status === 'queued') {
        const count = this.db
          .prepare(
            "SELECT count(*) AS n FROM messages WHERE thread_id=? AND user_id=? AND status='queued'",
          )
          .get(thread.id, userId) as { n: number };
        if (count.n >= MAX_QUEUED_PER_THREAD) throw new ThreadStoreError('queue_full');
      }
      const message = this.insert(userId, thread, 'user_text', {
        text: input.text,
        status: input.status,
        clientId: input.clientId,
        meta: {
          ...(input.voice && { voice: input.voice }),
          ...(input.attachmentIds && { attachment_ids: input.attachmentIds }),
        },
        attachmentIds: input.attachmentIds,
      });
      return { message, created: true };
    });
  }

  async appendMessage(
    userId: string,
    agentId: string,
    input: Extract<AppendInput, { kind: 'agent_text' }> & { clientId: string },
  ): Promise<{ message: ThreadMessage; created: boolean }>;
  async appendMessage(userId: string, agentId: string, input: AppendInput): Promise<ThreadMessage>;
  async appendMessage(
    userId: string,
    agentId: string,
    input: AppendInput,
  ): Promise<ThreadMessage | { message: ThreadMessage; created: boolean }> {
    return this.transaction(() => {
      const thread = this.ensureThread(userId, agentId);
      if (input.kind === 'agent_text') {
        if (input.clientId !== undefined) {
          const existing = this.db
            .prepare('SELECT * FROM messages WHERE thread_id=? AND user_id=? AND client_id=?')
            .get(thread.id, userId, input.clientId) as Row | undefined;
          if (existing) {
            const message = this.decode(existing, agentId);
            if (
              input.attachmentIds &&
              (message.kind !== 'agent_text' ||
                input.attachmentIds.length !== (message.attachments?.length ?? 0) ||
                input.attachmentIds.some((id, index) => message.attachments?.[index]?.id !== id))
            )
              throw new FileStoreError('bad_attachment');
            return { message, created: false };
          }
        }
        const shortened = cutText(input.text);
        const message = this.insert(userId, thread, input.kind, {
          text: shortened.text,
          turnId: input.turn_id,
          clientId: input.clientId,
          meta: {
            cut: shortened.cut || input.cut === true,
            partial: input.partial,
            ...(input.attachmentIds?.length && { attachment_ids: input.attachmentIds }),
          },
          attachmentIds: input.attachmentIds,
        });
        return input.clientId === undefined ? message : { message, created: true };
      }
      if (input.kind === 'ring') {
        const { kind, reason, note, ...meta } = input;
        return this.insert(userId, thread, kind, {
          text: JSON.stringify({ reason, ...(note === undefined ? {} : { note }) }),
          meta,
        });
      }
      if (input.kind === 'approval') {
        const { kind, title, description, status, ...meta } = input;
        return this.insert(userId, thread, kind, {
          text: JSON.stringify({ title, ...(description === undefined ? {} : { description }) }),
          status,
          meta,
        });
      }
      const { kind, ...meta } = input;
      return this.insert(userId, thread, kind, { meta });
    });
  }

  async updateUserMessage(
    userId: string,
    messageId: string,
    patch: { status?: UserMessageStatus; turnId?: string; errorCode?: string },
  ): Promise<ThreadMessage | undefined> {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM messages WHERE id=? AND user_id=? AND kind='user_text'")
        .get(messageId, userId) as Row | undefined;
      if (!row) return undefined;
      const thread = this.db
        .prepare('SELECT * FROM threads WHERE id=? AND user_id=?')
        .get(row.thread_id, userId) as ThreadRow;
      const meta = {
        ...(JSON.parse(row.meta) as Record<string, unknown>),
        ...(patch.errorCode === undefined ? {} : { error_code: patch.errorCode }),
      };
      this.db
        .prepare(
          'UPDATE messages SET status=?,turn_id=?,meta=?,rev=?,updated_at=? WHERE id=? AND user_id=?',
        )
        .run(
          patch.status ?? row.status,
          patch.turnId ?? row.turn_id,
          JSON.stringify(meta),
          thread.next_rev,
          this.now().toISOString(),
          messageId,
          userId,
        );
      this.db
        .prepare('UPDATE threads SET next_rev=next_rev+1 WHERE id=? AND user_id=?')
        .run(thread.id, userId);
      return this.decode(
        this.db
          .prepare('SELECT * FROM messages WHERE id=? AND user_id=?')
          .get(messageId, userId) as Row,
        thread.agent_id,
      );
    });
  }

  async updateApproval(
    userId: string,
    agentId: string,
    messageId: string,
    status: 'allowed' | 'denied' | 'expired',
  ): Promise<ThreadMessage | undefined> {
    return this.transaction(() => {
      const thread = this.thread(userId, agentId);
      if (!thread) return undefined;
      const row = this.db
        .prepare(
          "SELECT * FROM messages WHERE id=? AND thread_id=? AND user_id=? AND kind='approval' AND status='pending'",
        )
        .get(messageId, thread.id, userId) as Row | undefined;
      if (!row) return undefined;
      this.db
        .prepare('UPDATE messages SET status=?,rev=?,updated_at=? WHERE id=? AND user_id=?')
        .run(status, thread.next_rev, this.now().toISOString(), messageId, userId);
      this.db
        .prepare('UPDATE threads SET next_rev=next_rev+1 WHERE id=? AND user_id=?')
        .run(thread.id, userId);
      return this.decode(
        this.db
          .prepare('SELECT * FROM messages WHERE id=? AND user_id=?')
          .get(messageId, userId) as Row,
        agentId,
      );
    });
  }

  async expirePendingApprovals(): Promise<number> {
    return this.changeStatuses("m.kind='approval' AND m.status='pending'", [], 'expired').count;
  }

  async listThreads(userId: string): Promise<ThreadSummary[]> {
    const threads = this.db
      .prepare('SELECT * FROM threads WHERE user_id=? ORDER BY last_message_at DESC')
      .all(userId) as ThreadRow[];
    return threads.map((thread) => {
      const last = this.db
        .prepare('SELECT * FROM messages WHERE thread_id=? AND user_id=? ORDER BY seq DESC LIMIT 1')
        .get(thread.id, userId) as Row | undefined;
      const unread = this.db
        .prepare(
          "SELECT count(*) AS n FROM messages WHERE thread_id=? AND user_id=? AND seq>? AND kind!='user_text'",
        )
        .get(thread.id, userId, thread.read_seq) as { n: number };
      return {
        agent_id: thread.agent_id,
        last_message: last ? this.tryDecode(last, thread.agent_id) : null,
        unread: unread.n,
        last_message_at: last?.created_at ?? null,
        read_seq: thread.read_seq,
      };
    });
  }

  async listMessages(
    userId: string,
    agentId: string,
    options: { beforeSeq?: number; afterRev?: number; limit: number },
  ): Promise<{ messages: ThreadMessage[]; hasMore: boolean }> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
      throw new RangeError('limit must be 1..100');
    const thread = this.thread(userId, agentId);
    if (!thread) return { messages: [], hasMore: false };
    const after = options.afterRev !== undefined;
    const rows = after
      ? (this.db
          .prepare(
            'SELECT * FROM messages WHERE thread_id=? AND user_id=? AND rev>? ORDER BY rev ASC LIMIT ?',
          )
          .all(thread.id, userId, options.afterRev!, options.limit + 1) as Row[])
      : (this.db
          .prepare(
            'SELECT * FROM messages WHERE thread_id=? AND user_id=? AND seq<? ORDER BY seq DESC LIMIT ?',
          )
          .all(
            thread.id,
            userId,
            options.beforeSeq ?? thread.next_seq,
            options.limit + 1,
          ) as Row[]);
    return {
      messages: rows.slice(0, options.limit).map((row) => this.decode(row, agentId)),
      hasMore: rows.length > options.limit,
    };
  }

  async ownerReplies(
    userId: string,
    agentId: string,
    since?: string,
    limit = 20,
  ): Promise<Extract<ThreadMessage, { kind: 'user_text' }>[]> {
    const thread = this.thread(userId, agentId);
    if (!thread) return [];
    const rows =
      since === undefined
        ? (this.db
            .prepare(
              "SELECT * FROM messages WHERE thread_id=? AND user_id=? AND kind='user_text' ORDER BY seq DESC LIMIT ?",
            )
            .all(thread.id, userId, limit) as Row[])
        : (this.db
            .prepare(
              "SELECT * FROM messages WHERE thread_id=? AND user_id=? AND kind='user_text' AND created_at>? ORDER BY seq ASC LIMIT ?",
            )
            .all(thread.id, userId, since, limit) as Row[]);
    return (since === undefined ? rows.reverse() : rows).map(
      (row) => this.decode(row, agentId) as Extract<ThreadMessage, { kind: 'user_text' }>,
    );
  }

  async ownerReplyCount(userId: string, agentId: string, since?: string): Promise<number> {
    const thread = this.thread(userId, agentId);
    if (!thread) return 0;
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE thread_id=? AND user_id=? AND kind='user_text' AND created_at>?",
      )
      .get(thread.id, userId, since ?? '') as { count: number };
    return row.count;
  }

  async findMessageById(
    userId: string,
    agentId: string,
    messageId: string,
  ): Promise<ThreadMessage | undefined> {
    const thread = this.thread(userId, agentId);
    if (!thread) return undefined;
    const row = this.db
      .prepare('SELECT * FROM messages WHERE id=? AND thread_id=? AND user_id=?')
      .get(messageId, thread.id, userId) as Row | undefined;
    return row ? this.decode(row, agentId) : undefined;
  }

  async findUserMessageByTurn(userId: string, turnId: string): Promise<ThreadMessage | undefined> {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE user_id=? AND turn_id=? AND kind='user_text' LIMIT 1")
      .get(userId, turnId) as Row | undefined;
    return row ? this.decode(row) : undefined;
  }

  async findUserMessageByClientId(
    userId: string,
    agentId: string,
    clientId: string,
  ): Promise<ThreadMessage | undefined> {
    const thread = this.thread(userId, agentId);
    if (!thread) return undefined;
    const row = this.db
      .prepare(
        "SELECT * FROM messages WHERE thread_id=? AND user_id=? AND client_id=? AND kind='user_text'",
      )
      .get(thread.id, userId, clientId) as Row | undefined;
    return row ? this.decode(row, agentId) : undefined;
  }

  async findUserMessageById(
    userId: string,
    agentId: string,
    messageId: string,
  ): Promise<ThreadMessage | undefined> {
    const thread = this.thread(userId, agentId);
    if (!thread) return undefined;
    const row = this.db
      .prepare(
        "SELECT * FROM messages WHERE thread_id=? AND user_id=? AND id=? AND kind='user_text'",
      )
      .get(thread.id, userId, messageId) as Row | undefined;
    return row ? this.decode(row, agentId) : undefined;
  }

  async markRead(userId: string, agentId: string, seq: number): Promise<void> {
    this.db
      .prepare(
        'UPDATE threads SET read_seq=min(next_seq-1,max(read_seq,?)) WHERE user_id=? AND agent_id=?',
      )
      .run(seq, userId, agentId);
  }

  async queuedMessages(userId: string, agentId: string): Promise<ThreadMessage[]> {
    const thread = this.thread(userId, agentId);
    if (!thread) return [];
    return (
      this.db
        .prepare(
          "SELECT * FROM messages WHERE thread_id=? AND user_id=? AND kind='user_text' AND status='queued' ORDER BY seq",
        )
        .all(thread.id, userId) as Row[]
    ).map((row) => this.decode(row, agentId));
  }

  async queuedAgents(): Promise<{ userId: string; agentId: string }[]> {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT m.user_id AS userId, t.agent_id AS agentId FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.kind='user_text' AND m.status='queued'",
      )
      .all() as { userId: string; agentId: string }[];
    return rows;
  }

  async clearThread(
    userId: string,
    agentId: string,
  ): Promise<{ messages: number; fileIds: string[] }> {
    return this.transaction(() => {
      const thread = this.thread(userId, agentId);
      const fileIds = (
        this.db
          .prepare('SELECT id FROM files WHERE user_id=? AND agent_id=?')
          .all(userId, agentId) as { id: string }[]
      ).map((row) => row.id);
      this.db.prepare('DELETE FROM files WHERE user_id=? AND agent_id=?').run(userId, agentId);
      if (!thread) return { messages: 0, fileIds };
      const count = this.db
        .prepare('DELETE FROM messages WHERE thread_id=? AND user_id=?')
        .run(thread.id, userId).changes;
      this.db
        .prepare('UPDATE threads SET last_message_at=NULL WHERE id=? AND user_id=?')
        .run(thread.id, userId);
      return { messages: Number(count), fileIds };
    });
  }

  async deleteThread(
    userId: string,
    agentId: string,
  ): Promise<{ messages: number; fileIds: string[] }> {
    return this.transaction(() => {
      const thread = this.thread(userId, agentId);
      const fileIds = (
        this.db
          .prepare('SELECT id FROM files WHERE user_id=? AND agent_id=?')
          .all(userId, agentId) as { id: string }[]
      ).map((row) => row.id);
      this.db.prepare('DELETE FROM files WHERE user_id=? AND agent_id=?').run(userId, agentId);
      if (!thread) return { messages: 0, fileIds };
      const count = this.db
        .prepare('SELECT count(*) AS n FROM messages WHERE thread_id=? AND user_id=?')
        .get(thread.id, userId) as { n: number };
      this.db.prepare('DELETE FROM threads WHERE id=? AND user_id=?').run(thread.id, userId);
      return { messages: count.n, fileIds };
    });
  }

  async deleteAllForUser(userId: string): Promise<{ messages: number; fileIds: string[] }> {
    return this.transaction(() => {
      const count = this.db
        .prepare('SELECT count(*) AS n FROM messages WHERE user_id=?')
        .get(userId) as { n: number };
      const fileIds = (
        this.db.prepare('SELECT id FROM files WHERE user_id=?').all(userId) as { id: string }[]
      ).map((row) => row.id);
      this.db.prepare('DELETE FROM files WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM file_days WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM threads WHERE user_id=?').run(userId);
      return { messages: count.n, fileIds };
    });
  }

  /** Sets `status` on every matching message; returns them as changed. */
  private changeStatuses(
    where: string,
    values: string[],
    status: UserMessageStatus | 'expired',
  ): { count: number; messages: ThreadMessage[] } {
    return this.transaction(() => {
      const rows = this.db
        .prepare(`SELECT m.* FROM messages m WHERE ${where}`)
        .all(...values) as Row[];
      for (const row of rows) {
        const thread = this.db
          .prepare('SELECT * FROM threads WHERE id=? AND user_id=?')
          .get(row.thread_id, row.user_id) as ThreadRow;
        this.db
          .prepare('UPDATE messages SET status=?,rev=?,updated_at=? WHERE id=? AND user_id=?')
          .run(status, thread.next_rev, this.now().toISOString(), row.id, row.user_id);
        this.db
          .prepare('UPDATE threads SET next_rev=next_rev+1 WHERE id=? AND user_id=?')
          .run(thread.id, row.user_id);
      }
      const messages: ThreadMessage[] = [];
      for (const row of rows) {
        const decoded = this.tryDecode(
          this.db
            .prepare('SELECT * FROM messages WHERE id=? AND user_id=?')
            .get(row.id, row.user_id) as Row,
        );
        if (decoded) messages.push(decoded);
      }
      return { count: rows.length, messages };
    });
  }

  async interruptInFlight(): Promise<number> {
    return this.changeStatuses(
      "m.kind='user_text' AND m.status IN ('sent','working')",
      [],
      'interrupted',
    ).count;
  }

  /** Queued too long (the computer stayed offline): `expired`. Returns the changed messages. */
  async expireQueued(): Promise<ThreadMessage[]> {
    return this.changeStatuses(
      "m.kind='user_text' AND m.status='queued' AND m.created_at<?",
      [new Date(this.now().getTime() - QUEUED_MESSAGE_TTL_MS).toISOString()],
      'expired',
    ).messages;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
