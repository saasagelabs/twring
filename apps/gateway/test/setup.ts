import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { useGatewayDataDirs } from '@twring/test-fixtures';
import { afterAll } from 'vitest';

// Runs before each test file. Every app a test builds from the env fixture keeps its data files in
// a temp folder of its own (made on first write), never in the gateway's real ./data.
const root = mkdtempSync(join(tmpdir(), 'twring-gateway-test-'));
let count = 0;
useGatewayDataDirs(() => join(root, `data-${(count += 1)}`));

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Best effort: a leftover temp folder must not fail the file whose tests passed.
  }
});
