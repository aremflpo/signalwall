import { build } from 'esbuild';

await build({
  entryPoints: ['src/renderer/app.js'],
  bundle: true,
  outfile: 'src/renderer/dist/app.js',
  platform: 'browser',
  format: 'iife',
  target: ['chrome130'],
  sourcemap: true,
  minify: false,
});
