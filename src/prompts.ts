import { USER_NAME } from './constants'
import { Messages } from './types'

export const SYSTEM_MESSAGE = `<<SYS>>You are a helpful, respectful and honest coding assistant.
Always reply with using markdown.
For code refactoring, use markdown with code formatting.<</SYS>>`

export const explain = (code: string, language: string) =>
  `
    ${SYSTEM_MESSAGE}
    Explain the following code do not waffle on.
    The language is: ${language}
    \`\`\`
    ${code}
    \`\`\`
  `

export const addTypes = (code: string, language: string) =>
  `
    ${SYSTEM_MESSAGE}
    Add types to the following code, keep the code the same just add the types.
    \`\`\`
    ${code}
    \`\`\`.
    Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
    The language is: ${language}.
    Do not explain the code in your response.
  `

export const refactor = (code: string, language: string): string =>
  `
    ${SYSTEM_MESSAGE}
    Refactor the following code without altering its functionality:
    \`\`\`
    ${code}
    \`\`\`
    Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
    The language is: ${language}.
    Do not explain the code in your response.
  `

export const addTests = (code: string, language: string): string =>
  `
    ${SYSTEM_MESSAGE}
    Write unit tests for the following code block:
    \`\`\`${code}\`\`\`
    Please use the most popular testing library suitable for the language of the code.
    The language is: ${language}.
    Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
  `

export const fixCode = (code: string, language: string): string =>
  `
    ${SYSTEM_MESSAGE}
    Fix the following code by adding or removing lines without altering its functionality:
    \`\`\`${code}\`\`\`
    Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
    The language is: ${language}.
    Do not explain the code in your response.
  `

export const generateDocs = (code: string, language: string): string =>
  `
    ${SYSTEM_MESSAGE}
    Generate documentation for the following code block:
    \`\`\`
    ${code}
    \`\`\`
    Use the most popular documentation tool for the language ${language}. If you don't know infer the tool.
    Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
  `

export const chatMessage = (
  messages: Messages[],
  selection: string,
  language: string
) =>
  `
    ${messages.length === 1 ? SYSTEM_MESSAGE : ''}

    ${messages
      .map((message) =>
        message.role === USER_NAME
          ? `[INST] ${message.content} ${
              selection ? ` \`\`\`${selection}\`\`\` ` : ''
            } ${language ? `The language is ${language}` : ''}[/INST]`
          : `${message.content}`
      )
      .join('\n')}
  `
