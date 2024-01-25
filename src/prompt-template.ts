interface PrompTemplate {
  context: string
  header: string
  suffix: string
  prefix: string
  useFileContext: boolean
}

export const getFimPromptTemplate = ({
  context,
  header,
  useFileContext,
  suffix,
  prefix
}: PrompTemplate) => {
  const fileContext = useFileContext ? context : ''
  const heading = header ? header : ''
  return {
    prompt: `<PRE> ${fileContext}\n${heading}${prefix} <SUF>${suffix} <MID>`,
    prefix,
    suffix
  }
}
