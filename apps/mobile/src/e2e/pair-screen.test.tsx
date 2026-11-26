import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const params: { agentId?: string; approve?: string } = {};
  return {
    state: [] as unknown[],
    cursor: 0,
    back: vi.fn(),
    dismissTo: vi.fn(),
    params,
    feedback: vi.fn(),
    parsePairInput: vi.fn(),
    claimPairing: vi.fn(),
    confirmPairing: vi.fn(),
    loadTrusted: vi.fn(),
    restoreOffer: vi.fn(),
    requestApproval: vi.fn(),
    twringApi: vi.fn(),
    otherPhones: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    effects: 0,
    allEffects: false,
    approvalStatus: vi.fn(),
    finishApproval: vi.fn(),
    shareHistory: vi.fn(),
    loadedPrivateAgentIds: vi.fn(),
    hasController: true,
  };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    // Effects run once per screen, as on mount.
    useEffect: (effect: () => unknown) => {
      if (mocks.effects++ === 0 || mocks.allEffects) void effect();
    },
    useState: (initial: unknown) => {
      const slot = mocks.cursor++;
      if (!(slot in mocks.state))
        mocks.state[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [
        mocks.state[slot],
        (next: unknown) => {
          mocks.state[slot] =
            typeof next === 'function'
              ? (next as (value: unknown) => unknown)(mocks.state[slot])
              : next;
        },
      ];
    },
  };
});
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'android' },
}));
vi.mock('expo-router', () => ({
  router: {
    back: mocks.back,
    replace: mocks.replace,
    push: mocks.push,
    dismissTo: mocks.dismissTo,
  },
  useLocalSearchParams: () => mocks.params,
}));
vi.mock('@/e2e/pairing', async () => {
  const { normalizeTypedPairCode } = await import('@twring/contracts');
  return {
    parsePairInput: mocks.parsePairInput,
    parseTypedPairCode: (text: string) => {
      const code = normalizeTypedPairCode(text);
      return code === undefined ? undefined : { kind: 'typed', code };
    },
    claimPairing: mocks.claimPairing,
    confirmPairing: mocks.confirmPairing,
    loadTrusted: mocks.loadTrusted,
  };
});
vi.mock('@/e2e/pair-api', () => ({
  pairApi: () => ({}),
  recoveryApi: () => ({}),
  approveApi: () => ({}),
}));
vi.mock('@/e2e/approve', async () => ({
  ...(await import('./approve')),
  requestApproval: mocks.requestApproval,
  approvalStatus: mocks.approvalStatus,
  finishApproval: mocks.finishApproval,
  pollApproval: (check: () => Promise<void>) => {
    void check();
    return () => undefined;
  },
}));
vi.mock('@/e2e/device-key', () => ({ loadDeviceKey: () => Promise.resolve(undefined) }));
vi.mock('@/e2e/recovery', () => ({
  RECOVERY_COPY: {
    offer: "Save a recovery key? Without it, a new phone can't read old private messages.",
    removed: 'REMOVED_COPY',
  },
  restoreOffer: mocks.restoreOffer,
}));
// This server and account's keychain (P3c ruling 1), never the phone-wide one.
vi.mock('@/threads/chats', () => ({
  privateKeychain: () => ({ deviceOnly: true }),
  resetPrivateChats: vi.fn(),
  chatController: () =>
    mocks.hasController ? { loadedPrivateAgentIds: mocks.loadedPrivateAgentIds } : undefined,
}));
vi.mock('@/api', () => ({ twringApi: mocks.twringApi }));
vi.mock('@/e2e/devices', () => ({ listDevices: vi.fn() }));
vi.mock('@/e2e/other-phones', () => ({ otherPhones: mocks.otherPhones }));
vi.mock('@/e2e/share-history', () => ({ shareHistory: mocks.shareHistory }));
vi.mock('@/servers/active', () => ({ activeServerUrl: () => 'https://api.twring.com' }));
vi.mock('@/platform/haptics', () => ({ playCallFeedback: mocks.feedback }));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/GhostButton', () => ({ GhostButton: 'GhostButton' }));
vi.mock('@/components/Field', () => ({ Field: 'Field' }));
vi.mock('@/components/PrimaryButton', () => ({ PrimaryButton: 'PrimaryButton' }));
vi.mock('@/components/QrScanner', () => ({ QrScanner: 'QrScanner' }));
vi.mock('@/components/Screen', () => ({ Screen: 'Screen' }));
vi.mock('@/theme/fonts', () => ({ font: { display: 'd', body: 'b' } }));
vi.mock('@/theme/tokens', () => ({
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
  usePalette: () => ({ textPrimary: '#fff', textSecondary: '#aaa' }),
  space: { lg: 16, md: 12 },
}));

import PrivatePairScreen from '../app/private/pair';

type Props = {
  label?: string;
  disabled?: boolean;
  value?: string;
  onChangeText?: (text: string) => unknown;
  onSubmitEditing?: () => unknown;
  accessibilityLabel?: string;
  onPress?: () => unknown;
  onScanned?: (data: string) => unknown;
  onTypeInstead?: () => unknown;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function render(): ReactElement {
  mocks.cursor = 0;
  return PrivatePairScreen();
}

function elements(node: ReactNode): ReactElement<Props>[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode; footer?: ReactNode } & Props>;
  return [
    element as ReactElement<Props>,
    ...Children.toArray(element.props.children).flatMap(elements),
    ...elements(element.props.footer),
  ];
}

function labelled(tree: ReactElement, label: string): ReactElement<Props> {
  const found = elements(tree).find((e) => e.props.label === label);
  if (!found) throw new Error(`missing ${label}`);
  return found;
}

const text = (tree: ReactElement) => JSON.stringify(tree);

async function scan(data = 'twring-pair:abc'): Promise<ReactElement> {
  void labelled(render(), 'Scan the code on your computer').props.onPress?.();
  const scanner = elements(render()).find((e) => e.type === 'QrScanner');
  void scanner?.props.onScanned?.(data);
  await flush();
  return render();
}

beforeEach(() => {
  mocks.state = [];
  mocks.back.mockReset();
  mocks.dismissTo.mockReset();
  mocks.params = {};
  mocks.feedback.mockReset();
  mocks.parsePairInput.mockReset().mockReturnValue({ kind: 'qr', offer: {} });
  mocks.claimPairing
    .mockReset()
    .mockResolvedValue({ ok: true, safety: '123 456', connector: { id: 'dev_c' } });
  mocks.confirmPairing.mockReset().mockResolvedValue(undefined);
  mocks.loadTrusted.mockReset().mockResolvedValue([{ id: 'dev_old' }]);
  mocks.restoreOffer.mockReset().mockResolvedValue({ kind: 'none' });
  mocks.push.mockReset();
  mocks.replace.mockReset();
  mocks.requestApproval.mockReset().mockResolvedValue({ ok: true, approval: { id: 'pap_x' } });
  mocks.twringApi.mockReset().mockReturnValue({ privateDevices: () => Promise.resolve({}) });
  mocks.otherPhones.mockReset().mockResolvedValue([]);
  mocks.effects = 0;
  mocks.allEffects = false;
  mocks.hasController = true;
  mocks.approvalStatus.mockReset();
  mocks.finishApproval.mockReset().mockResolvedValue(true);
  mocks.shareHistory.mockReset().mockResolvedValue(undefined);
  mocks.loadedPrivateAgentIds.mockReset().mockReturnValue(['agt_a']);
});

describe('recovery key on the pairing screen', () => {
  it('offers a recovery key after the first pairing, with Not now', async () => {
    mocks.loadTrusted.mockResolvedValue([]);
    void labelled(await scan(), 'Yes, same number').props.onPress?.();
    await flush();
    const tree = render();
    expect(text(tree)).toContain(
      "Save a recovery key? Without it, a new phone can't read old private messages.",
    );
    void labelled(tree, 'Save a recovery key').props.onPress?.();
    expect(mocks.replace).toHaveBeenCalledWith({
      pathname: '/private/recovery',
      params: { mode: 'create' },
    });
    void labelled(tree, 'Not now').props.onPress?.();
    expect(mocks.back).toHaveBeenCalled();
  });

  it('does not offer it again after a later pairing', async () => {
    void labelled(await scan(), 'Yes, same number').props.onPress?.();
    await flush();
    expect(text(render())).not.toContain('Save a recovery key');
  });

  it('offers a restore when the phone has no key and a backup exists', async () => {
    mocks.restoreOffer.mockResolvedValue({ kind: 'found', backup: {} });
    render();
    await flush();
    void labelled(render(), 'Use my recovery key').props.onPress?.();
    expect(mocks.push).toHaveBeenCalledWith({
      pathname: '/private/recovery',
      params: { mode: 'restore' },
    });
  });

  it('says plainly when the backup is for a removed phone, and stays on pairing', async () => {
    mocks.restoreOffer.mockResolvedValue({ kind: 'removed' });
    render();
    await flush();
    const tree = render();
    expect(text(tree)).toContain('REMOVED_COPY');
    expect(text(tree)).not.toContain('Use my recovery key');
    expect(labelled(tree, 'Scan the code on your computer')).toBeDefined();
  });
});

describe('another phone with private chats', () => {
  it('leads with approve when another phone exists', async () => {
    mocks.otherPhones.mockResolvedValue([{ id: 'dev_p', name: 'iPhone' }]);
    render();
    await flush();
    const tree = render();
    const footer = elements(tree).filter((e) => e.type === 'PrimaryButton');
    expect(footer.map((e) => e.props.label)).toEqual(['Approve from my other phone']);
    expect(text(tree)).toContain(
      'You already have private chats on iPhone. Approve this phone from there, so both phones can read the same chats.',
    );
    expect(labelled(tree, 'Scan the code on your computer').type).toBe('GhostButton');
    expect(labelled(tree, 'Type the code instead').type).toBe('GhostButton');
  });

  it('does not offer approve when every other phone is already connected', async () => {
    mocks.otherPhones.mockResolvedValue([{ id: 'dev_p', name: 'iPhone' }]);
    mocks.loadTrusted.mockResolvedValue([{ id: 'dev_p' }]);
    render();
    await flush();
    const tree = render();
    const footer = elements(tree).filter((e) => e.type === 'PrimaryButton');
    expect(footer.map((e) => e.props.label)).toEqual(['Scan the code on your computer']);
    expect(text(tree)).not.toContain('You already have private chats');
  });

  it('offers approve for a phone that is not connected yet, among connected ones', async () => {
    mocks.otherPhones.mockResolvedValue([
      { id: 'dev_p', name: 'iPhone' },
      { id: 'dev_q', name: 'Pixel' },
    ]);
    mocks.loadTrusted.mockResolvedValue([{ id: 'dev_p' }]);
    render();
    await flush();
    expect(text(render())).toContain('You already have private chats on Pixel.');
  });

  it('says "your other phone" when there are two or more', async () => {
    mocks.otherPhones.mockResolvedValue([
      { id: 'dev_p', name: 'iPhone' },
      { id: 'dev_q', name: 'Pixel' },
    ]);
    render();
    await flush();
    expect(text(render())).toContain('You already have private chats on your other phone.');
  });

  it('keeps scan first when no other phone', async () => {
    render();
    await flush();
    const tree = render();
    expect(
      elements(tree)
        .filter((e) => e.type === 'PrimaryButton')
        .map((e) => e.props.label),
    ).toEqual(['Scan the code on your computer']);
    expect(text(tree)).not.toContain('You already have private chats');
  });

  it('keeps scan first when the list fails to load', async () => {
    mocks.otherPhones.mockRejectedValue(new Error('offline'));
    render();
    await flush();
    expect(
      elements(render())
        .filter((e) => e.type === 'PrimaryButton')
        .map((e) => e.props.label),
    ).toEqual(['Scan the code on your computer']);
  });

  it('starts approval at once from the devices screen', async () => {
    mocks.params = { approve: '1' };
    render();
    await flush();
    expect(mocks.requestApproval).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain('Waiting for your other phone');
  });
});

describe('private chat pairing screen', () => {
  it('offers to scan, with help text, and to type the code instead', () => {
    const tree = render();
    expect(text(tree)).toContain('Ask your agent on the computer to show the pairing code.');
    expect(labelled(tree, 'Type the code instead')).toBeDefined();
    expect(text(tree).replace(/"key":/g, '')).not.toMatch(
      /MCP|connector|twring-connect|end-to-end|encryption|handle|\bkey\b/i,
    );
  });

  describe('typed code', () => {
    const field = (tree: ReactElement) => elements(tree).find((e) => e.type === 'Field')!;
    const typeCode = (code: string): ReactElement => {
      mocks.state = [];
      void labelled(render(), 'Type the code instead').props.onPress?.();
      void field(render()).props.onChangeText?.(code);
      return render();
    };
    const submit = async (code: string): Promise<ReactElement> => {
      void labelled(typeCode(code), 'Continue').props.onPress?.();
      await flush();
      return render();
    };

    it('shows a labelled field, with no jargon', () => {
      void labelled(render(), 'Type the code instead').props.onPress?.();
      const tree = render();
      expect(field(tree).props.label).toBe('Code from your computer');
      expect(text(tree).replace(/"key":/g, '')).not.toMatch(
        /MCP|connector|twring-connect|end-to-end|encryption|handle|\bkey\b/i,
      );
    });

    it('keeps Continue off until 16 characters are typed, read the forgiving way', () => {
      expect(labelled(typeCode('7KQ2-M9XD-4HTP'), 'Continue').props.disabled).toBe(true);
      expect(labelled(typeCode('7KQ2-M9XD-4HTP-W3RU'), 'Continue').props.disabled).toBe(true);
      expect(labelled(typeCode('7kq2 m9xd-4htp w3rv'), 'Continue').props.disabled).toBe(false);
    });

    it('pairs with the typed code and then asks to compare the same number', async () => {
      const tree = await submit('7kq2-m9xd-4htp-w3rv');
      expect(mocks.claimPairing.mock.calls[0]?.[1]).toEqual({
        kind: 'typed',
        code: '7KQ2M9XD4HTPW3RV',
      });
      expect(text(tree)).toContain('Does your computer show 123 456?');
      void labelled(tree, 'Yes, same number').props.onPress?.();
      await flush();
      expect(mocks.confirmPairing).toHaveBeenCalled();
    });

    it('says exactly that the code did not work, and lets the person try again', async () => {
      mocks.claimPairing.mockResolvedValue({ ok: false, code: 'wrong_code' });
      const tree = await submit('7KQ2-M9XD-4HTP-W3RV');
      expect(text(tree)).toContain(
        "That code didn't work. Check it on your computer and try again.",
      );
      expect(mocks.feedback).toHaveBeenCalledWith('error');
      void labelled(tree, 'Type the code again').props.onPress?.();
      expect(elements(render()).some((e) => e.type === 'Field')).toBe(true);
    });

    it('can go back to scanning', () => {
      void labelled(typeCode(''), 'Scan instead').props.onPress?.();
      expect(elements(render()).some((e) => e.type === 'QrScanner')).toBe(true);
    });
  });

  it('asks to compare the code and stores only after yes', async () => {
    const tree = await scan();
    expect(text(tree)).toContain('Does your computer show 123 456?');
    expect(mocks.confirmPairing).not.toHaveBeenCalled();
    void labelled(tree, 'Yes, same number').props.onPress?.();
    await flush();
    expect(mocks.confirmPairing).toHaveBeenCalledWith(
      { store: { deviceOnly: true } },
      { id: 'dev_c' },
    );
    expect(mocks.claimPairing.mock.calls[0]?.[0]).toMatchObject({ store: { deviceOnly: true } });
    expect(mocks.feedback).toHaveBeenCalledWith('connected');
    expect(text(render())).toContain('Paired');
  });

  it('Save a recovery key carries the agent along', async () => {
    mocks.params = { agentId: 'agt_1' };
    mocks.loadTrusted.mockResolvedValue([]);
    void labelled(await scan(), 'Yes, same number').props.onPress?.();
    await flush();
    void labelled(render(), 'Save a recovery key').props.onPress?.();
    expect(mocks.replace).toHaveBeenCalledWith({
      pathname: '/private/recovery',
      params: { mode: 'create', agentId: 'agt_1' },
    });
  });

  it('returns to the agent it was opened for, ready to turn private chats on', async () => {
    mocks.params = { agentId: 'agt_1' };
    void labelled(await scan(), 'Yes, same number').props.onPress?.();
    await flush();
    void labelled(render(), 'Done').props.onPress?.();
    expect(mocks.dismissTo).toHaveBeenCalledWith({
      pathname: '/agents/[id]',
      params: { id: 'agt_1', private: 'ask' },
    });
    expect(mocks.back).not.toHaveBeenCalled();
  });

  it('without an agent, Done just goes back', async () => {
    void labelled(await scan(), 'Yes, same number').props.onPress?.();
    await flush();
    void labelled(render(), 'Done').props.onPress?.();
    expect(mocks.back).toHaveBeenCalled();
    expect(mocks.dismissTo).not.toHaveBeenCalled();
  });

  it('stores nothing when the numbers differ', async () => {
    const tree = await scan();
    void labelled(tree, 'No').props.onPress?.();
    await flush();
    expect(text(render())).toMatch(/Pairing stopped/);
    expect(mocks.confirmPairing).not.toHaveBeenCalled();
    expect(mocks.feedback).toHaveBeenCalledWith('error');
  });

  it('reads the code aloud for screen readers, digit by digit', async () => {
    const tree = await scan();
    expect(
      elements(tree).some((e) => e.props.accessibilityLabel === 'Safety code 1 2 3 4 5 6'),
    ).toBe(true);
  });

  it('refuses a server that answered with another key, with an error haptic', async () => {
    mocks.claimPairing.mockResolvedValue({ ok: false, code: 'mismatch' });
    const tree = await scan();
    expect(text(tree)).toMatch(/Pairing stopped/);
    expect(mocks.feedback).toHaveBeenCalledWith('error');
  });

  it('says what to do when the code expired or the device list is full', async () => {
    mocks.claimPairing.mockResolvedValue({ ok: false, code: 'expired' });
    expect(text(await scan())).toContain('This code has expired.');
    mocks.state = [];
    mocks.claimPairing.mockResolvedValue({ ok: false, code: 'cap' });
    expect(text(await scan())).toContain('You already have 5 devices.');
  });

  it('says plainly when the code is for another server', async () => {
    mocks.claimPairing.mockResolvedValue({ ok: false, code: 'wrong_server' });
    expect(text(await scan())).toContain('This code is for a different Twring server.');
    expect(mocks.claimPairing.mock.calls[0]?.[0]).toMatchObject({
      activeServer: 'https://api.twring.com',
    });
    expect(mocks.feedback).toHaveBeenCalledWith('error');
  });

  it('keeps scanning after a code that is not a pairing code', async () => {
    mocks.parsePairInput.mockReturnValue(undefined);
    const tree = await scan('https://example.com');
    expect(mocks.claimPairing).not.toHaveBeenCalled();
    expect(text(tree)).toContain('not a pairing code');
    expect(elements(tree).some((e) => e.type === 'QrScanner')).toBe(true);
  });
});

describe('approve from my other phone (C3 #11, Task 27)', () => {
  it('asks the other phone, then shows its code, then says it is done', async () => {
    mocks.requestApproval.mockResolvedValue({ ok: true, approval: { id: 'pap_x' } });
    void labelled(render(), 'Approve from my other phone').props.onPress?.();
    await flush();
    expect(mocks.requestApproval.mock.calls[0]?.[0]).toMatchObject({
      store: { deviceOnly: true },
      phoneName: 'Android phone',
    });
    expect(text(render())).toContain('On your other phone, open Devices and approve this phone.');
    // An older app there can't read the request, so the person is told what to do then.
    expect(text(render())).toContain(
      "If it isn't listed there, update Twring on that phone first.",
    );
    mocks.state[0] = {
      kind: 'approve',
      id: 'pap_x',
      shown: { id: 'dev_t', name: 'Pixel 8', public_key: 'k', code: '123 456' },
    };
    const compare = render();
    expect(text(compare)).toContain('Check that Pixel 8 shows 123 456.');
    expect(text(compare).replace(/"key":/g, '')).not.toMatch(/device id|trust note|\bkey\b/i);
    mocks.state[0] = { kind: 'approved' };
    expect(text(render())).toContain('This phone can read new private messages.');
  });

  it('pair calls shareHistory after approval once chats are loaded', async () => {
    mocks.state[0] = {
      kind: 'approve',
      id: 'pap_x',
      shown: { id: 'dev_t', name: 'Pixel 8', public_key: 'k', code: '123 456' },
    };
    mocks.approvalStatus.mockResolvedValue({ ok: true, approval: { state: 'accepted' } });
    mocks.allEffects = true;
    render();
    await flush();
    expect(mocks.shareHistory).toHaveBeenCalledTimes(1);
    expect(mocks.shareHistory.mock.calls[0]?.[2]).toEqual(['agt_a']);
  });

  it('pair hands shareHistory no list while the chats have not loaded', async () => {
    mocks.state[0] = {
      kind: 'approve',
      id: 'pap_x',
      shown: { id: 'dev_t', name: 'Pixel 8', public_key: 'k', code: '123 456' },
    };
    mocks.loadedPrivateAgentIds.mockReturnValue(undefined);
    mocks.approvalStatus.mockResolvedValue({ ok: true, approval: { state: 'accepted' } });
    mocks.allEffects = true;
    render();
    await flush();
    expect(mocks.shareHistory.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('says plainly when the request could not be made, and offers to try again', async () => {
    mocks.requestApproval.mockResolvedValue({ ok: false, code: 'cap' });
    void labelled(render(), 'Approve from my other phone').props.onPress?.();
    await flush();
    const tree = render();
    expect(text(tree)).toContain('You already have 5 devices.');
    expect(labelled(tree, 'Try again')).toBeDefined();
  });
});
