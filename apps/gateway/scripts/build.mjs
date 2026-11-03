// Bundles the gateway into dist/main.js, the daily report (src/report/cli.ts) into
// dist/daily-report.js, the reachability echo (src/probe-echo.ts) into dist/probe-echo.js, the
// self-host admin command line into dist/admin-cli.js and the installer's speech key check into
// dist/check-speech-key.js.
// Workspace packages (@twring/*) ship TypeScript source, so they are bundled in; third-party dependencies stay external and load from node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: {
    main: 'src/main.ts',
    'daily-report': 'src/report/cli.ts',
    'probe-echo': 'src/probe-echo.ts',
    'admin-cli': 'src/admin-cli.ts',
    'check-speech-key': 'src/check-speech-key.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  plugins: [
    {
      name: 'externalize-third-party',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@twring/') ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
});
