import path from "path"

/**
 * Decides which files are worth embedding. The walk is allowlist-based: a
 * file is indexed only when its extension (or well-known name) is on the
 * list below and its contents don't look binary. Anything else, fonts,
 * images, archives, lockfiles, is skipped without being read.
 */

const INDEXABLE_EXTENSIONS = new Set([
  // Web
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte",
  "astro", "html", "htm", "css", "scss", "sass", "less", "styl",
  // Systems
  "c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx", "m", "mm", "rs", "go",
  "zig", "d", "nim", "swift", "cu", "cuh",
  // JVM / .NET
  "java", "kt", "kts", "scala", "groovy", "gradle", "cs", "fs", "fsx", "vb",
  // Scripting
  "py", "pyi", "rb", "php", "pl", "pm", "lua", "r", "jl", "sh", "bash", "zsh",
  "fish", "ps1", "psm1", "bat", "cmd", "tcl", "awk",
  // Functional / other
  "ex", "exs", "erl", "hrl", "hs", "lhs", "ml", "mli", "clj", "cljs", "cljc",
  "edn", "elm", "dart", "sol", "v", "sv", "vhd", "vhdl", "wat",
  // Data / config
  "json", "jsonc", "json5", "jsonl", "yaml", "yml", "toml", "ini", "cfg",
  "conf", "properties", "xml", "xaml", "plist", "csv", "tsv",
  "graphql", "gql", "proto", "thrift", "avsc", "tf", "tfvars", "hcl",
  "nix", "cmake", "mk", "ninja", "bazel", "bzl", "sql", "prisma",
  // Docs
  "md", "mdx", "markdown", "rst", "adoc", "txt", "text", "org", "tex", "bib",
  // Misc text
  "diff", "patch", "editorconfig", "gitattributes", "dockerignore",
  "npmrc", "nvmrc", "prettierrc", "eslintrc", "babelrc", "svg"
])

const INDEXABLE_FILENAMES = new Set([
  "makefile", "gnumakefile", "dockerfile", "containerfile", "vagrantfile",
  "rakefile", "gemfile", "podfile", "brewfile", "procfile", "justfile",
  "cmakelists.txt", "build", "workspace", "readme", "license", "licence",
  "changelog", "authors", "contributing", "codeowners", "jenkinsfile",
  ".gitignore", ".gitattributes", ".editorconfig", ".dockerignore",
  ".npmrc", ".nvmrc", ".prettierrc", ".eslintrc", ".babelrc"
])

/** Generated files that are text but never useful as context. */
const SKIPPED_FILENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "composer.lock", "gemfile.lock", "poetry.lock", "cargo.lock",
  "go.sum", "flake.lock", "packages.lock.json"
])

const SKIPPED_SUFFIXES = [".min.js", ".min.css", ".map", ".snap", ".lock"]

/** Should this path be read and embedded, judging by its name alone? */
export function isIndexablePath(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase()
  if (SKIPPED_FILENAMES.has(name)) return false
  if (SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false
  if (INDEXABLE_FILENAMES.has(name)) return true

  const ext = name.startsWith(".") && !name.slice(1).includes(".")
    ? name.slice(1)
    : path.extname(name).slice(1)
  if (!ext) return false
  if (INDEXABLE_EXTENSIONS.has(ext)) return true
  // README.md.bak, config.yaml.example, foo.ts.txt: judge by the inner
  // extension when the outer one is an obvious wrapper.
  const inner = path.extname(name.slice(0, -(ext.length + 1))).slice(1)
  return ["bak", "example", "sample", "template", "dist", "orig"].includes(ext)
    && INDEXABLE_EXTENSIONS.has(inner)
}

const SNIFF_BYTES = 8000

/**
 * Cheap binary sniff, the same heuristic git uses: a NUL byte in the first
 * few KB means the file isn't text. Catches misnamed files and things like
 * `.svg` files that are really gzipped.
 */
export function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, SNIFF_BYTES)
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}
