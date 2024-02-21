export const defaultTemplates = [
  {
    name: 'explain',
    template: `{{{systemMessage}}}
Explain the following code;

\`\`\`{{{code}}}\`\`\`

{{#if similarCode}}
Here is some helpful code from other files, use it as a context only but explain the original code.
{{{similarCode}}}
{{/if}}

Do not waffle on. The language is:
{{language}}
  `
  },
  {
    name: 'refactor',
    template: `{{{systemMessage}}}
Refactor the following code without altering its functionality:

\`\`\`{{{code}}}\`\`\`

{{#if similarCode}}
Here is some helpful code from other files, use it as a context only but explain the original code.
{{{similarCode}}}
{{/if}}

Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
The language is: {{language}}.
Do not explain the code in your response.
  `
  },
  {
    name: 'add-types',
    template: `{{{systemMessage}}}
Add types to the following code, keep the code the same just add the types.

\`\`\`{{{code}}}\`\`\`

{{#if similarCode}}
Here is some helpful code from other files, use it as a context only but explain the original code.
{{{similarCode}}}
{{/if}}

Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
The language is: {{language}}.
Do not explain the code in your response.
  `
  },
  {
    name: 'add-tests',
    template: `{{{systemMessage}}}
Write unit tests for the following code block:

\`\`\`{{{code}}}\`\`\`

{{#if similarCode}}
Here is some helpful code from other files, use it as a context only but explain the original code.
{{{similarCode}}}
{{/if}}

Please use the most popular testing library suitable for the language of the code.
The language is: {{language}}.
Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
  `
  },
  {
    name: 'fix-code',
    template: `{{{systemMessage}}}
Fix the following code by adding or removing lines without altering its functionality:

\`\`\`{{{code}}}\`\`\`

{{#if similarCode}}
Here is some helpful code from other files, use it as a context only but explain the original code.
{{{similarCode}}}
{{/if}}

Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
The language is: {{language}}.
Do not explain the code in your response.
  `
  },
  {
    name: 'generate-docs',
    template: `{{{systemMessage}}}
Generate documentation for the following code block:
\`\`\`{{{code}}}\`\`\`

{{#if similarCode}}
Here is some helpful code from other files, use it as a context only but explain the original code.
{{{similarCode}}}
{{/if}}

Use the most popular documentation tool for the language {{{language}}}. If you don't know infer the tool.
Always format responses with Markdown for code blocks with the language prefix e.g language-prefix.
  `
  },
  {
    name: 'system',
    template: `<<SYS>>You are a helpful, respectful and honest coding assistant.
Always reply with using markdown.
For code refactoring, use markdown with code formatting.<</SYS>>
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
{{/if}}

{{#if ../similarCode}}
Here is some helpful code from other files, use it as a context only but explain the original code.
\`\`\`{{{../similarCode}}}\`\`\`
{{/if}}

{{#if ../language}}
The language is {{../language}}
{{/if}}[/INST]
  {{else}}
{{{this.content}}}
  {{/if}}
{{/each}}
  `
  },
  {
    name: 'rerank',
    template: `You an an expert at deciding if two code snippets are relevant to eachother.
Do not be affraid to say no if you are unsure. Only say yes if you are 100% sure that the code snippet is relevant to the query.

Code snippet 1:
{{{query}}}

Code Snippet 2:
\`\`\`{{{code}}}\`\`\`

Are these two code snippets relevant to each other?

  `
  }
]
