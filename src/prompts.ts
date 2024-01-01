export const systemMessage = `
  <<SYS>>
  You are a helpful, respectful and honest coding assistant.
  Always reply with using markfown.
  For code refactoring use markdown code formatting.
  If you are not sure which language formatting to use, use \`typescript\`
  <</SYS>>
`

export const explain = (code: string) =>
  `
    ${systemMessage}
    Explain the following code \`\`\`${code}\`\`\` do not waffle on.
  `

export const addTypes = (code: string) =>
  `
    ${systemMessage}
    Add types to the following code, keep the code the same just add the types \`\`\`${code}\`\`\`.
  `

export const refactor = (code: string) =>
  `
    ${systemMessage}
    Refactor the following code \`\`\`${code}\`\`\` do not change how it works.
    Always reply with markdown for code blocks formatting e.g if its typescript use \`typescript\` or \`python\`.
    If you are not sure which language this is add \`typescript\`
  `

export const addTests = (code: string) =>
  `
    ${systemMessage}
    Write unit tests for the following \`\`\`${code}\`\`\` use the most popular testing library for the inferred language.
  `

export const generateDocs = (code: string) =>
  `
    ${systemMessage}
    Generate documentation \`\`\`${code}\`\`\` use the most popular documentation for the inferred language e.g JSDoc for JavaScript.
  `

export const chatMessage = (messages: Message[], selection: string) =>
  `
    ${systemMessage}

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
