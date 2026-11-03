// Bundles the relay into dist/main.js. Workspace packages (@twring/*) ship TypeScript source,
// so they are bundled in; third-party dependencies stay external and load from node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: { main: 'src/main.ts' },
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
