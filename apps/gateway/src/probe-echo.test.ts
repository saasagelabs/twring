import { createSocket, type SocketType } from 'node:dgram';
import { connect } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { echoReply, startProbeEcho, type ProbeEcho } from './probe-echo';

describe('echoReply', () => {
  it('answers a well-formed probe line, with or without a newline', () => {
    expect(echoReply(Buffer.from('twring-probe abc_-9'))).toBe('twring-probe abc_-9\n');
    expect(echoReply(Buffer.from('twring-probe abc\n'))).toBe('twring-probe abc\n');
    expect(echoReply(Buffer.from('twring-probe abc\r\n'))).toBe('twring-probe abc\n');
  });

  it.each([
    '',
    'hello',
    'twring-probe',
    'twring-probe ',
    'twring-probe a b',
    'twring-probe abc\nmore',
    'TWRING-PROBE abc',
    ' twring-probe abc',
    'twring-probe <script>',
    `twring-probe ${'a'.repeat(65)}`,
    `twring-probe ${'a'.repeat(200)}`,
  ])('ignores %j', (text) => {
    expect(echoReply(Buffer.from(text))).toBeUndefined();
  });

  it('ignores invalid UTF-8', () => {
    expect(echoReply(Buffer.from([0x74, 0xff, 0xfe]))).toBeUndefined();
  });
});

describe('startProbeEcho (loopback)', () => {
  let echo: ProbeEcho | undefined;
  afterEach(async () => {
    await echo?.close();
    echo = undefined;
  });

  const tcpExchange = (port: number, text: string, host = '127.0.0.1') =>
    new Promise<string>((resolve) => {
      const socket = connect({ host, port });
      let got = '';
      socket.on('data', (chunk) => (got += chunk.toString()));
      socket.on('close', () => resolve(got));
      socket.on('error', () => resolve(got));
      socket.write(text);
      setTimeout(() => socket.destroy(), 300);
    });

  const udpExchange = (port: number, text: string, host = '127.0.0.1') =>
    new Promise<string | undefined>((resolve) => {
      const socket = createSocket(host.includes(':') ? 'udp6' : 'udp4');
      const timer = setTimeout(() => {
        socket.close();
        resolve(undefined);
      }, 300);
      socket.on('message', (data) => {
        clearTimeout(timer);
        socket.close();
        resolve(data.toString());
      });
      socket.send(text, port, host);
    });

  it('echoes the nonce on TCP and UDP and ignores other input', async () => {
    echo = await startProbeEcho({ host: '127.0.0.1', tcpPort: 0, udpPort: 0, lifetimeMs: 10_000 });
    expect(await tcpExchange(echo.tcpPort, 'twring-probe n1\n')).toBe('twring-probe n1\n');
    expect(await tcpExchange(echo.tcpPort, 'GET / HTTP/1.1\r\n\r\n')).toBe('');
    expect(await tcpExchange(echo.tcpPort, 'x'.repeat(5000))).toBe('');
    expect(await tcpExchange(echo.tcpPort, 'twring-probe n1\nextra')).toBe('');
    expect(await udpExchange(echo.udpPort, 'twring-probe n2')).toBe('twring-probe n2\n');
    expect(await udpExchange(echo.udpPort, 'ping')).toBeUndefined();
  });

  it('answers on IPv4 and IPv6 by default', async () => {
    echo = await startProbeEcho({ tcpPort: 0, udpPort: 0, lifetimeMs: 10_000 });
    for (const host of ['127.0.0.1', '::1']) {
      expect(await tcpExchange(echo.tcpPort, 'twring-probe n3\n', host), host).toBe(
        'twring-probe n3\n',
      );
      expect(await udpExchange(echo.udpPort, 'twring-probe n4', host), host).toBe(
        'twring-probe n4\n',
      );
    }
  });

  it.each(['EAFNOSUPPORT', 'EADDRNOTAVAIL'])(
    'falls back to IPv4 when the host has IPv6 off (%s)',
    async (code) => {
      const types: SocketType[] = [];
      echo = await startProbeEcho({
        tcpPort: 0,
        udpPort: 0,
        lifetimeMs: 10_000,
        createUdpSocket: (type) => {
          types.push(type);
          const socket = createSocket({ type, ipv6Only: false });
          if (type === 'udp6') {
            socket.bind = () => {
              const error = Object.assign(new Error(`bind ${code} ::`), { code });
              setImmediate(() => socket.emit('error', error));
              return socket;
            };
          }
          return socket;
        },
      });
      expect(types).toEqual(['udp6', 'udp4']);
      expect(await tcpExchange(echo.tcpPort, 'twring-probe n5\n')).toBe('twring-probe n5\n');
      expect(await udpExchange(echo.udpPort, 'twring-probe n6')).toBe('twring-probe n6\n');
    },
  );

  it('does not fall back for other bind errors', async () => {
    const failing = (type: SocketType) => {
      const socket = createSocket({ type, ipv6Only: false });
      socket.bind = () => {
        const error = Object.assign(new Error('bind EACCES'), { code: 'EACCES' });
        setImmediate(() => socket.emit('error', error));
        return socket;
      };
      return socket;
    };
    await expect(
      startProbeEcho({ tcpPort: 0, udpPort: 0, createUdpSocket: failing }),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('exits on its own after its lifetime', async () => {
    let fire: (() => void) | undefined;
    echo = await startProbeEcho({
      host: '127.0.0.1',
      tcpPort: 0,
      udpPort: 0,
      lifetimeMs: 120_000,
      setTimer: (ms, run) => {
        expect(ms).toBe(120_000);
        fire = run;
        return () => undefined;
      },
    });
    const port = echo.tcpPort;
    fire!();
    await echo.closed;
    expect(await tcpExchange(port, 'twring-probe n1\n')).toBe('');
  });

  it('defaults to 120 seconds', async () => {
    let asked = 0;
    echo = await startProbeEcho({
      host: '127.0.0.1',
      tcpPort: 0,
      udpPort: 0,
      setTimer: (ms) => {
        asked = ms;
        return () => undefined;
      },
    });
    expect(asked).toBe(120_000);
  });
});
