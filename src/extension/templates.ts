export const defaultTemplates = [
  {
    name: "explain",
    template: `
Explain the following code concisely:
{{{code}}}
Focus on key functionality and purpose. The language is:
{{language}}`.trim()
  },
  {
    name: "refactor",
    template: `
Refactor the following code to improve efficiency or readability without altering its functionality:
{{{code}}}
Always format responses with Markdown for code blocks with the language prefix e.g \`\`\`{{language}}.
The language is: {{language}}.
Do not explain the code in your response.`.trim()
  },
  {
    name: "add-types",
    template: `
Add types to the following code, keeping the logic unchanged:
{{{code}}}
Always format responses with Markdown for code blocks with the language prefix e.g \`\`\`{{language}}.
The language is: {{language}}.
Do not explain the code in your response.`.trim()
  },
  {
    name: "add-tests",
    template: `
Write comprehensive unit tests for the following code block:
{{{code}}}
Use the most popular testing library for {{language}}.
Always format responses with Markdown for code blocks with the language prefix e.g \`\`\`{{language}}.`.trim()
  },
  {
    name: "fix-code",
    template: `
Fix any errors in the following code without changing its core functionality:
{{{code}}}
Always format responses with Markdown for code blocks with the language prefix e.g \`\`\`{{language}}.
The language is: {{language}}.
Do not explain the changes in your response.`.trim()
  },
  {
    name: "generate-docs",
    template: `
Generate comprehensive documentation for the following code block:
{{{code}}}
Use the standard documentation format for {{language}}. If unsure, use a widely accepted format.
Always format responses with Markdown for code blocks with the language prefix e.g \`\`\`{{language}}.`.trim()
  },
  {
    name: "system",
    template: `You are a helpful, respectful and honest coding assistant.
Always reply using markdown.
Be clear and concise, prioritizing brevity in your responses.
For code refactoring, use markdown with appropriate code formatting.`.trim()
  },
  {
    name: "relevant-code",
    template: `
The following code snippet may be relevant to your query. Incorporate pertinent information in your response:

Limit your answer to three sentences.

{{{code}}}

Disregard if not relevant to the current query.`.trim()
  },
  {
    name: "relevant-files",
    template: `
These file paths may be relevant to your query:

{{{code}}}

Consider these in your response if pertinent. Disregard if not relevant.`.trim()
  },
  {
    name: "fim",
    template: "<PRE>{{{prefix}}} <SUF> {{{suffix}}} <MID>"
  },
  {
    name: "review",
    template: `
You are a highly skilled software engineer specializing in code reviews.
Your task is to review code changes in a unidiff format.
Ensure your feedback is constructive and professional.

Review the following diff:

\`\`\`
{{{code}}}
\`\`\`

Present it in markdown format, and refrain from mentioning:
- Adding comments or documentation
- Adding dependencies or related pull requests`.trim()
  },
  {
    name: "fim-system",
    template: ""
  }
]
