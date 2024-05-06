export const defaultTemplates = [
  {
    name: 'explain',
    template: `
Explain the following code;
{{{code}}}
Do not waffle on. The language is:
{{language}}
  `.trim()
  },
  {
    name: 'refactor',
    template: `
Refactor the following code without altering its functionality:
{{{code}}}
Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
The language is: {{language}}.
Do not explain the code in your response.
  `.trim()
  },
  {
    name: 'add-types',
    template: `
Add types to the following code, keep the code the same just add the types.
{{{code}}}
Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
The language is: {{language}}.
Do not explain the code in your response.
  `.trim()
  },
  {
    name: 'add-tests',
    template: `
Write unit tests for the following code block:
{{{code}}}
Please use the most popular testing library suitable for the language of the code.
The language is: {{language}}.
Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
  `.trim()
  },
  {
    name: 'fix-code',
    template: `
Fix the following code by adding or removing lines without altering its functionality:
{{{code}}}
Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
The language is: {{language}}.
Do not explain the code in your response.
  `.trim()
  },
  {
    name: 'generate-docs',
    template: `
Generate documentation for the following code block:
{{{code}}}
Use the most popular documentation tool for the language {{{language}}}. If you don't know infer the tool.
Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
  `.trim()
  },
  {
    name: 'system',
    template: `You are a helpful, respectful and honest coding assistant.
Always reply with using markdown.
For code refactoring, use markdown with code formatting.
  `.trim()
  },
  {
    name: 'commit-message',
    template: `You are an agent who generates concise git commit messages.
Only reply with one line of text.

- Answer under 100 characters.

E.g "Added a new feature"

Here is the unidiff: \`\`\`{{code}}\`\`\`

<commit message goes here>
    `.trim()
  },
  {
    name: 'fim',
    template: '<PRE>{{{prefix}}} <SUF> {{{suffix}}} <MID>'
  },
  {
    name: 'fim-system',
    template: ''
  }
]
