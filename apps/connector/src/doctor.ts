import { createAdapter, type LocalAgentConfig } from './agents';
import { AcpAdapter } from './adapters/acp';
import type { LocalAgentAdapter } from './events';
import { systemSpawn } from './process';

export async function doctor(
  agents: LocalAgentConfig[],
  print: (line: string) => void,
  create: (agent: LocalAgentConfig) => LocalAgentAdapter = (agent) =>
    createAdapter(agent, systemSpawn),
): Promise<number> {
  let failures = 0;
  for (const agent of agents) {
    let adapter: LocalAgentAdapter | undefined;
    const started = Date.now();
    let first: number | undefined,
      count = 0,
      reply = '';
    const deadline = AbortSignal.timeout(90_000);
    try {
      adapter = create(agent);
      for await (const event of adapter.sendTurn(
        'This is a Twring connection test. Reply with the single word: ready',
        deadline,
      )) {
        if (event.type === 'text') {
          first ??= Date.now();
          count++;
          reply += event.text;
        }
      }
      const ready = reply.toLowerCase().includes('ready');
      print(
        `${agent.label}: started; first text ${first === undefined ? 'none' : ((first - started) / 1000).toFixed(1) + 's'}; reply ${reply ? JSON.stringify(reply.slice(0, 120)) : 'none'}; ready ${ready ? 'yes' : 'no'}; streamed ${count > 1 ? 'yes' : 'no'}; resumes ${adapter.sessionRef?.() ? 'yes' : 'no'}; inline images ${adapter instanceof AcpAdapter && adapter.supportsInlineImages() ? 'yes' : 'no'}.`,
      );
      if (!ready) {
        print(`  ${agent.label} did not reply ready: check its setup and try again.`);
        failures++;
      }
    } catch {
      print(
        `${agent.label}: ${first === undefined ? 'did not start or reply' : 'started but failed'}; first text ${first === undefined ? 'none' : ((first - started) / 1000).toFixed(1) + 's'}; reply ${reply ? JSON.stringify(reply.slice(0, 120)) : 'none'}; streamed ${count > 1 ? 'yes' : 'no'}; resumes ${adapter?.sessionRef?.() ? 'yes' : 'no'}; inline images ${adapter instanceof AcpAdapter && adapter.supportsInlineImages() ? 'yes' : 'no'}.`,
      );
      print(
        first === undefined
          ? `  ${agent.label} didn't start: is ${agent.command} on PATH and configured?`
          : `  ${agent.label} stopped during the test: check its logs and configuration.`,
      );
      failures++;
    } finally {
      adapter?.close();
    }
  }
  return failures === 0 ? 0 : 1;
}
