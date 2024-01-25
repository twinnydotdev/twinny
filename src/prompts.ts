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

    Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
  `

export const refactor = (code: string): string =>
  `
    ${getSystemMessage()}

    Refactor the following code without altering its functionality:

    \`\`\`
    ${code}
    \`\`\`

    Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
  `

export const addTests = (code: string): string =>
  `
    ${getSystemMessage()}
    Write unit tests for the following code block:
    \`\`\`${code}\`\`\`
    Please use the most popular testing library suitable for the language of the code.
    Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
  `

export const fixCode = (code: string): string =>
  `
    ${getSystemMessage()}
    Fix the following code by adding or removing lines without altering its functionality:
    \`\`\`${code}\`\`\`
    Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
  `

export const generateDocs = (code: string): string =>
  `
    ${getSystemMessage()}

    Generate documentation for the following code block:

    \`\`\`
    ${code}
    \`\`\`

    Use the most popular documentation tool for the inferred language, e.g., JSDoc for JavaScript.
    Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
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
