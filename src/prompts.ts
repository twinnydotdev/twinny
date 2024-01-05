const systemMesage = `You are a helpful, respectful and honest coding assistant.
Always reply with using markfown.
For code refactoring use markdown code formatting.
If you are not sure which language formatting to use, use \`typescript\`
`

export const getSystemMessage = (modelType: string) => {
  return modelType.includes('deepseek')
    ? systemMesage
    : `<<SYS>>
    ${systemMesage}
    <</SYS>>`
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

export const refactor = (code: string, modelType: string) =>
  `
    ${getSystemMessage(modelType)}
    Refactor the following code \`\`\`${code}\`\`\` do not change how it works.
    Always reply with markdown for code blocks formatting e.g if its typescript use \`typescript\` or \`python\`.
    If you are not sure which language this is add \`typescript\`
  `

export const addTests = (code: string, modelType: string) =>
  `
    ${getSystemMessage(modelType)}
    Write unit tests for the following \`\`\`${code}\`\`\` use the most popular testing library for the inferred language.
  `

export const generateDocs = (code: string, modelType: string) =>
  `
    ${getSystemMessage(modelType)}
    Generate documentation \`\`\`${code}\`\`\` use the most popular documentation for the inferred language e.g JSDoc for JavaScript.
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
interface Prompts {
  [key: string]: (code: string, modelType: string) => string
}

export const codeActionTypes = ['add-types', 'refactor']

export const prompts: Prompts = {
  explain: explain,
  'add-types': addTypes,
  refactor: refactor,
  'add-tests': addTests,
  'generate-docs': generateDocs
}
