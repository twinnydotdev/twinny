import { PromptTemplate } from './types'

export const getFimPromptTemplateLLama = ({
  context,
  header,
  useFileContext,
  suffix,
  prefix
}: PromptTemplate) => {
  const fileContext = useFileContext ? context : ''
  const heading = header ? header : ''
  return {
    prompt: `<PRE> ${fileContext}\n${heading}${prefix} <SUF> ${suffix} <MID>`,
    prefix,
    suffix,
    stop: ['<EOT>']
  }
}

export const getFimPromptTemplateDeepseek = ({
  context,
  header,
  useFileContext,
  suffix,
  prefix
}: PromptTemplate) => {
  const fileContext = useFileContext ? context : ''
  const heading = header ? header : ''
  return {
    prompt: `<｜fim▁begin｜>${fileContext}\n${heading}${prefix} <｜fim▁hole｜> ${suffix}<｜fim▁end｜>`,
    prefix,
    suffix,
    stop: ['<｜fim▁begin｜>', '<｜fim▁hole｜>', '<｜fim▁end｜>', '<END>', '<｜end▁of▁sentence｜>']
  }
}

export const getFimPromptTemplateStableCode = ({
  context,
  header,
  useFileContext,
  suffix,
  prefix
}: PromptTemplate) => {
  const fileContext = useFileContext ? context : ''
  const heading = header ? header : ''
  return {
    prompt: `<fim_prefix>${fileContext}\n${heading}${prefix}<fim_suffix>${suffix}<fim_middle>`,
    prefix,
    suffix,
    stop: ['<|endoftext|>']
  }
}
