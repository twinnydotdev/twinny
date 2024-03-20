export const defaultTemplates = [
  {
    name: 'explain',
    template: `{{{systemMessage}}}
Explain the following code;
{{{code}}}
Do not waffle on. The language is:
{{language}}
  `
  },
  {
    name: 'refactor',
    template: `{{{systemMessage}}}
Refactor the following code without altering its functionality:
{{{code}}}
Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
The language is: {{language}}.
Do not explain the code in your response.
  `
  },
  {
    name: 'add-types',
    template: `{{{systemMessage}}}
Add types to the following code, keep the code the same just add the types.
{{{code}}}
Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
The language is: {{language}}.
Do not explain the code in your response.
  `
  },
  {
    name: 'add-tests',
    template: `{{{systemMessage}}}
Write unit tests for the following code block:
{{{code}}}
Please use the most popular testing library suitable for the language of the code.
The language is: {{language}}.
Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
  `
  },
  {
    name: 'fix-code',
    template: `{{{systemMessage}}}
Fix the following code by adding or removing lines without altering its functionality:
{{{code}}}
Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
The language is: {{language}}.
Do not explain the code in your response.
  `
  },
  {
    name: 'generate-docs',
    template: `{{{systemMessage}}}
Generate documentation for the following code block:
{{{code}}}
Use the most popular documentation tool for the language {{{language}}}. If you don't know infer the tool.
Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
  `
  },
  {
    name: 'system',
    template: `You are a helpful, respectful and honest coding assistant.
Always reply with using markdown.
For code refactoring, use markdown with code formatting.
  `
  },
  {
    name: 'commit-message',
    template: `Only Generate short and concise commit messages.
      Do not explain your response.

      Answer in a markdown codeblock under 50 characters.

      Here is the unidiff: \`\`\`{{code}}\`\`\`

      \`\`\`
      <commit message goes here>
      \`\`\`
    `
  },
  {
    name: 'chat',
    template: `{{#if (eq messages.length 1)}}
{{{systemMessage}}}
{{/if}}
{{#each messages}}
  {{#if (eq this.role 'user')}}
[INST] {{{this.content}}}
    {{#if ../code}}
\`\`\`{{{../code}}}\`\`\`
    {{/if}} {{#if ../language}}
The language is {{../language}}
{{/if}}[/INST]
  {{else}}
{{{this.content}}}
  {{/if}}
{{/each}}
  `
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
