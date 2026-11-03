import { z } from 'zod';

import { MAX_NATIVE_MESSAGE_BYTES } from './native-protocol';

/**
 * The local agent connector (ADR-023): a small program on the user's computer that dials OUT to
 * the gateway, so agents like Claude Code, Codex, or Gemini CLI can be called without a public
 * address. It pairs once with a short code, then speaks `cord-relay/1`: `cord-agent/1` frames in
 * reverse (the connector is the agent end), wrapped in per-call channels.
 */

/** The connector's working name. Brand is undecided: rename it here only. */
export const CONNECTOR_CLI_NAME = 'twring-connect';

/** The relay envelope protocol. Breaking changes need a new major version. */
export const RELAY_PROTOCOL = 'cord-relay/1';

/** Accepts `cord-relay/1` and any `cord-relay/1.x` minor revision. */
export function isSupportedRelayProtocol(protocol: string): boolean {
  return /^cord-relay\/1(\.\d+)?$/.test(protocol);
}

/** One relay frame: a whole `cord-agent/1` frame plus its envelope. */
export const MAX_RELAY_MESSAGE_BYTES = MAX_NATIVE_MESSAGE_BYTES + 4096;

/** Calls one connector may carry at once. */
export const MAX_RELAY_CHANNELS = 8;

/** Local agents one connector may offer. */
export const MAX_CONNECTOR_AGENTS = 16;

/** Opaque server-minted connector identifier. */
export const connectorIdSchema = z.string().regex(/^con_[a-z0-9]{20}$/);
export type ConnectorId = z.infer<typeof connectorIdSchema>;

/**
 * Pairing codes use an alphabet without look-alikes (no 0/O, 1/I/L), shown as `XXXX-XXXX`.
 * Entry is case-insensitive and ignores the dash; `normalizePairingCode` gives the stored form.
 */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const pairingCodeSchema = z.string().regex(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);

/**
 * `abcd efgh`, `ABCDEFGH`, or `abcd-efgh` → `ABCD-EFGH`; undefined when it cannot be a code. The
 * dash may be any Unicode dash or the minus sign (U+2010–U+2015, U+2212): phones substitute them.
 */
export function normalizePairingCode(input: string): string | undefined {
  const compact = input.toUpperCase().replace(/[\s\-\u2010-\u2015\u2212]/g, '');
  if (compact.length !== 8) return undefined;
  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return pairingCodeSchema.safeParse(code).success ? code : undefined;
}

export const localAgentKindSchema = z.enum(['claude-code', 'codex', 'acp', 'command', 'openai']);
export type LocalAgentKind = z.infer<typeof localAgentKindSchema>;

/** Id of an agent on the user's computer, as the connector names it (`claude-code`, `gemini`). */
export const localAgentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

/**
 * An agent session to resume (ADR-024): a Claude Code session id or a Codex thread id. It goes back
 * on a command line (`claude --resume <ref>`, `codex exec resume <ref>`), so it must start with a
 * letter or digit: a leading dash would be read as a flag (`--dangerously-…`).
 */
export const SESSION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/**
 * Self-hosted server agents: whose agent session a channel or result belongs to, when the caller
 * is not the agent's owner. Opaque to the computer (an HMAC of the person, never their id). The
 * owner's own channels carry none, exactly as before.
 */
export const sessionScopeSchema = z.string().regex(/^[0-9a-f]{32}$/);

/** `connector.hello` feature: the computer keeps one agent session per `session_scope`. */
export const SCOPED_SESSIONS_FEATURE = 'scoped_sessions';

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_LABEL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029]/;
const safeLabel = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((value) => !UNSAFE_LABEL.test(value), { message: 'Use ordinary characters.' });

/** An agent the connector offers. Only its id and label reach Twring, never its command line. */
export const localAgentSchema = z.object({
  id: localAgentIdSchema,
  label: safeLabel,
  kind: localAgentKindSchema,
});
export type LocalAgent = z.infer<typeof localAgentSchema>;

export const localAgentListSchema = z
  .array(localAgentSchema)
  .min(1)
  .max(MAX_CONNECTOR_AGENTS)
  .refine((agents) => new Set(agents.map((a) => a.id)).size === agents.length, {
    message: 'Agent ids must be unique.',
  });

/** Where a `cord-connector` saved agent lives. */
export interface ConnectorEndpoint {
  connectorId: string;
  localAgent: string;
  /** The agent session to resume (an answered ring, ADR-024); absent for a new session. */
  resumeRef?: string;
}

export function connectorEndpointUrl(connectorId: string, localAgent: string): string {
  return `cord-connector://${connectorId}/${localAgent}`;
}

/** Parses `cord-connector://con_…/<local agent>`; undefined for anything else. */
export function parseConnectorEndpoint(url: string): ConnectorEndpoint | undefined {
  const match = /^cord-connector:\/\/(con_[a-z0-9]{20})\/([a-z0-9][a-z0-9-]{0,31})$/.exec(url);
  if (match === null) return undefined;
  return { connectorId: match[1]!, localAgent: match[2]! };
}

// HTTP API

/** A paired computer, as the app sees it. The token is never returned after the claim. */
export const connectorSchema = z.object({
  id: connectorIdSchema,
  name: safeLabel,
  agents: z.array(localAgentSchema),
  online: z.boolean(),
  created_at: z.iso.datetime(),
  last_seen_at: z.iso.datetime().optional(),
});
export type Connector = z.infer<typeof connectorSchema>;

/** `GET /v1/connectors`, newest first. */
export const connectorListResponseSchema = z.object({ connectors: z.array(connectorSchema) });
export type ConnectorListResponse = z.infer<typeof connectorListResponseSchema>;

/** `POST /v1/connectors/pairings`: a one-time code for `cord-connect --code`. */
export const pairingResponseSchema = z.object({
  pairing_id: z.string().regex(/^pair_[a-z0-9]{20}$/),
  code: pairingCodeSchema,
  expires_at: z.iso.datetime(),
  /** The server's clock when it answered: countdowns use `expires_at - server_time`. */
  server_time: z.iso.datetime().optional(),
});
export type PairingResponse = z.infer<typeof pairingResponseSchema>;

/** `GET /v1/connectors/pairings/:id`: poll until the code is claimed. */
export const pairingStatusResponseSchema = z.object({
  status: z.enum(['pending', 'claimed', 'expired']),
  expires_at: z.iso.datetime(),
  connector: connectorSchema.optional(),
  /** The server's clock when it answered: countdowns use `expires_at - server_time`. */
  server_time: z.iso.datetime().optional(),
});
export type PairingStatusResponse = z.infer<typeof pairingStatusResponseSchema>;

/**
 * `POST /v1/connectors/claim` (unauthenticated: the code is the proof). A computer that is already
 * linked sends its own `Authorization: Bearer cct_…` too: the code then joins that connector to the
 * pairing instead of creating a new one (ADR-027 re-link).
 */
export const claimRequestSchema = z
  .object({
    code: z.string().max(16),
    /** The computer's name, shown in the app. */
    name: safeLabel,
    agents: localAgentListSchema,
    /**
     * Self-hosted servers only: everyone in the space may call these agents. Honoured only for an
     * admin's code; hosted Twring ignores it.
     */
    shared: z.boolean().optional(),
  })
  .strict();
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

/** The long-lived connector token, returned exactly once. */
export const claimResponseSchema = z.object({
  connector_id: connectorIdSchema,
  token: z.string().regex(/^cct_[A-Za-z0-9_-]{43}$/),
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

/**
 * A re-link (a claim sent with the computer's existing token): no new token, the computer keeps
 * the one it has (ADR-027). 200, where a fresh claim is 201.
 */
export const relinkResponseSchema = z.object({
  connector_id: connectorIdSchema,
  reused: z.literal(true),
});
export type RelinkResponse = z.infer<typeof relinkResponseSchema>;

// `cord-relay/1` WebSocket frames (`/v1/connectors/socket`, Authorization: Bearer <token>)

const channelId = z.string().regex(/^ch_[a-z0-9]{1,40}$/);

/** Connector → gateway, first frame. */
export const relayHelloSchema = z.object({
  type: z.literal('connector.hello'),
  protocol: z.string().max(32),
  /** The agent protocol carried inside channels. */
  agent_protocol: z.string().max(32),
  agents: localAgentListSchema,
  version: z.string().max(32).optional(),
  /** What this computer supports, e.g. `scoped_sessions`. Older computers send none. */
  features: z.array(z.string().max(32)).max(16).optional(),
});

/** Either direction: one `cord-agent/1` frame for a channel. Checked by the receiving end. */
export const relayChannelMessageSchema = z.object({
  type: z.literal('channel.message'),
  channel: channelId,
  message: z.record(z.string(), z.unknown()),
});

/** Either direction: the channel (one call's agent session) is over. */
export const relayChannelCloseSchema = z.object({
  type: z.literal('channel.close'),
  channel: channelId,
});

export const relayConnectorMessageSchema = z.discriminatedUnion('type', [
  relayHelloSchema,
  relayChannelMessageSchema,
  relayChannelCloseSchema,
]);
export type RelayConnectorMessage = z.infer<typeof relayConnectorMessageSchema>;

/** Gateway → connector. */
export const relayGatewayMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connector.ready'),
    features: z.array(z.string().max(32)).max(16).optional(),
    protocol: z.string().max(32),
    connector_id: connectorIdSchema,
    name: z.string().max(60),
  }),
  z.object({
    type: z.literal('channel.open'),
    channel: channelId,
    agent: localAgentIdSchema,
    /** Resume this agent session (ADR-024); a new session when it can't be resumed. */
    resume_ref: z.string().regex(SESSION_REF_PATTERN).optional(),
    /** Start a new agent session: forget the saved session and don't resume. Older connectors strip this unknown key. */
    fresh_session: z.literal(true).optional(),
    /** Someone other than the owner (a shared server agent): use this person's own session. */
    session_scope: sessionScopeSchema.optional(),
  }),
  relayChannelMessageSchema,
  relayChannelCloseSchema,
]);
export type RelayGatewayMessage = z.infer<typeof relayGatewayMessageSchema>;

export const newConversationResponseSchema = z.object({ ok: z.literal(true) });

/** WebSocket close codes the gateway uses on the relay socket. */
export const RELAY_CLOSE = {
  /** The hello was missing, malformed, or for an unsupported protocol. */
  protocolError: 4400,
  /** The connector was revoked (or the user's data deleted). Do not reconnect. */
  revoked: 4403,
  /** A newer socket for the same connector took over. Do not reconnect. */
  replaced: 4409,
} as const;

// Computer-first linking (ADR-025): the computer asks, the phone approves.

/** Agents one link request may offer (fewer than a connector's: the request is unauthenticated). */
export const MAX_LINK_REQUEST_AGENTS = 8;

/**
 * Invisible characters a stranger's computer could use to make its name look like another on the
 * "Link <computer>?" screen: bidi marks (LRM, RLM, ALM), zero-width space, word joiner and other
 * invisible operators, the byte-order mark, the soft hyphen, and the Mongolian vowel separator.
 * ZWJ/ZWNJ stay allowed (Indic scripts need them). Link requests are unauthenticated, so their
 * names are held to this stricter rule on top of the usual one.
 */
export const LINK_INVISIBLE = /[\u00ad\u061c\u180e\u200b\u200e\u200f\u2060-\u2064\ufeff]/;

const linkText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !UNSAFE_LABEL.test(value) && !LINK_INVISIBLE.test(value), {
      message: 'Use ordinary characters.',
    });

/** A computer's host name as shown in the app: trimmed, at most 40 ordinary characters. */
export const computerNameSchema = linkText(40);

/** An agent a computer offers when it asks to be linked. */
export const linkAgentSchema = z.object({
  local_agent: localAgentIdSchema,
  kind: localAgentKindSchema,
  label: linkText(60),
});
export type LinkAgent = z.infer<typeof linkAgentSchema>;

export const linkAgentListSchema = z
  .array(linkAgentSchema)
  .min(1)
  .max(MAX_LINK_REQUEST_AGENTS)
  .refine((agents) => new Set(agents.map((a) => a.local_agent)).size === agents.length, {
    message: 'Agent ids must be unique.',
  });

/** `POST /v1/connectors/link-requests` (unauthenticated, rate limited per IP). */
export const createLinkRequestSchema = z
  .object({ computer_name: computerNameSchema, agents: linkAgentListSchema })
  .strict();
export type CreateLinkRequest = z.infer<typeof createLinkRequestSchema>;

export const linkRequestIdSchema = z.string().regex(/^link_[a-z0-9]{20}$/);

/** A poll token: `clp_` + 43 base64url characters (32 random bytes). Only its hash is kept. */
export const linkPollTokenSchema = z.string().regex(/^clp_[A-Za-z0-9_-]{43}$/);

export const createLinkResponseSchema = z.object({
  request_id: linkRequestIdSchema,
  /** Shown as `XXXX-XXXX` on the computer and inside its QR code. */
  code: pairingCodeSchema,
  poll_token: linkPollTokenSchema,
  expires_at: z.iso.datetime(),
  server_time: z.iso.datetime(),
});
export type CreateLinkResponse = z.infer<typeof createLinkResponseSchema>;

/** `GET /v1/connectors/link-requests/:id?wait=25` (Authorization: Bearer <poll_token>). */
export const linkPollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({
    status: z.literal('approved'),
    /** The long-lived connector token, delivered exactly once. */
    connector_token: z.string().regex(/^cct_[A-Za-z0-9_-]{43}$/),
    connector_id: connectorIdSchema,
    /** Who approved, when the server knows a display name. */
    owner_name: z.string().max(80).optional(),
  }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('rejected') }),
]);
export type LinkPollResponse = z.infer<typeof linkPollResponseSchema>;

/** `GET /v1/link-requests/:code` (signed in): what the phone shows before approving. */
export const linkRequestDetailsSchema = z.object({
  computer_name: z.string().max(40),
  agents: z.array(linkAgentSchema),
  expires_at: z.iso.datetime(),
  server_time: z.iso.datetime(),
});
export type LinkRequestDetails = z.infer<typeof linkRequestDetailsSchema>;

/** `POST /v1/link-requests/:code/approve` (signed in): the new computer. */
export const linkApproveResponseSchema = z.object({
  connector_id: connectorIdSchema,
  computer_name: z.string().max(40),
  agents: z.array(linkAgentSchema),
});
export type LinkApproveResponse = z.infer<typeof linkApproveResponseSchema>;

/** What the computer's QR code holds: `cord://link?code=ABCDEFGH&server=<url-encoded server>`. */
export function linkQrPayload(code: string, server: string): string {
  const compact = code.replace(/-/g, '');
  return `cord://link?code=${compact}&server=${encodeURIComponent(server.replace(/\/+$/, ''))}`;
}

/**
 * Reads a scanned QR code or a typed code; undefined when it is neither. A QR code carries the
 * server it came from so the phone can refuse one made for another server.
 */
export function parseLinkInput(input: string): { code: string; server?: string } | undefined {
  const text = input.trim();
  if (/^cord:\/\/link\?/i.test(text)) {
    // Parsed by hand: React Native's URLSearchParams is incomplete.
    const params = new Map<string, string>();
    for (const pair of text.slice(text.indexOf('?') + 1).split('&')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      try {
        params.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
      } catch {
        return undefined;
      }
    }
    const code = normalizePairingCode(params.get('code') ?? '');
    const server = params.get('server');
    if (code === undefined || server === undefined || server === '') return undefined;
    return { code, server: server.replace(/\/+$/, '') };
  }
  const code = normalizePairingCode(text);
  return code === undefined ? undefined : { code };
}
