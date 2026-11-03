import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { render, stripOwnAudio } from './render';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

const IMAGE = `ghcr.io/saasagelabs/twring@sha256:${'a'.repeat(64)}`;
const ADDRESS = '203-0-113-7.sslip.io';

interface Service {
  image?: string;
  ports?: string[];
  environment?: Record<string, string>;
  env_file?: string[];
  volumes?: string[];
  networks?: Record<string, { ipv4_address?: string } | null>;
  restart?: string;
  healthcheck?: { test: string[] };
  depends_on?: Record<string, { condition: string }>;
  logging?: { driver: string; options: Record<string, string> };
  security_opt?: string[];
  cap_drop?: string[];
  cap_add?: string[];
  user?: string;
  init?: boolean;
  stop_grace_period?: string;
}
interface Compose {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
  networks?: Record<string, { ipam?: { config: { subnet: string }[] } }>;
}

const NETWORK = {
  SUBNET: '10.231.7.0/24',
  CADDY_IP: '10.231.7.2',
  SERVER_IP: '10.231.7.3',
  LIVEKIT_IP: '10.231.7.4',
};
const own = parse(
  render(read('compose.own.yml'), { TWRING_IMAGE: IMAGE, ADDRESS, AUDIO: 'own', ...NETWORK }),
) as Compose;
const caddyOnly = parse(
  render(stripOwnAudio(read('compose.own.yml')), {
    TWRING_IMAGE: IMAGE,
    ADDRESS,
    AUDIO: 'twring',
    ...NETWORK,
  }),
) as Compose;
const renderSandbox = (trustedProxies: string) =>
  parse(
    render(read('compose.twring.yml'), {
      TWRING_IMAGE: IMAGE,
      PUBLIC_URL: 'https://abc123.sandbox.example.dev',
      LISTEN_PORT: '3000',
      TRUSTED_PROXIES: trustedProxies,
    }),
  ) as Compose;
const sandbox = renderSandbox('false');
const caddy = render(read('Caddyfile.tmpl'), { ADDRESS });
const livekit = parse(read('livekit.yaml.tmpl')) as {
  port: number;
  keys?: unknown;
  webhook?: unknown;
  rtc: { tcp_port: number; udp_port: number; use_external_ip: boolean };
};

const allPorts = (compose: Compose) =>
  Object.values(compose.services).flatMap((service) => service.ports ?? []);
const escaped = (text: string) => text.replaceAll('.', '\\.');

describe('render', () => {
  it('fills every placeholder and refuses a missing one', () => {
    expect(render('a {{X}} b {{X}}', { X: '1' })).toBe('a 1 b 1');
    expect(() => render('{{X}} {{Y}}', { X: '1' })).toThrow(/Y/);
  });

  it('refuses a value that could break out of its line', () => {
    expect(() => render('{{X}}', { X: 'a\nb' })).toThrow();
    expect(() => render('{{X}}', { X: 'a b' })).toThrow();
  });
});

describe('compose.own.yml (own audio)', () => {
  it('runs the gateway, Caddy and LiveKit', () => {
    expect(Object.keys(own.services).sort()).toEqual(['caddy', 'livekit', 'twring']);
  });

  it('pins the gateway image by digest and the others by version', () => {
    expect(own.services.twring!.image).toBe(IMAGE);
    expect(own.services.caddy!.image).toMatch(/^caddy:\d+\.\d+\.\d+/);
    expect(own.services.livekit!.image).toMatch(/^livekit\/livekit-server:v\d+\.\d+\.\d+/);
  });

  it('publishes 80/443 on Caddy and 7881/tcp, 7882/udp on LiveKit only', () => {
    expect([...own.services.caddy!.ports!].sort()).toEqual(['443:443/tcp', '80:80/tcp']);
    expect([...own.services.livekit!.ports!].sort()).toEqual(['7881:7881/tcp', '7882:7882/udp']);
    expect(own.services.twring!.ports).toBeUndefined();
  });

  it('never publishes the gateway (8080) or the admin listener (8081)', () => {
    for (const port of allPorts(own)) expect(port).not.toMatch(/\b808[01]\b/);
  });

  it('keeps the server data in the twring-data volume', () => {
    expect(Object.keys(own.volumes)).toContain('twring-data');
    expect(own.services.twring!.volumes).toContain('twring-data:/data');
    expect(own.services.twring!.environment!.CORD_DATA_DIR).toBe('/data');
  });

  it('trusts exactly Caddy as the proxy, at its fixed address', () => {
    const caddyAddress = own.services.caddy!.networks!.twring!.ipv4_address!;
    expect(caddyAddress).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(own.services.twring!.environment!.TRUST_PROXY).toBe(caddyAddress);
    const subnet = own.networks!.twring!.ipam!.config[0]!.subnet;
    expect(caddyAddress.split('.').slice(0, 3)).toEqual(subnet.split('.').slice(0, 3));
  });

  it('wires the self-hosted settings and public addresses', () => {
    expect(own.services.twring!.environment).toMatchObject({
      TWRING_MODE: 'selfhost',
      AUTH_MODE: 'pairing',
      TWRING_AUDIO: 'own',
      THREADS_ENABLED: 'true',
      FILES_ENABLED: 'true',
      HOST: '0.0.0.0',
      PORT: '8080',
      CORD_PUBLIC_URL: `https://${ADDRESS}`,
      LIVEKIT_URL: `wss://livekit.${ADDRESS}`,
    });
    expect(own.services.twring!.env_file).toEqual(['twring.env']);
  });

  it('gives LiveKit its keys from the environment, not from a file', () => {
    expect(own.services.livekit!.environment!.LIVEKIT_KEYS).toBe(
      '${LIVEKIT_API_KEY:?set in twring.env}: ${LIVEKIT_API_SECRET:?set in twring.env}',
    );
    expect(own.services.livekit!.env_file).toBeUndefined();
    expect(livekit.keys).toBeUndefined();
    expect(read('livekit.yaml.tmpl')).not.toMatch(/^\s*(keys|key_file):/m);
  });

  it('restarts and health-checks the gateway', () => {
    for (const [name, service] of Object.entries(own.services)) {
      expect(service.restart, name).toBe('unless-stopped');
    }
    expect(own.services.twring!.healthcheck!.test.join(' ')).toContain('/health/ready');
  });

  it('starts Caddy without waiting for the gateway to be ready (it also fronts LiveKit)', () => {
    expect(own.services.caddy!.depends_on?.twring?.condition ?? 'service_started').toBe(
      'service_started',
    );
  });
});

function hardened(compose: Compose) {
  for (const [name, service] of Object.entries(compose.services)) {
    expect(service.logging, name).toEqual({
      driver: 'json-file',
      options: { 'max-size': '10m', 'max-file': '3' },
    });
    expect(service.security_opt, name).toEqual(['no-new-privileges:true']);
    expect(service.cap_drop, name).toEqual(['ALL']);
  }
  const twring = compose.services.twring!;
  expect(twring.init).toBe(true);
  expect(twring.stop_grace_period).toBe('30s');
  expect(twring.cap_add).toBeUndefined();
}

describe('hardening', () => {
  it('rotates logs, drops capabilities and forbids privilege gain on every service', () => {
    hardened(own);
    hardened(sandbox);
  });

  it('gives back only what each service needs', () => {
    // Caddy runs as root in its container and binds 80/443: only NET_BIND_SERVICE.
    expect(own.services.caddy!.cap_add).toEqual(['NET_BIND_SERVICE']);
    // LiveKit binds only high ports, so it runs as a non-root user with no capabilities.
    expect(own.services.livekit!.cap_add).toBeUndefined();
    expect(own.services.livekit!.user).toMatch(/^[1-9]\d*:[1-9]\d*$/);
  });
});

describe('compose.twring.yml (Twring audio, sandbox)', () => {
  it('trusts no proxy by default and the installer-given list when set', () => {
    expect(sandbox.services.twring!.environment!.TRUST_PROXY).toBe('false');
    expect(renderSandbox('10.0.0.0/8,192.168.1.1').services.twring!.environment!.TRUST_PROXY).toBe(
      '10.0.0.0/8,192.168.1.1',
    );
  });

  it('has no Caddy and no LiveKit', () => {
    expect(Object.keys(sandbox.services)).toEqual(['twring']);
  });

  it('listens on the port the sandbox exposes and uses its https address', () => {
    const service = sandbox.services.twring!;
    expect(service.ports).toEqual(['3000:3000/tcp']);
    expect(service.environment).toMatchObject({
      TWRING_MODE: 'selfhost',
      AUTH_MODE: 'pairing',
      TWRING_AUDIO: 'twring',
      THREADS_ENABLED: 'true',
      FILES_ENABLED: 'true',
      PORT: '3000',
      CORD_PUBLIC_URL: 'https://abc123.sandbox.example.dev',
    });
    for (const key of ['LIVEKIT_URL', 'TWRING_PUBLIC_URL', 'TWRING_LISTEN_PORT']) {
      expect(service.environment![key], key).toBeUndefined();
    }
  });

  it('keeps the data volume and never publishes the admin listener', () => {
    expect(Object.keys(sandbox.volumes)).toEqual(['twring-data']);
    expect(sandbox.services.twring!.volumes).toContain('twring-data:/data');
    for (const port of allPorts(sandbox)) expect(port).not.toMatch(/\b8081\b/);
    expect(sandbox.services.twring!.restart).toBe('unless-stopped');
  });
});

describe('Caddyfile.tmpl', () => {
  it('serves the address and livekit.<address> with automatic TLS', () => {
    expect(caddy).toMatch(new RegExp(`^${escaped(ADDRESS)} \\{`, 'm'));
    expect(caddy).toMatch(new RegExp(`^livekit\\.${escaped(ADDRESS)} \\{`, 'm'));
    expect(caddy).not.toMatch(/tls internal|auto_https off|http:\/\//);
  });

  it('proxies to the gateway and to LiveKit signalling on the internal network', () => {
    expect(caddy).toContain('reverse_proxy twring:8080');
    expect(caddy).toContain('reverse_proxy livekit:7880');
    expect(caddy).not.toContain('8081');
  });

  it('removes Authorization, Cookie and file-link signatures from access logs on both hosts', () => {
    expect(caddy.match(/request>headers>Authorization delete/g)).toHaveLength(2);
    expect(caddy.match(/request>headers>Cookie delete/g)).toHaveLength(2);
    expect(
      caddy.match(/request>uri query \{\s*delete sig\s*delete exp\s*delete access_token\s*\}/g),
    ).toHaveLength(2);
  });

  it('serves HTTP/1.1 and HTTP/2 only (443/udp is not published)', () => {
    expect(caddy).toMatch(/^\{\s*servers \{\s*protocols h1 h2\s*\}\s*\}/m);
  });
});

describe('Twring call audio behind Caddy (own-audio blocks removed)', () => {
  it('keeps Caddy and the server, drops LiveKit and its address', () => {
    expect(Object.keys(caddyOnly.services).sort()).toEqual(['caddy', 'twring']);
    const env = caddyOnly.services.twring!.environment!;
    expect(env.TWRING_AUDIO).toBe('twring');
    expect(env.LIVEKIT_URL).toBeUndefined();
    expect(env.TRUST_PROXY).toBe(NETWORK.CADDY_IP);
    expect(caddyOnly.networks!.twring!.ipam!.config[0]!.subnet).toBe(NETWORK.SUBNET);
    const file = render(stripOwnAudio(read('Caddyfile.tmpl')), { ADDRESS });
    expect(file).not.toContain('livekit');
    expect(file).toMatch(new RegExp(`^${escaped(ADDRESS)} \\{`, 'm'));
  });
  it('renders the internal network the installer picked', () => {
    expect(own.networks!.twring!.ipam!.config[0]!.subnet).toBe(NETWORK.SUBNET);
    expect(own.services.livekit!.networks!.twring!.ipv4_address).toBe(NETWORK.LIVEKIT_IP);
  });
  it('names the data volume twring_twring-data in both files', () => {
    expect(own.volumes['twring-data']).toEqual({ name: 'twring_twring-data' });
    expect(sandbox.volumes['twring-data']).toEqual({ name: 'twring_twring-data' });
  });
});

describe('livekit.yaml.tmpl', () => {
  it('signals on 7880 and carries media on 7882/udp with 7881/tcp fallback', () => {
    expect(livekit.port).toBe(7880);
    expect(livekit.rtc).toMatchObject({ tcp_port: 7881, udp_port: 7882, use_external_ip: true });
    expect(livekit.webhook).toBeUndefined();
  });
});
