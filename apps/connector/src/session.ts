import { randomUUID } from 'node:crypto';

import {
  MAX_ACTIVITY_LABEL_CHARS,
  MAX_AGENT_DELTA_CHARS,
  NATIVE_PROTOCOL,
  TEXT_TURN_TAG,
  nativeClientMessageSchema,
  type AgentEvent,
  type TurnAttachment,
} from '@twring/contracts';

import { LocalAgentError, type LocalAgentAdapter } from './events';
import { downloadTurnFiles } from './turn-files';
import { UploadError, type UploadFileOptions } from './upload';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<AgentEvent, 'event_id' | 'turn_id' | 'seq'>;

/** The agent end of `cord-agent/1` for one relay channel (one call). */
export interface ChannelSessionOptions {
  /** Undefined when the gateway asked for an agent this computer does not offer. */
  adapter: LocalAgentAdapter | undefined;
  /** Linked gateway origin used to check signed file links. */
  server?: string | URL;
  uploadFile?: (
    file: Pick<UploadFileOptions, 'bytes' | 'name' | 'mimeType' | 'clientId' | 'signal'>,
  ) => Promise<string>;
  send(message: Record<string, unknown>): void;
  log?(line: string): void;
  runExclusive?(fn: () => Promise<void>): Promise<void>;
  onBackgroundResult?(text: string, turn: { turnId: string; surface: 'call' | 'text' }): void;
  backgroundTurnMaxMs?: number;
  /** A call turn that used no tool and ends this soon after the hang-up is talk, not work. */
  backgroundTalkMs?: number;
  /** Quiet time after which a running turn sends a keep-alive `activity` (default 10 s). */
  keepAliveMs?: number;
  /** Activity labels go out at most this often; the latest wins (default 500 ms). */
  activityIntervalMs?: number;
}

/** Keep-alive every 10 s: well inside the gateway's 30 s idle budget for a quiet agent. */
export const KEEP_ALIVE_MS = 10_000;
/** At most two activity labels a second reach the phone, however fast the agent reports them. */
export const ACTIVITY_INTERVAL_MS = 500;
export const BACKGROUND_TURN_MAX_MS = 30 * 60_000;
/**
 * A reply still being spoken at hang-up ("Okay, bye!") is not work, so it must not ring the owner
 * back. A call turn counts as work once it uses a tool or runs this long after the call ends.
 */
export const BACKGROUND_TALK_MS = 15_000;
/** What a keep-alive says when the agent has not said what it is doing. */
const WORKING_LABEL = 'Working…';
/** What a turn says while it waits for the agent to finish another one. */
export const QUEUED_LABEL = 'Finishing your last message…';

interface ActiveTurn {
  turnId: string;
  controller: AbortController;
  started: number;
  text: string;
  surface: 'call' | 'text';
  pendingApproval?: string;
  /** The agent used a tool during this turn. */
  worked?: boolean;
  /** When the call ended while this turn ran. */
  detachedAt?: number;
  backgroundTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Answers the gateway's `session.hello`, `ping`, `user.turn`, and `turn.cancel` for one call and
 * turns the local agent's events into Twring `AgentEvent`s. A turn runs exactly once: nothing here
 * ever retries or replays one. A new turn while one runs supersedes it (the gateway cancels first).
 */
export class ChannelSession {
  private active: ActiveTurn | null = null;
  private readonly runExclusive: (fn: () => Promise<void>) => Promise<void>;
  private closed = false;
  /** A turn cancelled while it still waited for the previous one to wind down. */
  private cancelledEarly: string | null = null;

  constructor(private readonly options: ChannelSessionOptions) {
    if (options.runExclusive !== undefined) {
      this.runExclusive = (fn) => options.runExclusive!(fn);
    } else {
      let previous = Promise.resolve();
      this.runExclusive = (fn) => {
        const run = previous.then(fn);
        previous = run.catch(() => undefined);
        return run;
      };
    }
  }

  handle(raw: unknown): void {
    if (this.closed) return;
    const parsed = nativeClientMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case 'session.hello':
        if (this.options.adapter === undefined) {
          this.options.send({ type: 'session.error', code: 'agent_error' });
          return;
        }
        this.options.send({
          type: 'session.ready',
          protocol: NATIVE_PROTOCOL,
          capabilities: {
            streaming_text: true,
            cancel: true,
            activity: true,
            tools: true,
            approvals: true,
          },
        });
        return;
      case 'ping':
        this.options.send({ type: 'pong', id: message.id });
        return;
      case 'turn.cancel':
        // The gateway cancels the running turn as the call ends; that is a hang-up, not the
        // owner saying stop, so the work goes on in the background (ADR-030).
        if (message.reason === 'call_ended') {
          this.close();
          return;
        }
        if (this.active?.turnId === message.turn_id) this.active.controller.abort();
        else this.cancelledEarly = message.turn_id;
        return;
      case 'approval.decision':
        if (this.active?.turnId === message.turn_id) {
          this.options.adapter?.decide?.(message.approval_id, message.decision);
          if (this.active.pendingApproval === message.approval_id)
            this.active.pendingApproval = undefined;
        }
        return;
      case 'user.turn': {
        this.active?.controller.abort();
        const turnId = message.turn_id;
        // The turn may wait while this agent finishes another one (a typed message in the chat).
        // Until it starts, keep-alives tell the gateway it is queued, not dead: a call's first
        // turn would otherwise run out its first-event budget (text-threads plan §2).
        const queued: { seq: number; timer?: ReturnType<typeof setTimeout> } = { seq: 0 };
        const keepAliveMs = this.options.keepAliveMs ?? KEEP_ALIVE_MS;
        const waitQuietly = () => {
          queued.timer = setTimeout(() => {
            if (this.closed || this.cancelledEarly === turnId) return;
            this.options.send({
              type: 'activity',
              label: QUEUED_LABEL,
              event_id: `evt_${randomUUID()}`,
              turn_id: turnId,
              seq: queued.seq++,
            });
            waitQuietly();
          }, keepAliveMs);
        };
        waitQuietly();
        void this.runExclusive(() => {
          clearTimeout(queued.timer);
          return this.run(
            turnId,
            message.text,
            message.surface ?? 'call',
            queued.seq,
            message.attachments,
          );
        });
        return;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const turn = this.active;
    if (turn !== null && !turn.controller.signal.aborted) {
      this.options.log?.(
        turn.surface === 'text'
          ? 'text turn continues after the channel closes'
          : 'turn continues after the call',
      );
      if (turn.pendingApproval !== undefined) {
        this.options.adapter?.decide?.(turn.pendingApproval, 'deny');
        turn.pendingApproval = undefined;
      }
      turn.detachedAt = Date.now();
      turn.backgroundTimer = setTimeout(
        () => turn.controller.abort(),
        this.options.backgroundTurnMaxMs ?? BACKGROUND_TURN_MAX_MS,
      );
      turn.backgroundTimer.unref?.();
    }
  }

  private async run(
    turnId: string,
    text: string,
    surface: 'call' | 'text',
    firstSeq = 0,
    attachments?: TurnAttachment[],
  ): Promise<void> {
    const adapter = this.options.adapter;
    if (adapter === undefined || this.closed || this.cancelledEarly === turnId) return;
    const controller = new AbortController();
    const turn: ActiveTurn = { turnId, controller, started: Date.now(), text: '', surface };
    this.active = turn;
    let seq = firstSeq;
    const keepAliveMs = this.options.keepAliveMs ?? KEEP_ALIVE_MS;
    const activityIntervalMs = this.options.activityIntervalMs ?? ACTIVITY_INTERVAL_MS;
    /** What the agent is doing now (a running tool or its latest activity), for keep-alives. */
    let label: string | undefined;
    let keepAlive: ReturnType<typeof setTimeout> | undefined;
    let lastActivityAt = -Infinity;
    let pendingLabel: string | undefined;
    let activityTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const send = (body: EventBody) => {
      if (this.closed || finished) return;
      this.options.send({ ...body, event_id: `evt_${randomUUID()}`, turn_id: turnId, seq: seq++ });
      clearTimeout(keepAlive);
      if (body.type === 'done') {
        finished = true;
        return;
      }
      // The agent process is alive and the turn is open: while it works quietly (a long tool
      // run), a keep-alive tells the gateway so its idle timer does not end the turn. It adds no
      // speech; the phone keeps showing the working state.
      keepAlive = setTimeout(() => {
        if (activityTimer === undefined) sendActivity(label ?? WORKING_LABEL);
      }, keepAliveMs);
    };
    const sendActivity = (text: string) => {
      lastActivityAt = Date.now();
      send({ type: 'activity', label: text.slice(0, MAX_ACTIVITY_LABEL_CHARS) });
    };
    /** Sends a coalesced label still waiting (or drops it), before anything that must follow it. */
    const flushActivity = (drop = false) => {
      clearTimeout(activityTimer);
      activityTimer = undefined;
      const text = pendingLabel;
      pendingLabel = undefined;
      if (text !== undefined && !drop) sendActivity(text);
    };
    const emit = (body: EventBody) => {
      // A label still waiting is stale once the turn ends.
      flushActivity(body.type === 'done' || body.type === 'error');
      send(body);
    };
    /** At most one label per `activityIntervalMs`; a flood keeps only its latest value. */
    const activity = (text: string) => {
      label = text;
      const wait = lastActivityAt + activityIntervalMs - Date.now();
      if (wait <= 0 && activityTimer === undefined) {
        sendActivity(text);
        return;
      }
      pendingLabel = text;
      activityTimer ??= setTimeout(() => flushActivity(), Math.max(0, wait));
    };
    const started = Date.now();
    let messageId: string | null = null;
    const closeText = () => {
      if (messageId !== null) emit({ type: 'text.end', message_id: messageId });
      messageId = null;
    };
    // At once, as always: run.started is what tells the gateway the turn is alive.
    emit({ type: 'run.started' });
    let checkedNewSession = false;
    let cleanup: (() => Promise<void>) | undefined;
    const pendingUploads: Promise<void>[] = [];
    try {
      const server = this.options.server;
      const wantsFiles = surface === 'text' && attachments !== undefined && attachments.length > 0;
      if (wantsFiles)
        // Large files can take a while; this keeps the gateway's idle budget from running out
        // and tells the owner what is happening.
        emit({ type: 'activity', label: 'Opening your files…' });
      const files =
        wantsFiles && server !== undefined
          ? await downloadTurnFiles(attachments, { server, turnId, signal: controller.signal })
          : undefined;
      cleanup = files === undefined ? undefined : () => files.cleanup();
      for await (const event of adapter.sendTurn(
        surface === 'text' ? `${TEXT_TURN_TAG}\n${text}` : text,
        controller.signal,
        { surface, ...(files !== undefined && { files: files.files }) },
      )) {
        if (controller.signal.aborted) break;
        // An adapter learns it had to replace the session it was asked to continue while it opens
        // the agent, i.e. by its first event. Say so once, before that event, so the chat can show
        // "New conversation" above the answer.
        if (!checkedNewSession) {
          checkedNewSession = true;
          if (adapter.takeNewSession?.() === true) emit({ type: 'run.started', new_session: true });
        }
        switch (event.type) {
          case 'text':
            // Only what the owner did not hear: the result, not the acknowledgement they heard.
            if (this.closed) turn.text += event.text;
            if (messageId === null) {
              messageId = `msg_${randomUUID()}`;
              emit({ type: 'text.start', message_id: messageId });
            }
            for (let i = 0; i < event.text.length; i += MAX_AGENT_DELTA_CHARS) {
              emit({
                type: 'text.delta',
                message_id: messageId,
                delta: event.text.slice(i, i + MAX_AGENT_DELTA_CHARS),
              });
            }
            break;
          case 'tool.start':
            closeText();
            turn.worked = true;
            label = event.label ?? label;
            emit({
              type: 'tool.start',
              tool_call_id: event.id.slice(0, 128),
              tool_name: event.name.slice(0, 128),
              ...(event.label !== undefined && {
                display_label: event.label.slice(0, MAX_ACTIVITY_LABEL_CHARS),
              }),
            });
            break;
          case 'tool.end':
            label = undefined;
            emit({ type: 'tool.end', tool_call_id: event.id.slice(0, 128), status: event.status });
            break;
          case 'activity':
            activity(event.label);
            break;
          case 'file':
            if (surface !== 'text' || this.options.uploadFile === undefined) break;
            closeText();
            // Send this immediately even if another activity label is being coalesced.
            flushActivity(true);
            sendActivity('Sending a file…');
            pendingUploads.push(
              this.options
                .uploadFile({
                  bytes: event.data,
                  name: event.name,
                  mimeType: event.mimeType,
                  clientId: randomUUID(),
                  signal: controller.signal,
                })
                .then(
                  (fileId) => {
                    if (!controller.signal.aborted)
                      emit({
                        type: 'file',
                        name: event.name,
                        mime_type: event.mimeType,
                        file_id: fileId,
                      });
                  },
                  (error: unknown) => {
                    this.options.log?.(
                      `file upload failed (${error instanceof UploadError ? error.code : 'upload_failed'})`,
                    );
                  },
                ),
            );
            break;
          case 'approval.required':
            closeText();
            if (this.closed) {
              adapter.decide?.(event.id, 'deny');
              break;
            }
            turn.pendingApproval = event.id;
            emit({
              type: 'approval.required',
              approval_id: event.id,
              action: event.action,
              title: event.title,
              ...(event.description !== undefined && { description: event.description }),
            });
            break;
        }
      }
      await Promise.all(pendingUploads);
      closeText();
      emit({ type: 'done', status: controller.signal.aborted ? 'cancelled' : 'completed' });
      if (this.closed) {
        const talkOnly =
          surface === 'call' &&
          turn.worked !== true &&
          Date.now() - (turn.detachedAt ?? 0) <
            (this.options.backgroundTalkMs ?? BACKGROUND_TALK_MS);
        if (!controller.signal.aborted && turn.text.trim() !== '' && talkOnly)
          this.options.log?.('background turn was only talk; not delivered');
        else if (!controller.signal.aborted && turn.text.trim() !== '') {
          this.options.log?.(
            `background ${surface === 'text' ? 'text ' : ''}turn done in ${Date.now() - turn.started} ms`,
          );
          this.options.onBackgroundResult?.(turn.text.trim(), { turnId, surface });
        } else
          this.options.log?.(
            `background ${surface === 'text' ? 'text ' : ''}turn ended without a result`,
          );
      } else
        this.options.log?.(
          `turn ${controller.signal.aborted ? 'cancelled' : 'done'} in ${Date.now() - started} ms`,
        );
    } catch (error) {
      closeText();
      if (controller.signal.aborted) {
        emit({ type: 'done', status: 'cancelled' });
      } else {
        const code = error instanceof LocalAgentError ? error.code : 'agent_failed';
        emit({ type: 'error', code: code.slice(0, 64), retryable: false });
        emit({ type: 'done', status: 'failed' });
        if (!this.closed) this.options.log?.(`turn failed (${code})`);
      }
      if (this.closed)
        this.options.log?.(
          `background ${surface === 'text' ? 'text ' : ''}turn ended without a result`,
        );
    } finally {
      await cleanup?.();
      finished = true;
      clearTimeout(turn.backgroundTimer);
      clearTimeout(keepAlive);
      clearTimeout(activityTimer);
      if (this.active === turn) this.active = null;
    }
  }
}
