import {
  FIM_TEMPLATE_FORMAT,
  STOP_CODEGEMMA,
  STOP_CODESTRAL,
  STOP_DEEPSEEK,
  STOP_LLAMA,
  STOP_QWEN,
  STOP_STARCODER
} from "../../common/constants"
import { supportedLanguages } from "../../common/languages"
import { FimContextFile, FimPromptTemplate } from "../../common/types"

type FimFormat = Exclude<
  (typeof FIM_TEMPLATE_FORMAT)[keyof typeof FIM_TEMPLATE_FORMAT],
  "automatic" | "custom-template"
>

/**
 * Substrings of a model name that identify its FIM dialect, checked in order.
 * More specific names come first so e.g. "codellama" wins over "llama".
 */
const MODEL_NAME_HINTS: [string, FimFormat][] = [
  ["codellama", FIM_TEMPLATE_FORMAT.codellama],
  ["code-llama", FIM_TEMPLATE_FORMAT.codellama],
  ["deepseek", FIM_TEMPLATE_FORMAT.deepseek],
  ["codestral", FIM_TEMPLATE_FORMAT.codestral],
  ["qwen", FIM_TEMPLATE_FORMAT.codeqwen],
  ["codegemma", FIM_TEMPLATE_FORMAT.codegemma],
  ["stable-code", FIM_TEMPLATE_FORMAT.stableCode],
  ["stablecode", FIM_TEMPLATE_FORMAT.stableCode],
  ["starcoder", FIM_TEMPLATE_FORMAT.starcoder],
  ["granite", FIM_TEMPLATE_FORMAT.starcoder],
  ["codegeex", FIM_TEMPLATE_FORMAT.starcoder],
  ["llama", FIM_TEMPLATE_FORMAT.llama]
]

const DEFAULT_FORMAT: FimFormat = FIM_TEMPLATE_FORMAT.codellama

/**
 * Works out which FIM dialect to use for a provider: the one the user picked,
 * or one inferred from the model name when the template is "automatic" or a
 * custom template (custom templates still need the right stop words).
 */
export const resolveFimFormat = (
  modelName: string,
  chosenFormat: string | undefined
): FimFormat => {
  const chosen = chosenFormat || FIM_TEMPLATE_FORMAT.automatic
  if (
    chosen !== FIM_TEMPLATE_FORMAT.automatic &&
    chosen !== FIM_TEMPLATE_FORMAT.custom
  ) {
    return chosen in templateMap ? (chosen as FimFormat) : DEFAULT_FORMAT
  }
  const name = (modelName || "").toLowerCase()
  for (const [hint, format] of MODEL_NAME_HINTS) {
    if (name.includes(hint)) return format
  }
  return DEFAULT_FORMAT
}

/**
 * With nothing after the cursor there is no "middle" to fill in. Base code
 * models continue plain text reliably, whereas FIM markers with an empty
 * suffix make some of them (CodeLlama in particular) stop straight away.
 */
const hasSuffix = ({ prefixSuffix }: FimPromptTemplate) =>
  prefixSuffix.suffix.trim().length > 0

const getCommentSyntax = (language: string | undefined) => {
  const details =
    supportedLanguages[language as keyof typeof supportedLanguages]
  return {
    start: details?.syntaxComments?.start || "//",
    end: details?.syntaxComments?.end || ""
  }
}

/** Renders neighbouring files as commented blocks for models without repo tokens. */
const renderCommentedContext = (
  files: FimContextFile[],
  language: string | undefined
) => {
  if (!files.length) return ""
  const { start, end } = getCommentSyntax(language)
  return (
    files
      .map((file) => `${start} File: ${file.name} ${end}\n${file.text.trimEnd()}`)
      .join("\n\n") + "\n\n"
  )
}

/** Renders neighbouring files with a per-file separator token, then names the current file. */
const renderSeparatedContext = (
  files: FimContextFile[],
  separator: string,
  fileName: string
) => {
  if (!files.length) return ""
  let context = ""
  for (const file of files) {
    context += `${separator}${file.name}\n${file.text.trimEnd()}\n`
  }
  return `${context}${separator}${fileName}\n`
}

/**
 * Meta's reference format is `<SUF>{suffix}`, but with a space CodeLlama is
 * far more robust when the cursor sits between quotes: without it the model
 * ignores the hole and re-emits the file from the top.
 */
const codellama = (args: FimPromptTemplate) => {
  const { prefix, suffix } = args.prefixSuffix
  const body = `${renderCommentedContext(args.contextFiles, args.language)}${args.header}${prefix}`
  return hasSuffix(args) ? `<PRE> ${body} <SUF> ${suffix} <MID>` : body
}

const deepseek = (args: FimPromptTemplate) => {
  const { prefix, suffix } = args.prefixSuffix
  const body = `${renderCommentedContext(args.contextFiles, args.language)}${args.header}${prefix}`
  return hasSuffix(args)
    ? `<｜fim▁begin｜>${body}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`
    : body
}

const codestral = (args: FimPromptTemplate) => {
  const { prefix, suffix } = args.prefixSuffix
  const body = `${renderCommentedContext(args.contextFiles, args.language)}${args.header}${prefix}`
  return hasSuffix(args) ? `[SUFFIX]${suffix}[PREFIX]${body}` : body
}

const qwen = (args: FimPromptTemplate) => {
  const { prefix, suffix } = args.prefixSuffix
  const context = renderSeparatedContext(
    args.contextFiles,
    "<|file_sep|>",
    args.fileName
  )
  return hasSuffix(args)
    ? `${context}<|fim_prefix|>${args.header}${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`
    : `${context}${args.header}${prefix}`
}

const codegemma = (args: FimPromptTemplate) => {
  const { prefix, suffix } = args.prefixSuffix
  const context = renderSeparatedContext(
    args.contextFiles,
    "<|file_separator|>",
    args.fileName
  )
  return hasSuffix(args)
    ? `${context}<|fim_prefix|>${args.header}${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`
    : `${context}${args.header}${prefix}`
}

const starcoder = (args: FimPromptTemplate) => {
  const { prefix, suffix } = args.prefixSuffix
  const files = renderSeparatedContext(
    args.contextFiles,
    "<file_sep>",
    args.fileName
  )
  const context = files ? `<repo_name>${args.repoName}\n${files}` : ""
  return hasSuffix(args)
    ? `${context}<fim_prefix>${args.header}${prefix}<fim_suffix>${suffix}<fim_middle>`
    : `${context}${args.header}${prefix}`
}

const templateMap: Record<FimFormat, (args: FimPromptTemplate) => string> = {
  [FIM_TEMPLATE_FORMAT.codellama]: codellama,
  [FIM_TEMPLATE_FORMAT.llama]: codellama,
  [FIM_TEMPLATE_FORMAT.deepseek]: deepseek,
  [FIM_TEMPLATE_FORMAT.codestral]: codestral,
  [FIM_TEMPLATE_FORMAT.codeqwen]: qwen,
  [FIM_TEMPLATE_FORMAT.codegemma]: codegemma,
  [FIM_TEMPLATE_FORMAT.stableCode]: starcoder,
  [FIM_TEMPLATE_FORMAT.starcoder]: starcoder
}

const stopWordsMap: Record<FimFormat, string[]> = {
  [FIM_TEMPLATE_FORMAT.codellama]: STOP_LLAMA,
  [FIM_TEMPLATE_FORMAT.llama]: STOP_LLAMA,
  [FIM_TEMPLATE_FORMAT.deepseek]: STOP_DEEPSEEK,
  [FIM_TEMPLATE_FORMAT.codestral]: STOP_CODESTRAL,
  [FIM_TEMPLATE_FORMAT.codeqwen]: STOP_QWEN,
  [FIM_TEMPLATE_FORMAT.codegemma]: STOP_CODEGEMMA,
  [FIM_TEMPLATE_FORMAT.stableCode]: STOP_STARCODER,
  [FIM_TEMPLATE_FORMAT.starcoder]: STOP_STARCODER
}

export const getFimPrompt = (
  modelName: string,
  format: string | undefined,
  args: FimPromptTemplate
) => templateMap[resolveFimFormat(modelName, format)](args)

export const getStopWords = (modelName: string, format: string | undefined) =>
  stopWordsMap[resolveFimFormat(modelName, format)]

/**
 * Qwen2.5-Coder style repository-level prompt: every context file, then the
 * current file with FIM markers, all under a repo header.
 */
export const getFimTemplateRepositoryLevel = (args: FimPromptTemplate) => {
  const { prefix, suffix } = args.prefixSuffix
  let prompt = `<|repo_name|>${args.repoName}\n`
  for (const file of args.contextFiles) {
    prompt += `<|file_sep|>${file.name}\n${file.text.trimEnd()}\n`
  }
  prompt += `<|file_sep|>${args.fileName}\n`
  return hasSuffix(args)
    ? `${prompt}<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`
    : `${prompt}${prefix}`
}
