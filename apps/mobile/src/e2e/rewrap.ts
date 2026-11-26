import {
  base64urlDecode,
  e2eDeviceIdSchema,
  MAX_PAIRED_DEVICES,
  messageAad,
  publicKeySchema,
  sealedKeysPageSchema,
  unwrapKey,
  wrapKey,
  type SealedEnvelopeV1,
  type SealedKeysUpload,
  type ThreadMessage,
} from '@twring/contracts';
import { z } from 'zod';

import type { SecureKeyValue } from '../auth/storage';
import { loadDeviceKey, type DeviceKey } from './device-key';
import { loadTrusted, type TrustedDevice } from './pairing';
import { aadIdsFor, aadsToTry, type Rewrap, type SealedThreadMessage } from './sealed-thread';

/**
 * Older private messages for a phone approved later (C3 #11 Task 28). The approving phone opens
 * each message key meant for itself and wraps it again, from its own key to the new phone's,
 * under the message's own AAD. The server only stores the wraps; the new phone takes one only
 * from a phone it trusts. Logs carry ids and counts only.
 */

/** Jobs per new phone: one cursor per chat, kept in the keychain so a restart resumes. */
export const REWRAP_JOBS_KEY = 'twring.e2e.rewrap.v1';
/** Items per upload (P4b2 brief). */
export const REWRAP_BATCH = 200;
/** Messages per page read; two pages make one batch at most. */
const PAGE = 100;

const chatCursorSchema = z
  .object({
    /** The lowest message seq already shared: the next page starts below it. */
    before: z.number().int().positive().optional(),
    done: z.boolean().optional(),
  })
  .strict();
const jobSchema = z
  .object({
    for: e2eDeviceIdSchema,
    public_key: publicKeySchema,
    /** Set by each approve, so a run that started earlier never saves over a newer approve. */
    queued: z.string().max(40).optional(),
    /** The server said the new phone is gone: never tried again. */
    stopped: z.boolean().optional(),
    chats: z.record(z.string().max(64), chatCursorSchema),
  })
  .strict();
const jobsSchema = z.array(jobSchema).max(MAX_PAIRED_DEVICES);
type Job = z.infer<typeof jobSchema>;

type Answer = { status: number; body: unknown };
type Log = (event: string, fields?: Record<string, string | number>) => void;

export interface RewrapApi {
  upload(agentId: string, body: SealedKeysUpload): Promise<Answer>;
  read(agentId: string, deviceId: string, after?: string): Promise<Answer>;
}

export interface RewrapDeps {
  store: SecureKeyValue;
  api: Pick<RewrapApi, 'upload'>;
  /** This phone's private chats, with each agent's address (for the AAD ids). */
  privateChats(): Promise<{ agentId: string; address: string }[]>;
  /** One page of a chat, newest first below `beforeSeq`. */
  messages(
    agentId: string,
    beforeSeq?: number,
  ): Promise<{ messages: ThreadMessage[]; hasMore: boolean }>;
  log?: Log;
}

async function loadJobs(store: SecureKeyValue): Promise<Job[]> {
  const raw = await store.getItemAsync(REWRAP_JOBS_KEY);
  if (raw === null) return [];
  try {
    const parsed = jobsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const saveJobs = (store: SecureKeyValue, jobs: Job[]) =>
  store.setItemAsync(REWRAP_JOBS_KEY, JSON.stringify(jobs));

/** After an approve: share older messages with the new phone. A repeat starts over cleanly. */
export async function queueRewrap(
  store: SecureKeyValue,
  device: { id: string; public_key: string },
): Promise<void> {
  const jobs = (await loadJobs(store)).filter((j) => j.for !== device.id);
  await saveJobs(
    store,
    [
      ...jobs,
      { for: device.id, public_key: device.public_key, queued: newQueuedMark(), chats: {} },
    ].slice(-MAX_PAIRED_DEVICES),
  );
}

const newQueuedMark = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Whether any job still has work, so the app knows to run them when it opens. */
export async function hasRewrapWork(store: SecureKeyValue): Promise<boolean> {
  return (await loadJobs(store)).some((j) => !j.stopped);
}

const running = new WeakMap<SecureKeyValue, Promise<void>>();

/**
 * Runs every unfinished job; one run at a time per keychain. Never throws: a failure leaves the
 * cursor where it was, so the next app open tries again from there.
 */
export function runRewrapJobs(deps: RewrapDeps): Promise<void> {
  const current = running.get(deps.store);
  if (current !== undefined) return current;
  const work = runAll(deps)
    .catch(() => {
      deps.log?.('e2e_rewrap_failed');
    })
    .finally(() => running.delete(deps.store));
  running.set(deps.store, work);
  return work;
}

async function runAll(deps: RewrapDeps): Promise<void> {
  const jobs = await loadJobs(deps.store);
  if (!jobs.some((j) => !j.stopped)) return;
  const me = await loadDeviceKey(deps.store);
  if (me === undefined) return;
  const chats = (await deps.privateChats()).flatMap((c) => {
    const ids = aadIdsFor(c.address);
    return ids === undefined ? [] : [{ agentId: c.agentId, ids }];
  });
  const finished = (j: Job) => chats.every((c) => j.chats[c.agentId]?.done === true);
  const trusted = await loadTrusted(deps.store);
  for (const job of jobs) {
    if (job.stopped) continue;
    // Only for a phone this phone still trusts, under the key it approved: a phone removed
    // since (or a job naming another key) is never shared with.
    if (
      !trusted.some(
        (d) => d.id === job.for && d.kind === 'phone' && d.public_key === job.public_key,
      )
    ) {
      job.stopped = true;
      await saveJob(deps.store, job);
      deps.log?.('e2e_rewrap_stopped', { device_id: job.for });
      continue;
    }
    let ended: 'stopped' | 'superseded' | undefined;
    for (const chat of chats) {
      if (job.chats[chat.agentId]?.done === true) continue;
      let result: Awaited<ReturnType<typeof runChat>>;
      try {
        result = await runChat(deps, me, job, chat.agentId, chat.ids);
      } catch {
        // This chat could not be read now (offline, a server error): its cursor stays, so the
        // next open tries it again, and the other chats still go ahead.
        deps.log?.('e2e_rewrap_chat_failed', { device_id: job.for });
        continue;
      }
      if (result === 'stopped' || result === 'superseded') {
        ended = result;
        break;
      }
    }
    if (ended === undefined && !job.stopped && finished(job))
      deps.log?.('e2e_rewrap_done', { device_id: job.for });
  }
  // Finished jobs are dropped; a stopped one is kept so it is never started again by mistake.
  await saveJobs(
    deps.store,
    (await loadJobs(deps.store)).filter((j) => j.stopped === true || !finished(j)),
  );
}

/**
 * Saves this job's state (re-read first, so another job's saved progress is kept). False when the
 * job is gone or the phone was approved again since this run read it: that newer job is kept.
 */
async function saveJob(store: SecureKeyValue, job: Job): Promise<boolean> {
  const jobs = await loadJobs(store);
  const at = jobs.findIndex((j) => j.for === job.for);
  if (at === -1 || jobs[at].queued !== job.queued) return false;
  jobs[at] = job;
  await saveJobs(store, jobs);
  return true;
}

function errorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: { code?: unknown } }).error;
  return typeof error?.code === 'string' ? error.code : undefined;
}

async function runChat(
  deps: RewrapDeps,
  me: DeviceKey,
  job: Job,
  agentId: string,
  ids: { accountId: string; agentId: string },
): Promise<'done' | 'stopped' | 'failed' | 'superseded'> {
  const trusted = await loadTrusted(deps.store);
  const target = base64urlDecode(job.public_key);
  let cursor = job.chats[agentId] ?? {};
  for (;;) {
    const items: SealedKeysUpload['items'] = [];
    let before = cursor.before;
    let end = false;
    for (let pages = 0; pages < REWRAP_BATCH / PAGE; pages++) {
      const page = await deps.messages(agentId, before);
      for (const m of page.messages) {
        if (before === undefined || m.seq < before) before = m.seq;
        if (m.kind !== 'sealed') continue;
        const wrapped = rewrapOne(m, { me, trusted, ids, target });
        if (wrapped !== undefined) items.push({ message_id: m.id, wrapped });
      }
      if (!page.hasMore || page.messages.length === 0) {
        end = true;
        break;
      }
    }
    if (items.length > 0) {
      const answer = await deps.api.upload(agentId, {
        device_id: me.deviceId,
        for: job.for,
        items,
      });
      if (answer.status === 409 && errorCode(answer.body) === 'unknown_device') {
        job.stopped = true;
        await saveJob(deps.store, job);
        deps.log?.('e2e_rewrap_stopped', { device_id: job.for });
        return 'stopped';
      }
      if (answer.status < 200 || answer.status >= 300) {
        deps.log?.('e2e_rewrap_upload_failed', { status: answer.status });
        return 'failed';
      }
      deps.log?.('e2e_rewrap_sent', { device_id: job.for, count: items.length });
    }
    // Saved only after the upload: a restart repeats at most this batch, which the server
    // replaces row for row, so nothing is stored twice.
    cursor = { ...(before !== undefined && { before }), ...(end && { done: true }) };
    job.chats[agentId] = cursor;
    if (!(await saveJob(deps.store, job))) return 'superseded';
    if (end) return 'done';
  }
}

/**
 * One message's key, wrapped again for the new phone. Undefined when this phone cannot open it
 * (no key for it, an unknown sender, a broken wrap, or chunks that do not share one key).
 */
export function rewrapOne(
  m: SealedThreadMessage,
  a: {
    me: DeviceKey;
    trusted: readonly TrustedDevice[];
    ids: { accountId: string; agentId: string };
    target: Uint8Array;
  },
): string | undefined {
  const envelopes = [...m.sealed].sort((x, y) => (x.chunk?.index ?? 0) - (y.chunk?.index ?? 0));
  const first = envelopes[0];
  if (first === undefined) return undefined;
  const sender = first.sender_device;
  const senderKey =
    sender === a.me.deviceId
      ? a.me.publicKey
      : (() => {
          const found = a.trusted.find((d) => d.id === sender);
          return found && base64urlDecode(found.public_key);
        })();
  if (senderKey === undefined) return undefined;
  // Its own wraps open under v2 (final flag bound) or v1; the re-wrap stays under the first
  // envelope's v1 AAD, which the new phone checks (`rewrappedKey`).
  const unwrap = (wrapped: string, e: SealedEnvelopeV1): Uint8Array | undefined => {
    for (const aad of aadsToTry(a.ids, e)) {
      try {
        return unwrapKey(wrapped, a.me.privateKey, senderKey, aad);
      } catch {
        // Next AAD.
      }
    }
    return undefined;
  };
  let key: Uint8Array | undefined;
  for (const e of envelopes) {
    if (e.sender_device !== sender || e.sender_seq !== first.sender_seq) return undefined;
    const mine = e.keys.find((k) => k.device === a.me.deviceId);
    if (mine === undefined) return undefined;
    const k = unwrap(mine.wrapped, e);
    if (k === undefined) return undefined;
    if (key === undefined) key = k;
    else if (!sameBytes(key, k)) return undefined;
  }
  if (key === undefined) return undefined;
  return wrapKey(
    key,
    a.me.privateKey,
    a.target,
    messageAad({
      ...a.ids,
      senderDevice: first.sender_device,
      senderSeq: first.sender_seq,
      ...(first.chunk !== undefined && { chunk: first.chunk.index }),
    }),
  );
}

function sameBytes(x: Uint8Array, y: Uint8Array): boolean {
  return x.length === y.length && x.every((b, i) => b === y[i]);
}

/** Re-wraps for this phone in one chat, every page; `undefined` when they could not be read. */
export async function readRewraps(
  api: Pick<RewrapApi, 'read'>,
  agentId: string,
  deviceId: string,
): Promise<Map<string, Rewrap> | undefined> {
  const out = new Map<string, Rewrap>();
  let after: string | undefined;
  // Bounded: 2,000 messages per thread at 500 per page.
  for (let i = 0; i < 10; i++) {
    const answer = await api.read(agentId, deviceId, after);
    if (answer.status !== 200) return undefined;
    const page = sealedKeysPageSchema.safeParse(answer.body);
    if (!page.success) return undefined;
    for (const item of page.data.items)
      out.set(item.message_id, { by: item.by, wrapped: item.wrapped });
    if (page.data.next === undefined) return out;
    after = page.data.next;
  }
  return out;
}
