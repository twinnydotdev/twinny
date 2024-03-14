import {
  FIM_TEMPLATE_FORMAT,
  STOP_DEEPSEEK,
  STOP_LLAMA,
  STOP_STARCODER2,
  STOP_STABLECODE
} from '../common/constants'
import { supportedLanguages } from '../common/languages'
import { FimPromptTemplate } from '../common/types'

export const getFimPromptTemplateLLama = ({
  file,
  context,
  useFileContext,
  prefixSuffix,
  language
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  const languageId =
    supportedLanguages[language as keyof typeof supportedLanguages]
  const fileContext = useFileContext
    ? `${languageId?.syntaxComments?.start || ''}${context}${
        languageId?.syntaxComments?.end || ''
      }`
    : ''
  const heading = file ? file.toString() : ''

  return `<PRE>${fileContext} \n${heading}${prefix} <SUF> ${suffix} <MID>`
}

export const getDefaultFimPromptTemplate = ({
  file,
  context,
  useFileContext,
  prefixSuffix,
  language
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  const languageId =
    supportedLanguages[language as keyof typeof supportedLanguages]
  const fileContext = useFileContext
    ? `${languageId?.syntaxComments?.start}${context}${languageId?.syntaxComments?.end}`
    : ''
  const heading = file ? file.toString() : ''
  return `<PRE> ${fileContext}\n${heading}${prefix} <SUF> ${suffix} <MID>`
}

export const getFimPromptTemplateDeepseek = ({
  file,
  context,
  useFileContext,
  prefixSuffix,
  language
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  const languageId =
    supportedLanguages[language as keyof typeof supportedLanguages]
  const fileContext = useFileContext
    ? `${languageId?.syntaxComments?.start}${context}${languageId?.syntaxComments?.end}`
    : ''
  const heading = file ? file.toString() : ''
  return `<｜fim▁begin｜>${fileContext}\n${heading}${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`
}

export const getFimPromptTemplateStarcoder2 = ({
  file,
  context,
  useFileContext,
  prefixSuffix
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  const fileContext = useFileContext ? context : ''

  if (file) {
    return `<file_sep>${file.uri.toString()}\n<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`
  }
  else {
    return `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`
  }
}

export const getFimPromptTemplateStableCode = ({
  file,
  context,
  useFileContext,
  prefixSuffix
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  const fileContext = useFileContext ? context : ''
  const heading = file ? file.toString() : ''
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

  if (fimModel.includes(FIM_TEMPLATE_FORMAT.starcoder2)) {
    return getFimPromptTemplateStarcoder2(args)
  }

  if (
    fimModel.includes(FIM_TEMPLATE_FORMAT.stableCode) ||
    fimModel.includes(FIM_TEMPLATE_FORMAT.starcoder)
  ) {
    return getFimPromptTemplateStableCode(args)
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

  if (format === FIM_TEMPLATE_FORMAT.starcoder2) {
    return getFimPromptTemplateStarcoder2(args)
  }

  if (format === FIM_TEMPLATE_FORMAT.stableCode || format === FIM_TEMPLATE_FORMAT.starcoder) {
    return getFimPromptTemplateStableCode(args)
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

  if (fimModel.includes(FIM_TEMPLATE_FORMAT.starcoder2)) {
    return STOP_STARCODER2
  }

  if (
    fimModel.includes(FIM_TEMPLATE_FORMAT.stableCode) ||
    fimModel.includes(FIM_TEMPLATE_FORMAT.starcoder)
  ) {
    return ['<|endoftext|>']
  }

  return STOP_LLAMA
}

export const getStopWordsChosen = (format: string) => {
  if (format === FIM_TEMPLATE_FORMAT.codellama) return STOP_LLAMA
  if (format === FIM_TEMPLATE_FORMAT.deepseek) return STOP_DEEPSEEK
  if (format === FIM_TEMPLATE_FORMAT.starcoder2) return STOP_STARCODER2
  if (format === FIM_TEMPLATE_FORMAT.stableCode || format === FIM_TEMPLATE_FORMAT.starcoder) return STOP_STABLECODE
  return STOP_LLAMA
}

export const getStopWords = (fimModel: string, format: string) => {
  if (format === FIM_TEMPLATE_FORMAT.automatic) {
    return getStopWordsAuto(fimModel)
  }
  return getStopWordsChosen(format)
}
