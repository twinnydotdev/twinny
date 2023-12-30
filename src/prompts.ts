export function explain(code: string) {
  return `
    Explain the following code ${code} do not waffle on.
  `
}

export function refactor(code: string) {
  return `
    Refactor the following code \`${code}\` do not change how it works.
    Always reply with markdown for code blocks formatting e.g if its typescript use \`typescript\` or \`python\`.
    If you are not sure which language this is add \`typescript\`
  `
}

export function chatMessage(message: string, code?: string) {
  if (code) {
    return `
        ${message}

        ${code}

        Always reply with markdown for code blocks formatting e.g if its typescript use \`typescript\` or \`python\`.
        If you are not sure which language this is add \`typescript\`
    `
  }

  return message
}
