import {
  FIM_TEMPLATE_FORMAT,
  STOP_CODEGEMMA,
  STOP_CODESTRAL,
  STOP_DEEPSEEK,
  STOP_LLAMA,
  STOP_QWEN,
  STOP_STARCODER
} from "../common/constants"
import { supportedLanguages } from "../common/languages"
import {
  FimPromptTemplate,
  PrefixSuffix,
  RepositoryLevelData
} from "../common/types"

const getFileContext = (
  fileContextEnabled: boolean,
  context: string,
  language: string | undefined,
  header: string
) => {
  const languageId =
    supportedLanguages[language as keyof typeof supportedLanguages]
  const fileContext = fileContextEnabled
    ? `${languageId?.syntaxComments?.start || ""}${context}${
        languageId?.syntaxComments?.end || ""
      }`
    : ""
  return { heading: header ?? "", fileContext }
}

const getFimPromptTemplateLLama = ({
  context,
  header,
  fileContextEnabled,
  prefixSuffix,
  language
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  const { fileContext, heading } = getFileContext(
    fileContextEnabled,
    context,
    language,
    header
  )
  return `<PRE>${fileContext} \n${heading}${prefix} <SUF> ${suffix} <MID>`
}

const getFimPromptTemplateDeepseek = ({
  context,
  header,
  fileContextEnabled,
  prefixSuffix,
  language
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  const { fileContext, heading } = getFileContext(
    fileContextEnabled,
    context,
    language,
    header
  )
  return `<｜fim▁begin｜>${fileContext}\n${heading}${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`
}

const getFimPromptTemplateCodestral = ({
  context,
  header,
  fileContextEnabled,
  prefixSuffix,
  language
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  const { fileContext, heading } = getFileContext(
    fileContextEnabled,
    context,
    language,
    header
  )
  return `${fileContext}\n\n[SUFFIX]${suffix}[PREFIX]${heading}${prefix}`
}

const getFimPromptTemplateQwen = ({ prefixSuffix }: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  return `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`
}

const getFimPromptTemplateOther = ({
  context,
  header,
  fileContextEnabled,
  prefixSuffix,
  language
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  const { fileContext, heading } = getFileContext(
    fileContextEnabled,
    context,
    language,
    header
  )
  return `<fim_prefix>${fileContext}\n${heading}${prefix}<fim_suffix>${suffix}<fim_middle>`
}

const getFimPromptTemplateQwenMulti = (
  repo: string,
  files: RepositoryLevelData[],
  prefixSuffix: PrefixSuffix,
  currentFileName: string | undefined
): string => {
  let prompt = `<|repo_name|>${repo}\n`
  for (const file of files) {
    prompt += `<|file_sep|>${file.name}\n${file.text}\n`
  }
  prompt += `<|file_sep|>${currentFileName}\n${prefixSuffix.prefix}`
  return prompt.trim()
}

const templateMap: Record<string, (args: FimPromptTemplate) => string> = {
  [FIM_TEMPLATE_FORMAT.codellama]: getFimPromptTemplateLLama,
  [FIM_TEMPLATE_FORMAT.llama]: getFimPromptTemplateLLama,
  [FIM_TEMPLATE_FORMAT.deepseek]: getFimPromptTemplateDeepseek,
  [FIM_TEMPLATE_FORMAT.codestral]: getFimPromptTemplateCodestral,
  [FIM_TEMPLATE_FORMAT.codeqwen]: getFimPromptTemplateQwen,
  [FIM_TEMPLATE_FORMAT.stableCode]: getFimPromptTemplateOther,
  [FIM_TEMPLATE_FORMAT.starcoder]: getFimPromptTemplateOther,
  [FIM_TEMPLATE_FORMAT.codegemma]: getFimPromptTemplateOther
}

export const getDefaultFimPromptTemplate = (args: FimPromptTemplate) =>
  getFimPromptTemplateLLama(args)

const getFimTemplateAuto = (fimModel: string, args: FimPromptTemplate) => {
  for (const format of [
    FIM_TEMPLATE_FORMAT.codellama,
    FIM_TEMPLATE_FORMAT.llama,
    FIM_TEMPLATE_FORMAT.deepseek,
    FIM_TEMPLATE_FORMAT.codestral,
    FIM_TEMPLATE_FORMAT.codeqwen,
    FIM_TEMPLATE_FORMAT.stableCode,
    FIM_TEMPLATE_FORMAT.starcoder,
    FIM_TEMPLATE_FORMAT.codegemma
  ]) {
    if (fimModel.includes(format)) {
      return templateMap[format](args)
    }
  }
  return getDefaultFimPromptTemplate(args)
}

const getFimTemplateChosen = (format: string, args: FimPromptTemplate) => {
  return templateMap[format]
    ? templateMap[format](args)
    : getDefaultFimPromptTemplate(args)
}

export const getFimPrompt = (
  fimModel: string,
  format: string,
  args: FimPromptTemplate
) => {
  return format === FIM_TEMPLATE_FORMAT.automatic
    ? getFimTemplateAuto(fimModel, args)
    : getFimTemplateChosen(format, args)
}

const stopWordsMap: Record<string, string[]> = {
  [FIM_TEMPLATE_FORMAT.codellama]: STOP_LLAMA,
  [FIM_TEMPLATE_FORMAT.llama]: STOP_LLAMA,
  [FIM_TEMPLATE_FORMAT.deepseek]: STOP_DEEPSEEK,
  [FIM_TEMPLATE_FORMAT.stableCode]: STOP_STARCODER,
  [FIM_TEMPLATE_FORMAT.starcoder]: STOP_STARCODER,
  [FIM_TEMPLATE_FORMAT.codeqwen]: STOP_QWEN,
  [FIM_TEMPLATE_FORMAT.codegemma]: STOP_CODEGEMMA,
  [FIM_TEMPLATE_FORMAT.codestral]: STOP_CODESTRAL
}

export const getStopWordsAuto = (fimModel: string) => {
  for (const format of [
    FIM_TEMPLATE_FORMAT.codellama,
    FIM_TEMPLATE_FORMAT.llama,
    FIM_TEMPLATE_FORMAT.deepseek,
    FIM_TEMPLATE_FORMAT.stableCode,
    FIM_TEMPLATE_FORMAT.starcoder,
    FIM_TEMPLATE_FORMAT.codeqwen,
    FIM_TEMPLATE_FORMAT.codegemma,
    FIM_TEMPLATE_FORMAT.codestral
  ]) {
    if (fimModel.includes(format)) {
      return stopWordsMap[format]
    }
  }
  return STOP_LLAMA
}

export const getStopWordsChosen = (format: string) => {
  return stopWordsMap[format] || STOP_LLAMA
}

export const getStopWords = (fimModel: string, format: string) => {
  return format === FIM_TEMPLATE_FORMAT.automatic ||
    format === FIM_TEMPLATE_FORMAT.custom
    ? getStopWordsAuto(fimModel)
    : getStopWordsChosen(format)
}

export const getFimTemplateRepositoryLevel = (
  repo: string,
  code: RepositoryLevelData[],
  prefixSuffix: PrefixSuffix,
  currentFileName: string | undefined
) => {
  return getFimPromptTemplateQwenMulti(
    repo,
    code,
    prefixSuffix,
    currentFileName
  )
}
