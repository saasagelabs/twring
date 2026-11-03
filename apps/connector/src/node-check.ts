// Imported first by cli.ts, so it runs before anything else. Plain syntax on purpose: it must run
// (and say something useful) on a Node too old for the rest of the connector.
const nodeMajor = Number(String(process.versions.node).split('.')[0]);
if (!(nodeMajor >= 20)) {
  process.stderr.write(
    'Node ' + nodeMajor + ' is too old: install Node.js 20 or newer, then run this again.\n',
  );
  process.exit(1);
}

export {};
