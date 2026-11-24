// A second process for store.test.ts: changes the saved private chat config `rounds` times.
import { updateE2e } from './store';

const [path, rounds, deviceId] = process.argv.slice(2);
const total = Number(rounds);

for (let i = 0; i < total; i++) {
  await updateE2e(path!, (current) => ({
    ...current,
    seq: current.seq + 1,
    devices:
      deviceId !== undefined && i === Math.floor(total / 2)
        ? [
            ...current.devices,
            {
              id: deviceId,
              kind: 'phone' as const,
              name: 'Pixel',
              public_key: current.public_key,
              verified_at: '2026-11-25T00:00:00.000Z',
            },
          ]
        : current.devices,
  }));
}
