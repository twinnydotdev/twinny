import { ContextItem } from "../types"

export const EXTENSION_NAME = "@ext:rjmacarthy.twinny"
export const ASSISTANT = "assistant"
export const USER = "user"
export const TWINNY = "twinny"
export const SYSTEM = "system"
export const YOU = "You"
export const EMPTY_MESAGE = "Sorry, I don’t understand. Please try again."
export const MODEL_ERROR = "Sorry, something went wrong..."
export const OPENING_BRACKETS = ["[", "{", "("]
export const CLOSING_BRACKETS = ["]", "}", ")"]
export const OPENING_TAGS = ["<"]
export const CLOSING_TAGS = ["</"]
export const QUOTES = ["\"", "'", "`"]
export const ALL_BRACKETS = [...OPENING_BRACKETS, ...CLOSING_BRACKETS] as const
export const BRACKET_REGEX = /^[()[\]{}]+$/
export const NORMALIZE_REGEX = /\s*\r?\n|\r/g
export const LINE_BREAK_REGEX = /\r?\n|\r|\n/g
export const FILE_NAME_REGEX =
  /(?:^|\s|`)(?:@\/|\.\/|(?:[\w-]+\/)*)?\.?[\w.-]+\.(?:jsx?|tsx?|css|s[ac]ss|less|styl|html?|json|jsonc|md|markdown|py|ipynb|java|class|jar|cpp|hpp|cc|hh|c|h|rs|go|php|rb|swift|kt|gradle|m|mm|cs|fs|fsx|elm|lua|sql|ya?ml|toml|xml|conf|ini|env|sh|bash|zsh|ps1|bat|cmd|txt|log|text|doc|rtf|pdf|lock|editorconfig|gitignore|eslintrc|prettier|babelrc|d\.ts|test\.tsx?|spec\.tsx?|snap|svg|graphql|gql|proto|vue|svelte|astro|razor|cshtml|aspx?|jsx?\.map|tsx?\.map|min\.js|chunk\.js|bundle\.js)(?=\s|$|`)/g
export const QUOTES_REGEX = /["'`]/g
export const MAX_CONTEXT_LINE_COUNT = 200
export const SKIP_DECLARATION_SYMBOLS = ["="]
export const IMPORT_SEPARATOR = [",", "{"]
export const SKIP_IMPORT_KEYWORDS_AFTER = ["from", "as", "import"]
export const MIN_COMPLETION_CHUNKS = 2
export const MAX_EMPTY_COMPLETION_CHARS = 250
export const DEFAULT_RERANK_THRESHOLD = 0.5
export const URL_SYMMETRY_WS = "https://twinny.dev/ws"
export const TWINNY_PROVIDERS_FILENAME = "twinny-providers.json"

export const defaultChunkOptions = {
  maxSize: 500,
  minSize: 50,
  overlap: 50
}

export const TITLE_GENERATION_PROMPT_MESAGE = `
  Generate a title for this conversation in under 10 words.
  It should not contain any special characters or quotes.
`

export const DEFAULT_RELEVANT_FILE_COUNT = 10
export const DEFAULT_RELEVANT_CODE_COUNT = 5

export const MULTILINE_OUTSIDE = [
  "class_body",
  "class",
  "export",
  "identifier",
  "interface_body",
  "interface",
  "program"
]

export const MULTILINE_INSIDE = [
  "body",
  "export_statement",
  "formal_parameters",
  "function_definition",
  "named_imports",
  "object_pattern",
  "object_type",
  "object",
  "parenthesized_expression",
  "statement_block"
]

export const MULTILINE_TYPES = [...MULTILINE_OUTSIDE, ...MULTILINE_INSIDE]

export const MULTI_LINE_DELIMITERS = ["\n\n", "\r\n\r\n"]

//Define an array containing all the error messages that need to be detected when fetch error occurred
export const knownErrorMessages = [
  "First parameter has member 'readable' that is not a ReadableStream.", //This error occurs When plugins such as Fitten Code are enabled
  "The 'transform.readable' property must be an instance of ReadableStream. Received an instance of h" //When you try to enable the Node.js compatibility mode Compat to solve the problem, this error may pop up
]

export const topLevelItems: ContextItem[] = [
  { name: "workspace", path: "", category: "files", id: "workspace" },
  { name: "problems", path: "", category: "files", id: "problems" }
]
