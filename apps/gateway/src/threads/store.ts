/* eslint-disable @typescript-eslint/require-await -- Keep the repository API async for a future database implementation. */
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  MAX_MESSAGES_PER_THREAD,
  FILE_QUOTA_BYTES,
  FILES_PER_DAY,
  type Attachment,
  MAX_QUEUED_PER_THREAD,
  MAX_SEALED_REPLY_CHUNKS,
  MAX_SEALED_REPLY_TOTAL_CHARS,
  MAX_STORED_AGENT_MESSAGE_CHARS,
  QUEUED_MESSAGE_TTL_MS,
  threadMessageSchema,
  type ThreadMessage,
  type SealedEnvelopeV1,
  type ThreadSummary,
  type UserMessageStatus,
} from '@twring/contracts';

import { messageAad, sealedSecretSchema, type CredentialCipher } from '../store/cipher';
import { fileAad } from '../files/cipher';
import { quoteOf, type Quote } from './quote';

/** A reply chunk's place in its reply; an envelope without one is a whole reply (chunk 0). */
const chunkIndex = (envelope: SealedEnvelopeV1) => envelope.chunk?.index ?? 0;

/** A stored sealed body: a list of envelopes, or one bare envelope in rows from before chunking. */
function envelopeList(text: string): unknown[] {
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

const quoteAad = (userId: string, threadId: string, messageId: string) =>
  `${messageAad(userId, threadId, messageId)}:quote`;
export type MediaRow = Attachment & {
  messageId: string;
  direction: 'sent' | 'received';
  createdAt: string;
};

export type FileRow = Omit<Attachment, 'mime_type'> & {
  /** A sealed file is stored as `application/octet-stream`, never an attachment (ADR-045). */
  mime_type: Attachment['mime_type'] | 'application/octet-stream';
  /** Sealed on a device: an opaque blob the server cannot read, never listed as an attachment. */
  sealed: boolean;
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
  mime_type: FileRow['mime_type'];
  sealed: number;
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
  private: number;
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
  constructor(readonly code: 'queue_full' | 'message_unreadable' | 'reply_to_not_found') {
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
    // Private chats (ADR-044). Added in place, so an existing database keeps every thread.
    const columns = this.db.prepare('PRAGMA table_info(threads)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'private'))
      this.db.exec('ALTER TABLE threads ADD COLUMN private INTEGER NOT NULL DEFAULT 0');
    // Sealed files (ADR-045). Added in place, so an existing database keeps every file.
    const fileColumns = this.db.prepare('PRAGMA table_info(files)').all() as { name: string }[];
    if (!fileColumns.some((column) => column.name === 'sealed'))
      this.db.exec('ALTER TABLE files ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0');
    // Re-wrapped message keys for a phone approved later (C3 #11 Task 28). They go with their
    // message (and so with the thread and with delete my data) through the foreign key.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS e2e_sealed_rewraps(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, agent_id TEXT NOT NULL, for_device TEXT NOT NULL, by_device TEXT NOT NULL,
        wrapped TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(message_id, for_device));
      CREATE INDEX IF NOT EXISTS e2e_rewraps_for ON e2e_sealed_rewraps(user_id, agent_id, for_device);
      CREATE INDEX IF NOT EXISTS e2e_rewraps_by ON e2e_sealed_rewraps(user_id, by_device);
    `);
  }

  /**
   * Stores re-wrapped keys made by `by` for `forDevice` (C3 #11 Task 28). Every message must be a
   * sealed message of this person's thread with this agent, or nothing is stored. A repeat for
   * the same (message, for) replaces the earlier one. The message itself is never touched.
   */
  addRewraps(
    userId: string,
    agentId: string,
    input: { by: string; forDevice: string; items: { message_id: string; wrapped: string }[] },
  ): 'stored' | 'unknown_message' {
    return this.transaction(() => {
      const thread = this.thread(userId, agentId);
      if (!thread) return 'unknown_message' as const;
      const exists = this.db.prepare(
        "SELECT 1 FROM messages WHERE id=? AND thread_id=? AND user_id=? AND kind='sealed'",
      );
      for (const item of input.items)
        if (!exists.get(item.message_id, thread.id, userId)) return 'unknown_message' as const;
      const upsert = this.db.prepare(
        `INSERT INTO e2e_sealed_rewraps(message_id,user_id,agent_id,for_device,by_device,wrapped,created_at)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(message_id,for_device)
          DO UPDATE SET by_device=excluded.by_device, wrapped=excluded.wrapped, created_at=excluded.created_at`,
      );
      const at = this.now().toISOString();
      for (const item of input.items)
        upsert.run(item.message_id, userId, agentId, input.forDevice, input.by, item.wrapped, at);
      return 'stored' as const;
    });
  }

  /** Re-wraps for one device in a thread, in message order, after message seq `after`. */
  listRewraps(
    userId: string,
    agentId: string,
    forDevice: string,
    options: { after: number; limit: number },
  ): { items: { message_id: string; by: string; wrapped: string }[]; next?: number } {
    const thread = this.thread(userId, agentId);
    if (!thread) return { items: [] };
    const rows = this.db
      .prepare(
        `SELECT r.message_id, r.by_device, r.wrapped, m.seq FROM e2e_sealed_rewraps r
          JOIN messages m ON m.id=r.message_id AND m.user_id=r.user_id
          WHERE r.user_id=? AND r.agent_id=? AND r.for_device=? AND m.thread_id=? AND m.seq>?
          ORDER BY m.seq LIMIT ?`,
      )
      .all(userId, agentId, forDevice, thread.id, options.after, options.limit + 1) as {
      message_id: string;
      by_device: string;
      wrapped: string;
      seq: number;
    }[];
    const page = rows.slice(0, options.limit);
    return {
      items: page.map((row) => ({
        message_id: row.message_id,
        by: row.by_device,
        wrapped: row.wrapped,
      })),
      ...(rows.length > options.limit && { next: page[page.length - 1]!.seq }),
    };
  }

  /** A device left the account: every re-wrap it made or was given goes. Returns the count. */
  deleteRewrapsForDevice(userId: string, deviceId: string): number {
    return Number(
      this.db
        .prepare('DELETE FROM e2e_sealed_rewraps WHERE user_id=? AND (for_device=? OR by_device=?)')
        .run(userId, deviceId, deviceId).changes,
    );
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
          : row.kind === 'sealed' && text !== undefined
            ? { sealed: envelopeList(text) }
            : {};
      const { quote_sealed: quoteSealed, ...meta } = JSON.parse(row.meta) as Record<
        string,
        unknown
      >;
      // The quote is the answered message's text, so it is sealed like the body.
      const quote =
        quoteSealed === undefined
          ? undefined
          : (JSON.parse(
              this.cipher.open(
                sealedSecretSchema.parse(quoteSealed),
                quoteAad(row.user_id, row.thread_id, row.id),
              ),
            ) as unknown);
      const attachmentIds = Array.isArray(meta.attachment_ids) ? meta.attachment_ids : [];
      const attachments =
        row.kind === 'user_text' || row.kind === 'agent_text'
          ? attachmentIds.flatMap((id) => {
              if (typeof id !== 'string') return [];
              const file = this.findFile(row.user_id, id);
              return file?.messageId === row.id && !file.sealed ? [this.attachment(file)] : [];
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
        ...(text === undefined ||
        row.kind === 'ring' ||
        row.kind === 'approval' ||
        row.kind === 'sealed'
          ? {}
          : { text }),
        ...(row.status === null ? {} : { status: row.status }),
        ...(row.client_id === null ? {} : { client_id: row.client_id }),
        ...(row.turn_id === null ? {} : { turn_id: row.turn_id }),
        ...meta,
        ...(attachments.length && { attachments }),
        ...(quote !== undefined && { quote }),
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
      sealed: row.sealed === 1,
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
    // The one gate every file-to-Attachment mapper passes through: older apps parse attachments
    // with a closed list of types, so a sealed blob must never be shown as one (ADR-045).
    if (file.sealed || file.mime_type === 'application/octet-stream')
      throw new FileStoreError('bad_attachment');
    return {
      id: file.id,
      name: file.name,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
      ...(file.width && { width: file.width }),
      ...(file.height && { height: file.height }),
    };
  }

  insertFile(input: Omit<FileRow, 'messageId' | 'createdAt' | 'sealed'> & { sealed?: true }): {
    file: FileRow;
    created: boolean;
  } {
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
          `INSERT INTO files(id,user_id,agent_id,message_id,direction,client_id,mime_type,size_bytes,width,height,name,sha256,created_at,sealed)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          input.sealed ? 1 : 0,
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

  /**
   * Links files to a message. A sealed message takes only sealed files and a plain one only plain
   * files (ADR-045); `direction` is given for a sealed message ('owner' for the phone, 'agent' for
   * the computer) and otherwise follows the message kind.
   */
  attachFiles(
    userId: string,
    agentId: string,
    messageId: string,
    fileIds: string[],
    direction?: 'owner' | 'agent',
  ): void {
    const kind = this.db
      .prepare('SELECT kind FROM messages WHERE id=? AND user_id=?')
      .get(messageId, userId) as { kind: string } | undefined;
    const sealedMessage = kind?.kind === 'sealed';
    const expected = direction ?? (kind?.kind === 'agent_text' ? 'agent' : 'owner');
    for (const id of fileIds) {
      const file = this.db
        .prepare(
          'SELECT direction,message_id,sealed FROM files WHERE id=? AND user_id=? AND agent_id=?',
        )
        .get(id, userId, agentId) as
        { direction: string; message_id: string | null; sealed: number } | undefined;
      if (
        !file ||
        file.direction !== expected ||
        (file.sealed === 1) !== sealedMessage ||
        (file.message_id && file.message_id !== messageId)
      )
        throw new FileStoreError('bad_attachment');
      this.db
        .prepare('UPDATE files SET message_id=? WHERE id=? AND user_id=? AND agent_id=?')
        .run(messageId, id, userId, agentId);
    }
  }

  /**
   * A sealed file that may be read: attached to a sealed message in this person's private chat with
   * this agent (ADR-045). `direction` limits it to the phone's ('owner') or the computer's ('agent').
   */
  findReadableSealedFile(
    userId: string,
    agentId: string,
    fileId: string,
    direction?: 'owner' | 'agent',
  ): FileRow | undefined {
    const row = this.db
      .prepare(
        `SELECT f.* FROM files f JOIN messages m ON m.id=f.message_id AND m.user_id=f.user_id
          JOIN threads t ON t.id=m.thread_id AND t.user_id=f.user_id AND t.agent_id=f.agent_id
          WHERE f.id=? AND f.user_id=? AND f.agent_id=? AND f.sealed=1 AND m.kind='sealed' AND t.private=1${direction ? ' AND f.direction=?' : ''}`,
      )
      .get(fileId, userId, agentId, ...(direction ? [direction] : [])) as StoredFile | undefined;
    return row && this.file(row);
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
      quote?: Quote;
    },
  ): ThreadMessage {
    const id = newId('msg');
    const at = this.now().toISOString();
    const meta = {
      ...data.meta,
      ...(data.quote && {
        quote_sealed: this.cipher.seal(JSON.stringify(data.quote), quoteAad(userId, thread.id, id)),
      }),
    };
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
        JSON.stringify(meta),
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
      replyTo?: string;
      serverReadable?: true;
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
      let quote: Quote | undefined;
      if (input.replyTo !== undefined) {
        // Only this person's thread with this agent: another thread's text never leaks.
        const answered = this.db
          .prepare('SELECT * FROM messages WHERE id=? AND thread_id=? AND user_id=?')
          .get(input.replyTo, thread.id, userId) as Row | undefined;
        const decoded = answered && this.tryDecode(answered, agentId);
        quote = decoded ? quoteOf(decoded) : undefined;
        // A sealed message can be answered, but the server has no text to quote (ADR-044).
        if (!quote && decoded?.kind !== 'sealed') throw new ThreadStoreError('reply_to_not_found');
      }
      const message = this.insert(userId, thread, 'user_text', {
        text: input.text,
        status: input.status,
        clientId: input.clientId,
        meta: {
          ...(input.voice && { voice: input.voice }),
          ...(input.serverReadable && { server_readable: true }),
          ...(input.attachmentIds && { attachment_ids: input.attachmentIds }),
          ...(input.replyTo !== undefined && { reply_to: input.replyTo }),
        },
        attachmentIds: input.attachmentIds,
        quote,
      });
      return { message, created: true };
    });
  }

  /** Whether this person's chat with the agent is private (ADR-044). */
  async isPrivate(userId: string, agentId: string): Promise<boolean> {
    return this.thread(userId, agentId)?.private === 1;
  }

  /** Makes the chat private. One way: nothing turns a private chat back. */
  async setPrivate(userId: string, agentId: string): Promise<void> {
    this.transaction(() => {
      const thread = this.ensureThread(userId, agentId);
      this.db
        .prepare('UPDATE threads SET private=1 WHERE id=? AND user_id=?')
        .run(thread.id, userId);
    });
  }

  /**
   * Stores a sealed message as an opaque blob (still sealed at rest by the server cipher, so the
   * envelope's ids and wrapped keys are not left in plain on disk). A user message dedupes by
   * client id, like text; an agent reply is new each time (see `upsertSealedReply`).
   */
  async appendSealedMessage(
    userId: string,
    agentId: string,
    input: {
      author: 'user' | 'agent';
      sealed: SealedEnvelopeV1;
      clientId?: string;
      status?: UserMessageStatus;
      turnId?: string;
      replyTo?: string;
      /** A computer's sealed approval request (C3 #11): stored pending until this time. */
      approvalExpiresAt?: string;
    },
  ): Promise<{ message: ThreadMessage; created: boolean }> {
    return this.transaction(() => {
      const thread = this.ensureThread(userId, agentId);
      if (input.clientId !== undefined) {
        const existing = this.db
          .prepare('SELECT * FROM messages WHERE thread_id=? AND user_id=? AND client_id=?')
          .get(thread.id, userId, input.clientId) as Row | undefined;
        if (existing) return { message: this.decode(existing, agentId), created: false };
      }
      if (input.status === 'queued') {
        const count = this.db
          .prepare(
            "SELECT count(*) AS n FROM messages WHERE thread_id=? AND user_id=? AND status='queued'",
          )
          .get(thread.id, userId) as { n: number };
        if (count.n >= MAX_QUEUED_PER_THREAD) throw new ThreadStoreError('queue_full');
      }
      if (input.replyTo !== undefined) {
        const answered = this.db
          .prepare('SELECT id FROM messages WHERE id=? AND thread_id=? AND user_id=?')
          .get(input.replyTo, thread.id, userId);
        if (!answered) throw new ThreadStoreError('reply_to_not_found');
      }
      const message = this.insert(userId, thread, 'sealed', {
        text: JSON.stringify([input.sealed]),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.clientId !== undefined && { clientId: input.clientId }),
        ...(input.turnId !== undefined && { turnId: input.turnId }),
        meta: {
          author: input.author,
          ...(input.replyTo !== undefined && { reply_to: input.replyTo }),
          ...(input.approvalExpiresAt !== undefined && {
            approval: { state: 'pending', expires_at: input.approvalExpiresAt },
          }),
        },
      });
      return { message, created: true };
    });
  }

  /** A message of this person's, in any chat, with the chat's agent. */
  async findMessageForUser(
    userId: string,
    messageId: string,
  ): Promise<{ agentId: string; message: ThreadMessage } | undefined> {
    const row = this.db
      .prepare(
        'SELECT m.*, t.agent_id AS agent_id FROM messages m JOIN threads t ON t.id=m.thread_id AND t.user_id=m.user_id WHERE m.id=? AND m.user_id=?',
      )
      .get(messageId, userId) as (Row & { agent_id: string }) | undefined;
    if (!row) return undefined;
    const message = this.tryDecode(row, row.agent_id);
    return message ? { agentId: row.agent_id, message } : undefined;
  }

  /**
   * Stores one chunk of a computer's sealed reply to a turn. All chunks of a reply live in one
   * agent message, ordered by chunk index: the first chunk adds it, later ones are merged in. A
   * chunk index already stored is a resend (after a reconnect) and changes nothing. Once the final
   * chunk is in, only the missing lower indices are still taken. `complete` is true when the final
   * chunk and every chunk before it are stored.
   */
  async upsertSealedReply(
    userId: string,
    agentId: string,
    input: { turnId: string; sealed: SealedEnvelopeV1; final: boolean },
  ): Promise<
    | { message: ThreadMessage; created: boolean; complete: boolean }
    | 'duplicate'
    | 'after_final'
    | 'too_large'
  > {
    return this.transaction(() => {
      const thread = this.ensureThread(userId, agentId);
      const index = chunkIndex(input.sealed);
      if (index >= MAX_SEALED_REPLY_CHUNKS) return 'too_large';
      const existing = this.db
        .prepare(
          "SELECT * FROM messages WHERE thread_id=? AND user_id=? AND kind='sealed' AND turn_id=? AND client_id IS NULL",
        )
        .get(thread.id, userId, input.turnId) as Row | undefined;
      let stored: SealedEnvelopeV1[] = [];
      let finalIndex: number | undefined;
      if (existing) {
        const decoded = this.decode(existing, agentId);
        if (decoded.kind !== 'sealed') throw new ThreadStoreError('message_unreadable');
        stored = decoded.sealed;
        const meta = JSON.parse(existing.meta) as { final?: boolean; final_index?: number };
        // Rows from before chunking recorded only `final`: their last chunk was the final one.
        finalIndex =
          meta.final_index ??
          (meta.final === true ? Math.max(...stored.map(chunkIndex)) : undefined);
      }
      if (stored.some((envelope) => chunkIndex(envelope) === index)) return 'duplicate';
      if (finalIndex !== undefined && (input.final || index > finalIndex)) return 'after_final';
      if (input.final && stored.some((envelope) => chunkIndex(envelope) > index))
        return 'after_final';
      const sealed = [...stored, input.sealed].sort((a, b) => chunkIndex(a) - chunkIndex(b));
      if (sealed.length > MAX_SEALED_REPLY_CHUNKS) return 'too_large';
      const total = sealed.reduce((sum, envelope) => sum + envelope.body.length, 0);
      if (total > MAX_SEALED_REPLY_TOTAL_CHARS) return 'too_large';
      if (input.final) finalIndex = index;
      const complete = finalIndex !== undefined && sealed.length === finalIndex + 1;
      const meta = {
        author: 'agent',
        ...(finalIndex !== undefined && { final: true, final_index: finalIndex }),
      };
      if (!existing) {
        const message = this.insert(userId, thread, 'sealed', {
          text: JSON.stringify(sealed),
          turnId: input.turnId,
          meta,
        });
        return { message, created: true, complete };
      }
      this.db
        .prepare('UPDATE messages SET body=?,meta=?,rev=?,updated_at=? WHERE id=? AND user_id=?')
        .run(
          JSON.stringify(
            this.cipher.seal(JSON.stringify(sealed), messageAad(userId, thread.id, existing.id)),
          ),
          JSON.stringify(meta),
          thread.next_rev,
          this.now().toISOString(),
          existing.id,
          userId,
        );
      this.db
        .prepare('UPDATE threads SET next_rev=next_rev+1 WHERE id=? AND user_id=?')
        .run(thread.id, userId);
      const row = this.db
        .prepare('SELECT * FROM messages WHERE id=? AND user_id=?')
        .get(existing.id, userId) as Row;
      return { message: this.decode(row, agentId), created: false, complete };
    });
  }

  /** Sealed user messages waiting for their computer, oldest first. */
  async queuedSealed(): Promise<{ userId: string; agentId: string; message: ThreadMessage }[]> {
    const rows = this.db
      .prepare(
        "SELECT m.*, t.agent_id AS agent_id FROM messages m JOIN threads t ON t.id=m.thread_id AND t.user_id=m.user_id WHERE m.kind='sealed' AND m.status='queued' ORDER BY m.seq",
      )
      .all() as (Row & { agent_id: string })[];
    return rows.flatMap((row) => {
      const message = this.tryDecode(row, row.agent_id);
      return message ? [{ userId: row.user_id, agentId: row.agent_id, message }] : [];
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
    patch: {
      status?: UserMessageStatus;
      turnId?: string;
      errorCode?: string;
      /** Changed only while the stored status is one of these (checked in the same transaction). */
      from?: readonly UserMessageStatus[];
    },
  ): Promise<ThreadMessage | undefined> {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM messages WHERE id=? AND user_id=? AND (kind='user_text' OR (kind='sealed' AND client_id IS NOT NULL))",
        )
        .get(messageId, userId) as Row | undefined;
      if (!row) return undefined;
      if (patch.from !== undefined && !patch.from.includes(row.status as UserMessageStatus))
        return undefined;
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

  /**
   * Marks a sealed approval request answered (C3 #11): metadata only, the server never knows the
   * answer. `undefined` when there is no such request; `answered` when it was answered already.
   */
  async answerSealedApproval(
    userId: string,
    agentId: string,
    messageId: string,
  ): Promise<ThreadMessage | 'answered' | undefined> {
    return this.transaction(() => {
      const thread = this.thread(userId, agentId);
      if (!thread) return undefined;
      const row = this.db
        .prepare(
          "SELECT * FROM messages WHERE id=? AND thread_id=? AND user_id=? AND kind='sealed'",
        )
        .get(messageId, thread.id, userId) as Row | undefined;
      if (!row) return undefined;
      const meta = JSON.parse(row.meta) as {
        approval?: { state: 'pending' | 'answered'; expires_at: string };
      };
      if (meta.approval === undefined) return undefined;
      if (meta.approval.state === 'answered') return 'answered';
      this.db
        .prepare('UPDATE messages SET meta=?,rev=?,updated_at=? WHERE id=? AND user_id=?')
        .run(
          JSON.stringify({ ...meta, approval: { ...meta.approval, state: 'answered' } }),
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
        ...(thread.private === 1 && { private: true }),
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
    // A private chat is never read out to an agent through the server (ADR-044).
    if (!thread || thread.private === 1) return [];
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
    if (!thread || thread.private === 1) return 0;
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
        "SELECT * FROM messages WHERE thread_id=? AND user_id=? AND id=? AND (kind='user_text' OR (kind='sealed' AND client_id IS NOT NULL))",
      )
      .get(thread.id, userId, messageId) as Row | undefined;
    return row ? this.decode(row, agentId) : undefined;
  }

  /**
   * Deletes one message and the files on it. `in_progress` while its turn is still with the
   * agent; `missing` when it is not in this person's thread (already deleted, or never there).
   */
  async deleteMessage(
    userId: string,
    agentId: string,
    messageId: string,
  ): Promise<{ result: 'deleted' | 'missing' | 'in_progress'; fileIds: string[] }> {
    return this.transaction(() => {
      const thread = this.thread(userId, agentId);
      if (!thread) return { result: 'missing' as const, fileIds: [] };
      const row = this.db
        .prepare('SELECT kind,status FROM messages WHERE id=? AND thread_id=? AND user_id=?')
        .get(messageId, thread.id, userId) as { kind: string; status: string | null } | undefined;
      if (!row) return { result: 'missing' as const, fileIds: [] };
      if (row.kind === 'user_text' && (row.status === 'sent' || row.status === 'working'))
        return { result: 'in_progress' as const, fileIds: [] };
      const fileIds = (
        this.db
          .prepare('SELECT id FROM files WHERE message_id=? AND user_id=? AND agent_id=?')
          .all(messageId, userId, agentId) as { id: string }[]
      ).map((file) => file.id);
      this.db
        .prepare('DELETE FROM files WHERE message_id=? AND user_id=? AND agent_id=?')
        .run(messageId, userId, agentId);
      this.db.prepare('DELETE FROM messages WHERE id=? AND user_id=?').run(messageId, userId);
      const last = this.db
        .prepare('SELECT max(created_at) AS at FROM messages WHERE thread_id=? AND user_id=?')
        .get(thread.id, userId) as { at: string | null };
      this.db
        .prepare('UPDATE threads SET last_message_at=? WHERE id=? AND user_id=?')
        .run(last.at, thread.id, userId);
      return { result: 'deleted' as const, fileIds };
    });
  }

  /** Files on this person's messages with this agent, newest first, after `before` (exclusive). */
  async listMedia(
    userId: string,
    agentId: string,
    options: { before?: { createdAt: string; id: string }; limit: number },
  ): Promise<{ items: MediaRow[]; hasMore: boolean }> {
    const before = options.before;
    const rows = this.db
      .prepare(
        `SELECT f.* FROM files f JOIN messages m ON m.id=f.message_id AND m.user_id=f.user_id
          JOIN threads t ON t.id=m.thread_id AND t.user_id=f.user_id AND t.agent_id=f.agent_id
          WHERE f.user_id=? AND f.agent_id=? AND f.sealed=0${before ? ' AND (f.created_at<? OR (f.created_at=? AND f.id<?))' : ''}
          ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
      )
      .all(
        userId,
        agentId,
        ...(before ? [before.createdAt, before.createdAt, before.id] : []),
        options.limit + 1,
      ) as StoredFile[];
    return {
      items: rows.slice(0, options.limit).map((row): MediaRow => {
        const file = this.file(row);
        return {
          ...this.attachment(file),
          messageId: file.messageId!,
          direction: file.direction === 'owner' ? 'sent' : 'received',
          createdAt: file.createdAt,
        };
      }),
      hasMore: rows.length > options.limit,
    };
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
      this.db.prepare('DELETE FROM e2e_sealed_rewraps WHERE user_id=?').run(userId);
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
      "m.kind IN ('user_text','sealed') AND m.status IN ('sent','working')",
      [],
      'interrupted',
    ).count;
  }

  /** Queued too long (the computer stayed offline): `expired`. Returns the changed messages. */
  async expireQueued(): Promise<ThreadMessage[]> {
    return this.changeStatuses(
      "m.kind IN ('user_text','sealed') AND m.status='queued' AND m.created_at<?",
      [new Date(this.now().getTime() - QUEUED_MESSAGE_TTL_MS).toISOString()],
      'expired',
    ).messages;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
