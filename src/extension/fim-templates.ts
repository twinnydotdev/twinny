import {
  FIM_TEMPLATE_FORMAT,
  STOP_DEEPSEEK,
  STOP_LLAMA,
  STOP_STARCODER_QWEN,
  STOP_CODEGEMMA,
  STOP_CODESTRAL,
} from '../common/constants'
import { supportedLanguages } from '../common/languages'
import { FimPromptTemplate } from '../common/types'

const getFileContext = (
  fileContextEnabled: boolean,
  context: string,
  language: string | undefined,
  header: string
) => {
  const languageId =
    supportedLanguages[language as keyof typeof supportedLanguages]
  const fileContext = fileContextEnabled
    ? `${languageId?.syntaxComments?.start || ''}${context}${
        languageId?.syntaxComments?.end || ''
      }`
    : ''
  return { heading: header ?? '', fileContext }
}

export const getFimPromptTemplateLLama = ({
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

export const getDefaultFimPromptTemplate = (args: FimPromptTemplate) =>
  getFimPromptTemplateLLama(args)

export const getFimPromptTemplateDeepseek = ({
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

export const getFimPromptTemplateCodestral = ({
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

export const getFimPromptTemplateQwen = ({
  prefixSuffix,
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  return `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`
}

export const getFimPromptTemplateOther = ({
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

function getFimTemplateAuto(fimModel: string, args: FimPromptTemplate) {
  if (
    fimModel.includes(FIM_TEMPLATE_FORMAT.codellama) ||
    fimModel.includes(FIM_TEMPLATE_FORMAT.llama)
  ) {
    return getFimPromptTemplateLLama(args)
  }

  if (fimModel.includes(FIM_TEMPLATE_FORMAT.deepseek)) {
    return getFimPromptTemplateDeepseek(args)
  }

  if (fimModel.includes(FIM_TEMPLATE_FORMAT.codestral)) {
    return getFimPromptTemplateCodestral(args)
  }

  if (fimModel.includes(FIM_TEMPLATE_FORMAT.codeqwen)) {
    return getFimPromptTemplateQwen(args)
  }

  if (
    fimModel.includes(FIM_TEMPLATE_FORMAT.stableCode) ||
    fimModel.includes(FIM_TEMPLATE_FORMAT.starcoder) ||
    fimModel.includes(FIM_TEMPLATE_FORMAT.codegemma)
  ) {
    return getFimPromptTemplateOther(args)
  }

  return getDefaultFimPromptTemplate(args)
}

function getFimTemplateChosen(format: string, args: FimPromptTemplate) {
  if (format === FIM_TEMPLATE_FORMAT.codellama) {
    return getFimPromptTemplateLLama(args)
  }

  if (format === FIM_TEMPLATE_FORMAT.deepseek) {
    return getFimPromptTemplateDeepseek(args)
  }

  if (format === FIM_TEMPLATE_FORMAT.codestral) {
    return getFimPromptTemplateCodestral(args)
  }

  if (format === FIM_TEMPLATE_FORMAT.codeqwen) {
    return getFimPromptTemplateQwen(args)
  }

  if (
    format === FIM_TEMPLATE_FORMAT.stableCode ||
    format === FIM_TEMPLATE_FORMAT.starcoder ||
    format === FIM_TEMPLATE_FORMAT.codegemma
  ) {
    return getFimPromptTemplateOther(args)
  }

  return getDefaultFimPromptTemplate(args)
}

export const getFimPrompt = (
  fimModel: string,
  format: string,
  args: FimPromptTemplate
) => {
  if (format === FIM_TEMPLATE_FORMAT.automatic) {
    return getFimTemplateAuto(fimModel, args)
  }
  return getFimTemplateChosen(format, args)
}

export const getStopWordsAuto = (fimModel: string) => {
  if (
    fimModel.includes(FIM_TEMPLATE_FORMAT.codellama) ||
    fimModel.includes(FIM_TEMPLATE_FORMAT.llama)
  ) {
    return STOP_LLAMA
  }

  if (fimModel.includes(FIM_TEMPLATE_FORMAT.deepseek)) {
    return STOP_DEEPSEEK
  }

  if (
    fimModel.includes(FIM_TEMPLATE_FORMAT.stableCode) ||
    fimModel.includes(FIM_TEMPLATE_FORMAT.starcoder) ||
    fimModel.includes(FIM_TEMPLATE_FORMAT.codeqwen)
  ) {
    return STOP_STARCODER_QWEN
  }

  if (fimModel.includes(FIM_TEMPLATE_FORMAT.codegemma)) {
    return STOP_CODEGEMMA
  }

  if (fimModel.includes(FIM_TEMPLATE_FORMAT.codestral)) {
    return STOP_CODESTRAL
  }

  return STOP_LLAMA
}

export const getStopWordsChosen = (format: string) => {
  if (format === FIM_TEMPLATE_FORMAT.codellama) return STOP_LLAMA
  if (format === FIM_TEMPLATE_FORMAT.deepseek) return STOP_DEEPSEEK
  if (format === FIM_TEMPLATE_FORMAT.codeqwen) return STOP_STARCODER_QWEN
  if (
    format === FIM_TEMPLATE_FORMAT.stableCode ||
    format === FIM_TEMPLATE_FORMAT.starcoder
  )
    return STOP_STARCODER_QWEN
  if (format === FIM_TEMPLATE_FORMAT.codegemma) return STOP_CODEGEMMA
  if (format === FIM_TEMPLATE_FORMAT.codestral) return STOP_CODESTRAL
  return STOP_LLAMA
}

export const getStopWords = (fimModel: string, format: string) => {
  if (
    format === FIM_TEMPLATE_FORMAT.automatic ||
    format === FIM_TEMPLATE_FORMAT.custom
  ) {
    return getStopWordsAuto(fimModel)
  }
  return getStopWordsChosen(format)
}
