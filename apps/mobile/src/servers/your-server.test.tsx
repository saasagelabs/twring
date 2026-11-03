import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { parsePairLink } from '@twring/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import type { SelfhostProfile } from './profiles';

const mocks = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  api: {
    serverInfo: vi.fn(),
    listPeople: vi.fn(),
    createMemberCode: vi.fn(),
    removePerson: vi.fn(),
  },
  alert: vi.fn(),
  share: vi.fn(),
  leaveServer: vi.fn(),
  switchToHosted: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    // Effects run right after the render that scheduled them.
    useEffect: (effect: () => void) => effect(),
    useState: (initial: unknown) => {
      const slot = mocks.cursor++;
      if (!(slot in mocks.state)) mocks.state[slot] = initial;
      return [
        mocks.state[slot],
        (next: unknown) => {
          mocks.state[slot] =
            typeof next === 'function'
              ? (next as (c: unknown) => unknown)(mocks.state[slot])
              : next;
        },
      ];
    },
  };
});
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: mocks.alert },
  Share: { share: mocks.share },
}));
vi.mock('@/api', () => ({
  twringApi: () => mocks.api,
  apiErrorCopy: (reason: unknown) => (reason instanceof ApiError ? { message: reason.code } : {}),
}));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/GhostButton', () => ({ GhostButton: 'GhostButton' }));
vi.mock('@/components/SettingsGroup', () => ({
  SettingsGroup: 'SettingsGroup',
  SettingsRow: 'SettingsRow',
}));
vi.mock('@/theme/tokens', () => ({
  usePalette: () => ({ textPrimary: '#fff', textSecondary: '#aaa' }),
  space: { sm: 8 },
  type: { display: {}, caption: {} },
}));
vi.mock('./switching', () => ({
  leaveServer: mocks.leaveServer,
  switchToHosted: mocks.switchToHosted,
}));

import { YourServer } from './your-server';

const ID = 'srv_' + 'a'.repeat(32);
function profile(role: 'admin' | 'member', audio: 'own' | 'twring' = 'own'): SelfhostProfile {
  return {
    kind: 'selfhost',
    serverId: ID,
    address: 'https://home.example.com',
    name: 'Home server',
    publicKey: 'k',
    person: { id: 'p1', displayName: 'Asha', role },
    deviceId: 'd1',
    audio,
  };
}

type Props = {
  label?: string;
  value?: string;
  onPress?: () => void;
  children?: ReactNode;
  error?: unknown;
};
function elements(node: ReactNode): ReactElement<Props>[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...Children.toArray(element.props.children).flatMap(elements)];
}
function render(p: SelfhostProfile): ReactElement<Props> {
  mocks.cursor = 0;
  return YourServer({ profile: p }) as ReactElement<Props>;
}
const labels = (tree: ReactElement<Props>) =>
  elements(tree)
    .map((e) => e.props.label)
    .filter((l): l is string => l !== undefined);
const row = (tree: ReactElement<Props>, label: string) =>
  elements(tree).find((e) => e.props.label === label);
const text = (tree: ReactElement<Props>) => JSON.stringify(tree);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const at = '2026-10-31T10:00:00.000Z';
function ring(state: string) {
  return state === 'unknown' || state === 'unregistered' ? { state } : { state, paid_until: at };
}
const people = [
  { id: 'p1', display_name: 'Asha', role: 'admin', devices: [] },
  { id: 'p2', display_name: 'Ravi', role: 'member', devices: [] },
];

beforeEach(() => {
  mocks.state = [];
  for (const fn of [
    mocks.api.serverInfo,
    mocks.api.listPeople,
    mocks.api.createMemberCode,
    mocks.api.removePerson,
    mocks.alert,
    mocks.share,
    mocks.leaveServer,
    mocks.switchToHosted,
  ]) {
    fn.mockReset();
  }
  mocks.api.serverInfo.mockResolvedValue({ ring_service: ring('active') });
  mocks.api.listPeople.mockResolvedValue(people);
  mocks.share.mockResolvedValue(undefined);
  mocks.leaveServer.mockResolvedValue(undefined);
  mocks.switchToHosted.mockResolvedValue(undefined);
});

describe('Your server', () => {
  it('a member sees the address, audio and leave rows but not People or Add a teammate', async () => {
    render(profile('member'));
    await flush();
    const tree = render(profile('member'));
    expect(labels(tree)).toEqual([
      'Address',
      "Calls use your server's audio",
      'Ring service: free while we launch',
      'Leave this server',
      "Use Twring's service instead",
    ]);
    expect(row(tree, 'Address')?.props.value).toBe('https://home.example.com');
    expect(mocks.api.listPeople).not.toHaveBeenCalled();
  });

  it('an admin also sees People and Add a teammate', async () => {
    render(profile('admin'));
    await flush();
    const tree = render(profile('admin'));
    expect(labels(tree)).toEqual(
      expect.arrayContaining(['People', 'Asha', 'Ravi', 'Add a teammate']),
    );
  });

  it("shows Twring's audio line when the server uses it", () => {
    expect(labels(render(profile('member', 'twring')))).toContain(
      "Calls on this server use Twring's audio service",
    );
  });

  it.each([
    ['paused', "Ring service: paused until your server's email address is confirmed"],
    ['expired', 'Ring service: ended. Ask your admin.'],
    ['unregistered', 'Ring service: not set up. On the server, run twring register.'],
    ['unknown', 'Ring service: checking'],
    ['active', 'Ring service: free while we launch'],
  ])('ring service %s has its line', async (state, line) => {
    mocks.api.serverInfo.mockResolvedValue({ ring_service: ring(state) });
    render(profile('member'));
    await flush();
    expect(labels(render(profile('member')))).toContain(line);
  });

  it('says checking until the server answers', () => {
    mocks.api.serverInfo.mockReturnValue(new Promise(() => undefined));
    render(profile('member'));
    expect(labels(render(profile('member')))).toContain('Ring service: checking');
  });

  it('only admins see the unverified reminder', async () => {
    mocks.api.serverInfo.mockResolvedValue({ ring_service: ring('unverified') });
    render(profile('member'));
    await flush();
    const memberTree = render(profile('member'));
    expect(row(memberTree, 'Ring service: free while we launch')?.props.value).toBeUndefined();
    mocks.state = [];
    render(profile('admin'));
    await flush();
    expect(row(render(profile('admin')), 'Ring service: free while we launch')?.props.value).toBe(
      'Confirm the email Twring sent you within 7 days, or rings pause.',
    );
  });
});

describe('Add a teammate', () => {
  async function minted() {
    mocks.api.createMemberCode.mockResolvedValue({ code: 'ABCD-EFGH', expires_at: at });
    row(render(profile('admin')), 'Add a teammate')?.props.onPress?.();
    await flush();
    return render(profile('admin'));
  }

  it('shows the address, the code and the validity', async () => {
    const out = text(await minted());
    expect(out).toContain('https://home.example.com');
    expect(out).toContain('ABCD-EFGH');
    expect(out).toContain('Valid for 10 minutes');
  });

  it('Share sends a link the pairing screen accepts', async () => {
    const tree = await minted();
    const share = elements(tree).find((e) => e.props.label === 'Share');
    share?.props.onPress?.();
    const message = (mocks.share.mock.calls[0]?.[0] as { message: string }).message;
    expect(parsePairLink(message)).toEqual({
      server: 'https://home.example.com',
      code: 'ABCD-EFGH',
      serverId: ID,
    });
  });

  it('a failed code shows an error', async () => {
    mocks.api.createMemberCode.mockRejectedValue(new ApiError('http', 'forbidden'));
    row(render(profile('admin')), 'Add a teammate')?.props.onPress?.();
    await flush();
    expect(text(render(profile('admin')))).toContain('forbidden');
  });
});

describe('People', () => {
  async function adminTree() {
    render(profile('admin'));
    await flush();
    return render(profile('admin'));
  }

  it('Remove asks first, naming the person, then removes them', async () => {
    row(await adminTree(), 'Ravi')?.props.onPress?.();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert.mock.calls[0]?.[0]).toBe('Remove Ravi?');
    expect(mocks.api.removePerson).not.toHaveBeenCalled();
    mocks.api.removePerson.mockResolvedValue(undefined);
    const buttons = mocks.alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
    buttons.find((b) => b.text === 'Remove')?.onPress?.();
    await flush();
    expect(mocks.api.removePerson).toHaveBeenCalledWith('p2');
    expect(labels(render(profile('admin')))).not.toContain('Ravi');
  });

  it('the last admin refusal shows the server copy', async () => {
    row(await adminTree(), 'Ravi')?.props.onPress?.();
    mocks.api.removePerson.mockRejectedValue(new ApiError('http', 'last_admin'));
    const buttons = mocks.alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
    buttons.find((b) => b.text === 'Remove')?.onPress?.();
    await flush();
    expect(text(render(profile('admin')))).toContain('last_admin');
    expect(labels(render(profile('admin')))).toContain('Ravi');
  });

  it('you cannot remove yourself from the list', async () => {
    expect(row(await adminTree(), 'Asha')?.props.onPress).toBeUndefined();
  });
});

describe('leaving', () => {
  it('Leave this server confirms, then leaves', async () => {
    row(render(profile('member')), 'Leave this server')?.props.onPress?.();
    expect(mocks.alert.mock.calls[0]?.slice(0, 2)).toEqual([
      'Leave Home server?',
      'This phone stops ringing for it. Your chats stay on the server.',
    ]);
    expect(mocks.leaveServer).not.toHaveBeenCalled();
    const buttons = mocks.alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
    buttons.find((b) => b.text === 'Leave')?.onPress?.();
    await flush();
    expect(mocks.leaveServer).toHaveBeenCalledTimes(1);
  });

  it("Use Twring's service instead switches to hosted", async () => {
    row(render(profile('member')), "Use Twring's service instead")?.props.onPress?.();
    await flush();
    expect(mocks.switchToHosted).toHaveBeenCalledTimes(1);
  });
});
