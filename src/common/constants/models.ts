import { defaultTemplates } from "../../extension/templates"

export const FIM_TEMPLATE_FORMAT = {
  automatic: "automatic",
  codegemma: "codegemma",
  codellama: "codellama",
  codeqwen: "codeqwen",
  codestral: "codestral",
  custom: "custom-template",
  deepseek: "deepseek",
  llama: "llama",
  stableCode: "stable-code",
  starcoder: "starcoder"
}

export const STOP_LLAMA = ["<EOT>"]

export const STOP_DEEPSEEK = [
  "<｜fim begin｜>",
  "<｜fim hole｜>",
  "<｜fim end｜>",
  "<END>",
  "<｜end of sentence｜>"
]

export const STOP_STARCODER = [
  "<|endoftext|>",
  "<file_sep>",
  "<file_sep>",
  "<fim_prefix>",
  "<repo_name>"
]

export const STOP_QWEN = [
  "<|endoftext|>",
  "<|file_sep|>",
  "<|fim_prefix|>",
  "<|im_end|>",
  "<|im_start|>",
  "<|repo_name|>",
  "<|fim_pad|>",
  "<|cursor|>"
]

export const STOP_CODEGEMMA = ["<|file_separator|>", "<|end_of_turn|>", "<eos>"]

export const STOP_CODESTRAL = ["[PREFIX]", "[SUFFIX]"]

export const DEFAULT_TEMPLATE_NAMES = defaultTemplates.map(({ name }) => name)

export const DEFAULT_ACTION_TEMPLATES = []

export const WASM_LANGUAGES: { [key: string]: string } = {
  "php-s": "php",
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "c_sharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  eex: "embedded_template",
  el: "elisp",
  elm: "elm",
  emacs: "elisp",
  erb: "ruby",
  ex: "elixir",
  exs: "elixir",
  go: "go",
  h: "c",
  heex: "embedded_template",
  hpp: "cpp",
  htm: "html",
  html: "html",
  hxx: "cpp",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  leex: "embedded_template",
  lua: "lua",
  mjs: "javascript",
  ml: "ocaml",
  mli: "ocaml",
  mts: "typescript",
  ocaml: "ocaml",
  php: "php",
  php3: "php",
  php4: "php",
  php5: "php",
  php7: "php",
  phps: "php",
  phtml: "php",
  py: "python",
  pyi: "python",
  pyw: "python",
  ql: "ql",
  rb: "ruby",
  rdl: "systemrdl",
  res: "rescript",
  resi: "rescript",
  rs: "rust",
  sh: "bash",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue"
}
