import {
  FIM_TEMPLATE_FORMAT,
  STOP_DEEPSEEK,
  STOP_LLAMA,
  STOP_STARCODER,
  STOP_CODEGEMMA
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

  if (
    fimModel.includes(FIM_TEMPLATE_FORMAT.stableCode) ||
    fimModel.includes(FIM_TEMPLATE_FORMAT.starcoder) ||
    fimModel.includes(FIM_TEMPLATE_FORMAT.codeqwen) ||
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

  if (
    format === FIM_TEMPLATE_FORMAT.stableCode ||
    format === FIM_TEMPLATE_FORMAT.starcoder ||
    format === FIM_TEMPLATE_FORMAT.codegemma ||
    format === FIM_TEMPLATE_FORMAT.codeqwen
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
    fimModel.includes(FIM_TEMPLATE_FORMAT.starcoder)
  ) {
    return ['<|endoftext|>']
  }

  if (fimModel.includes(FIM_TEMPLATE_FORMAT.codegemma)) {
    return STOP_CODEGEMMA
  }

  return STOP_LLAMA
}

export const getStopWordsChosen = (format: string) => {
  if (format === FIM_TEMPLATE_FORMAT.codellama) return STOP_LLAMA
  if (format === FIM_TEMPLATE_FORMAT.deepseek) return STOP_DEEPSEEK
  if (
    format === FIM_TEMPLATE_FORMAT.stableCode ||
    format === FIM_TEMPLATE_FORMAT.starcoder
  )
    return STOP_STARCODER
  if (format === FIM_TEMPLATE_FORMAT.codegemma) return STOP_CODEGEMMA
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
