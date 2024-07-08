/* eslint-disable no-undef */
// eslint-disable-next-line @typescript-eslint/no-var-requires
import esbuild from 'esbuild'
import { copy } from 'esbuild-plugin-copy';
import cssModulesPlugin from 'esbuild-css-modules-plugin'


(async () => {
  const extensionConfig = {
    bundle: true,
    entryPoints: ['src/index.ts'],
    external: ['vscode', 'esbuild', './xhr-sync-worker.js', 'sodium-native', 'b4a', 'fsctl', 'hyperdht', 'hyperswarm'],
    format: 'cjs',
    outfile: 'out/index.js',
    platform: 'node',
    sourcemap: true,
    inject: ['./scripts/meta.js'],
    define: { 'import.meta.url': 'importMetaUrl' },
    loader: { '.node': 'file' },
    plugins: [
      copy({
        resolveFrom: 'cwd',
        assets: [
          {
            from: './node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm',
            to: './out/ort-wasm-simd.wasm'
          },
          {
            from: './node_modules/tree-sitter-wasms/out/**/*.wasm',
            to: './out/tree-sitter-wasms'
          },
          {
            from: './models/**/*',
            to: './out/models',
          },
          {
            from: './node_modules/web-tree-sitter/tree-sitter.wasm',
            to: './out/tree-sitter.wasm'
          },
        ],
        watch: true,
      }),
    ]
  }

  const webConfig = {
    bundle: true,
    external: ['vscode', 'esbuild', 'sodium-native', 'b4a', 'fsctl', 'hyperdht', 'hyperswarm'],
    entryPoints: ['src/webview/index.tsx'],
    outfile: 'out/sidebar.js',
    sourcemap: true,
    plugins: [cssModulesPlugin()],
  }

  const flags = process.argv.slice(2);

  if (flags.includes('--watch')) {
    const ctx = await esbuild.context(webConfig);
    const ectx = await esbuild.context(extensionConfig);
    await ctx.watch();
    await ectx.watch();
  } else {
    await esbuild.build(webConfig);
    await esbuild.build(extensionConfig);
  }
})()




