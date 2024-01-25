export const getSystemMessage =
  () => `<<SYS>>You are a helpful, respectful and honest coding assistant.
Always reply with using markdown.
For code refactoring, use markdown with code formatting.<</SYS>>`

export const explain = (code: string) =>
  `
    ${getSystemMessage()}

    Explain the following code do not waffle on.

    \`\`\`
    ${code}
    \`\`\`
  `

export const addTypes = (code: string) =>
  `
    ${getSystemMessage()}

    Add types to the following code, keep the code the same just add the types.

    \`\`\`
    ${code}
    \`\`\`.
  `

export const refactor = (code: string): string =>
  `
    ${getSystemMessage()}

    Refactor the following code without altering its functionality:

    \`\`\`
    ${code}
    \`\`\`

    Always format responses with Markdown for code blocks. For instance, use \`typescript\` or \`python\` for code formatting.
    If the language of the code is uncertain, default to using \`typescript\`.
  `

export const addTests = (code: string): string =>
  `
    ${getSystemMessage()}
    [INST]Write unit tests for the following code block:
    \`\`\`${code}\`\`\`
    Please use the most popular testing library suitable for the language of the code.[/INST]
  `

export const generateDocs = (code: string): string =>
  `
    ${getSystemMessage()}

    Generate documentation for the following code block:

    \`\`\`
    ${code}
    \`\`\`

    Use the most popular documentation tool for the inferred language, e.g., JSDoc for JavaScript.
  `

export const chatMessage = (messages: Message[], selection: string) =>
  `
    ${messages.length === 1 ? getSystemMessage() : ''}

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
