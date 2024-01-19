const systemMesage = `You are a helpful, respectful and honest coding assistant.
Always reply with using markdown.
For code refactoring, use markdown with code formatting.
`

export const getSystemMessage = (modelType: string) => {
  return modelType.includes('deepseek')
    ? systemMesage
    : `<<SYS>>${systemMesage}<</SYS>>`
}

export const explain = (code: string, modelType: string) =>
  `
    ${getSystemMessage(modelType)}
    Explain the following code \`\`\`${code}\`\`\` do not waffle on.
  `

export const addTypes = (code: string, modelType: string) =>
  `
    ${getSystemMessage(modelType)}
    Add types to the following code, keep the code the same just add the types \`\`\`${code}\`\`\`.
  `

export const refactor = (code: string, modelType: string): string =>
  `
    ${getSystemMessage(modelType)}
    Refactor the following code without altering its functionality:
    \`\`\`${code}\`\`\`
    Always format responses with Markdown for code blocks. For instance, use \`typescript\` or \`python\` for code formatting.
    If the language of the code is uncertain, default to using \`typescript\`.
  `

export const addTests = (code: string, modelType: string): string =>
  `
    ${getSystemMessage(modelType)}
    Write unit tests for the following code block:
    \`\`\`${code}\`\`\`
    Please use the most popular testing library suitable for the language of the code.
  `

export const generateDocs = (code: string, modelType: string): string =>
  `
    ${getSystemMessage(modelType)}
    Generate documentation for the following code block:
    \`\`\`${code}\`\`\`
    Use the most popular documentation tool for the inferred language, e.g., JSDoc for JavaScript.
  `

export const chatMessageLlama = (
  messages: Message[],
  selection: string,
  modelType: string
) =>
  `
    ${messages.length === 1 ? getSystemMessage(modelType) : ''}

    ${messages
      .map((message) =>
        message.role === 'user'
          ? `[INST] ${message.content} ${
              selection ? ` \`\`\`${selection}\`\`\` ` : ''
            } [/INST]`
          : `${message.content}`
      )
      .join('\n')}
  `

export const chatMessageDeepSeek = (
  messages: Message[],
  selection: string,
  modelType: string
) =>
  `
    ${messages.length === 1 ? getSystemMessage(modelType) : ''}

    ${messages
      .map((message) =>
        message.role === 'user'
          ? `### Instruction:
          ${message.content} ${selection ? ` \`\`\`${selection}\`\`\` ` : ''}`
          : `
            ### Response:
            ${message.content}
            <|EOT|>
          `
      )
      .join('\n')}
  `

