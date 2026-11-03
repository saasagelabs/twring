export type NormalizedAddress = { ok: true; address: string } | { ok: false; message: string };

const HTTPS_ONLY = 'The address must start with https://';
const BAD_ADDRESS = 'That address does not look right. Use a name like twring.example.com.';

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function validHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (IPV4.test(host)) return host.split('.').every((part) => Number(part) <= 255);
  return HOST_NAME.test(host);
}

/**
 * The strict gate for every server address: `https://host[:port]` only (`http://` when
 * `allowHttp`, for development). The host is a name or IPv4 literal and the port 1 to 65535; no
 * path, query, fragment or user info. A bare host gets `https://`. The result is lower case
 * without a trailing slash.
 */
export function normalizeAddress(text: string, opts: { allowHttp: boolean }): NormalizedAddress {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, message: BAD_ADDRESS };
  let protocol = 'https';
  let rest = trimmed;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme) {
    protocol = scheme[1].toLowerCase();
    rest = trimmed.slice(scheme[0].length);
    if (protocol === 'http') {
      if (!opts.allowHttp) return { ok: false, message: HTTPS_ONLY };
    } else if (protocol !== 'https') {
      return { ok: false, message: HTTPS_ONLY };
    }
  }
  rest = rest.replace(/\/$/, '');
  const match = /^([^:]*)(?::(.*))?$/.exec(rest);
  if (!match) return { ok: false, message: BAD_ADDRESS };
  const host = match[1].toLowerCase();
  const port = match[2];
  if (!validHost(host)) return { ok: false, message: BAD_ADDRESS };
  if (port === undefined) return { ok: true, address: `${protocol}://${host}` };
  if (!/^\d{1,5}$/.test(port)) return { ok: false, message: BAD_ADDRESS };
  const n = Number(port);
  if (n < 1 || n > 65535) return { ok: false, message: BAD_ADDRESS };
  return { ok: true, address: `${protocol}://${host}:${n}` };
}
