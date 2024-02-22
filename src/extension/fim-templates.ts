import { FIM_TEMPLATE_FORMAT } from '../constants'
import { FimPromptTemplate } from './types'

export const getFimPromptTemplateLLama = ({
  context,
  header,
  useFileContext,
  prefixSuffix,
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  const fileContext = useFileContext ? context : ''
  const heading = header ? header : ''
  return {
    prompt: `<PRE>/* ${fileContext} */ \n  ${heading}${prefix} <SUF> ${suffix} <MID>`,
    prefix,
    suffix,
    stopWords: ['<EOT>']
  }
}

export const getDefaultFimPromptTemplate = ({
  context,
  header,
  useFileContext,
  prefixSuffix,
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  const fileContext = useFileContext ? context : ''
  const heading = header ? header : ''
  return {
    prompt: `<PRE> ${fileContext}\n${heading}${prefix} <SUF> ${suffix} <MID>`,
    prefix,
    suffix,
    stopWords: ['<EOT>']
  }
}

export const getFimPromptTemplateDeepseek = ({
  context,
  header,
  useFileContext,
  prefixSuffix,
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  const fileContext = useFileContext ? context : ''
  const heading = header ? header : ''
  return {
    prompt: `<｜fim▁begin｜>${fileContext}\n${heading}${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`,
    prefix,
    suffix,
    stopWords: [
      '<｜fim▁begin｜>',
      '<｜fim▁hole｜>',
      '<｜fim▁end｜>',
      '<END>',
      '<｜end▁of▁sentence｜>'
    ]
  }
}

export const getFimPromptTemplateStableCode = ({
  context,
  header,
  useFileContext,
  prefixSuffix,
}: FimPromptTemplate) => {
  const { prefix, suffix } = prefixSuffix
  const fileContext = useFileContext ? context : ''
  const heading = header ? header : ''
  return {
    prompt: `<fim_prefix>${fileContext}\n${heading}${prefix}<fim_suffix>${suffix}<fim_middle>`,
    prefix,
    suffix,
    stopWords: ['<|endoftext|>']
  }
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

  if (fimModel.includes(FIM_TEMPLATE_FORMAT.stableCode)) {
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

  if (format === FIM_TEMPLATE_FORMAT.stableCode) {
    return getFimPromptTemplateStableCode(args)
  }

  return getDefaultFimPromptTemplate(args)
}

export const getFimTemplate = (
  fimModel: string,
  format: string,
  args: FimPromptTemplate
) => {
  if (format === FIM_TEMPLATE_FORMAT.automatic) {
    return getFimTemplateAuto(fimModel, args)
  }
  return getFimTemplateChosen(fimModel, args)
}
