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
    name: "commit-message",
    template: `
Write a git commit message for the following diff.
Use the imperative mood ("Add", "Fix", "Refactor"), keep the subject line under 72 characters,
and add a short body only when it explains something the subject cannot.
Reply with the commit message only: no code fences, no quotes, no explanation.

{{{code}}}`.trim()
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
You are a senior engineer reviewing a change titled "{{title}}".
{{#if part}}This is part {{part}} of a larger review; comment only on the files shown here.{{/if}}

Review the unified diff below and answer in markdown with these sections:

## Summary
Two or three sentences: what the change does and how sound it looks.

## Issues
The most important problems first, at most eight. For each, one bullet with a severity marker (🔴 bug, 🟠 risk, 🟡 nit), the file and approximate line from the hunk header, what is wrong, and a concrete fix. Omit this section if there are none.

## Suggestions
Optional improvements worth making, if any.

## Verdict
One line: ready to merge, merge after fixes, or needs rework.

Be specific and quote the relevant code. Do not restate the diff, do not ask for comments or documentation, and do not mention dependencies or other pull requests.

\`\`\`diff
{{{code}}}
\`\`\``.trim()
  },
  {
    name: "review-summary",
    template: `
Below are the parts of a code review of "{{title}}", each covering different files.
Combine them into one short overall assessment in markdown: the most important issues across all parts (at most five, most severe first, each naming its file), then one line on merge readiness.
Do not repeat the parts and do not add new findings.

{{{code}}}`.trim()
  },
  {
    name: "fim-system",
    template: ""
  }
]
