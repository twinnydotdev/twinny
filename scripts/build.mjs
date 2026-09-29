/* eslint-disable no-undef */
// eslint-disable-next-line @typescript-eslint/no-var-requires
import esbuild from "esbuild"
import { copy } from "esbuild-plugin-copy";
import fs from "node:fs"

(async () => {
  const extensionConfig = {
    bundle: true,
    entryPoints: ["src/index.ts", "src/extension/embeddings/rerank-worker.ts"],
    external: ["vscode", "esbuild", "./xhr-sync-worker.js", "sodium-native", "udx-native", "b4a"],
    format: "cjs",
    outdir: "out",
    platform: "node",
    sourcemap: true,
    loader: { ".node": "file" },
    assetNames: "[name]",
    plugins: [
      copy({
        resolveFrom: "cwd",
        assets: [
          {
            from: "./node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm",
            to: "./out/ort-wasm-simd.wasm"
          },
          {
            from: "./node_modules/tree-sitter-wasms/out/**/*.wasm",
            to: "./out/tree-sitter-wasms"
          },
          {
            from: "./node_modules/web-tree-sitter/tree-sitter.wasm",
            to: "./out/tree-sitter.wasm"
          },
          {
            from: "./node_modules/web-tree-sitter/tree-sitter.wasm",
            to: "./out/tree-sitter.wasm"
          },
          {
            from: "./node_modules/web-tree-sitter/tree-sitter.wasm",
            to: "./out/tree-sitter.wasm"
          }
        ],
        watch: true,
      }),
    ]
  }

  // The headless node: `node out/node/cli.js` on the machine with the GPU.
  const nodeConfig = {
      bundle: true,
      entryPoints: ["src/node/cli.ts"],
      external: ["vscode", "sodium-native", "udx-native", "b4a"],
      format: "cjs",
      outfile: "out/node/cli.js",
      platform: "node",
      target: "node18",
      sourcemap: true,
    }

  // The gateway as an npm package: one file, no runtime dependencies, so
  // `npx twinny-server` needs nothing but Node. Version follows the root.
  const rootVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version
  const serverPackageFile = "packages/twinny-server/package.json"
  const serverPackage = JSON.parse(fs.readFileSync(serverPackageFile, "utf8"))
  if (serverPackage.version !== rootVersion) {
    serverPackage.version = rootVersion
    fs.writeFileSync(serverPackageFile, `${JSON.stringify(serverPackage, null, 2)}\n`)
  }
  // The admin page: a small React app, bundled to a string and inlined
  // into the server bundle, so the package stays one file with no assets.
  const adminUi = await esbuild.build({
    bundle: true,
    entryPoints: ["src/gateway/ui/index.tsx"],
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    write: false,
    define: { "process.env.NODE_ENV": "\"production\"" },
    logLevel: "silent"
  })
  const adminJs = adminUi.outputFiles[0]?.text ?? ""
  const adminCss = fs.readFileSync("src/gateway/ui/styles.css", "utf8")

  const serverConfig = {
    bundle: true,
    entryPoints: ["src/gateway/cli.ts"],
    external: ["vscode"],
    format: "cjs",
    outfile: "packages/twinny-server/cli.js",
    platform: "node",
    target: "node18",
    sourcemap: false,
    // No deprecation notices, and no "SQLite is experimental" line ahead of
    // the admin key: the sqlite store is optional and guarded at runtime.
    banner: {
      js: [
        "#!/usr/bin/env node",
        "process.noDeprecation = true;",
        "{ const emit = process.emitWarning; process.emitWarning = function (warning, ...rest) {",
        "  const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;",
        "  if (type === 'ExperimentalWarning' || (warning && warning.name === 'ExperimentalWarning')) return;",
        "  return emit.call(process, warning, ...rest); }; }"
      ].join("\n")
    },
    define: {
      __TWINNY_SERVER_VERSION__: JSON.stringify(rootVersion),
      __TWINNY_ADMIN_JS__: JSON.stringify(adminJs),
      __TWINNY_ADMIN_CSS__: JSON.stringify(adminCss)
    },
    logOverride: { "equals-negative-zero": "silent" }
  }

  const webConfig = {
    bundle: true,
    external: ["vscode"],
    entryPoints: ["src/webview/index.tsx"],
    outfile: "out/sidebar.js",
    sourcemap: true,
    plugins: [],
  }

  const flags = process.argv.slice(2);

  if (flags.includes("--watch")) {
    const ctx = await esbuild.context(webConfig);
    const ectx = await esbuild.context(extensionConfig);
    const nctx = await esbuild.context(nodeConfig);
    const sctx = await esbuild.context(serverConfig);
    await ctx.watch();
    await ectx.watch();
    await nctx.watch();
    await sctx.watch();
  } else {
    await esbuild.build(webConfig);
    await esbuild.build(extensionConfig);
    await esbuild.build(nodeConfig);
    await esbuild.build(serverConfig);
    fs.chmodSync(serverConfig.outfile, 0o755);
  }
})()
