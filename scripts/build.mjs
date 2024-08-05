/* eslint-disable no-undef */
// eslint-disable-next-line @typescript-eslint/no-var-requires
import esbuild from 'esbuild'
import { copy } from 'esbuild-plugin-copy';


(async () => {
  const extensionConfig = {
    bundle: true,
    entryPoints: ['src/index.ts'],
    external: ['vscode', 'esbuild', './xhr-sync-worker.js', 'sodium-native', 'udx-native', 'b4a'],
    format: 'cjs',
    outdir: 'out',
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
          {
            from: './node_modules/web-tree-sitter/tree-sitter.wasm',
            to: './out/tree-sitter.wasm'
          },
          {
            from: './node_modules/udx-native/build/Release/udx.node',
            to: './out/udx.node'
          },
          {
            from: './node_modules/sodium-native/build/Release/sodium.node',
            to: './out/sodium.node'
          },
          {
            from: './node_modules/b4a/**',
            to: './out/node_modules/b4a'
          },
          {
            from: './node_modules/node-gyp-build/**',
            to: './out/node_modules/node-gyp-build'
          },
          {
            from: './node_modules/streamx/**',
            to: './out/node_modules/streamx'
          }
          ,
          {
            from: './node_modules/fast-fifo/**',
            to: './out/node_modules/fast-fifo'
          }
          ,
          {
            from: './node_modules/queue-tick/**',
            to: './out/node_modules/queue-tick'
          }
          ,
          {
            from: './node_modules/text-decoder/**',
            to: './out/node_modules/text-decoder'
          }
        ],
        watch: true,
      }),
    ]
  }

  const webConfig = {
    bundle: true,
    external: ['vscode'],
    entryPoints: ['src/webview/index.tsx'],
    outfile: 'out/sidebar.js',
    sourcemap: true,
    plugins: [],
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
