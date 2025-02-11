export type AssistantMessageContent = TextContent | ToolUse

export interface TextContent {
  type: "text"
  content: string
  partial: boolean
}

export const toolNames = [
  "execute_command",
  "read_file",
  "write_to_file",
  "apply_diff",
  "view_diff",
  "search_files",
  "list_files",
  "list_code_definition_names",
  "ask_followup_question",
  "plan_mode_response",
  "attempt_completion"
] as const

export const toolResponseNames = [
  "ask_followup_question_result",
  "attempt_completion_result",
  "list_code_definition_names_result",
  "list_files_result",
  "plan_mode_response_result",
  "read_file_result",
  "apply_diff_result",
  "search_files_result",
  "write_to_file_result",
]

const allToolNames = [
  ...toolNames,
  ...toolResponseNames,
]

export type ToolName = (typeof allToolNames)[number]

export const parameterNames = [
  "command",
  "requires_approval",
  "path",
  "content",
  "diff",
  "start_line",
  "end_line",
  "regex",
  "file_pattern",
  "recursive",
  "action",
  "url",
  "coordinate",
  "text",
  "server_name",
  "tool_name",
  "arguments",
  "uri",
  "question",
  "response",
  "result"
] as const

export type ParamName = (typeof parameterNames)[number]

export interface ToolUse {
  type: "tool_use"
  name: ToolName
  params: Partial<Record<ParamName, string>>
  partial: boolean
}

export interface ExecuteCommandToolUse extends ToolUse {
  name: "execute_command"
  params: Partial<
    Pick<Record<ParamName, string>, "command" | "requires_approval">
  >
}

export interface ReadFileToolUse extends ToolUse {
  name: "read_file"
  params: Partial<Pick<Record<ParamName, string>, "path">>
}

export interface WriteToFileToolUse extends ToolUse {
  name: "write_to_file"
  params: Partial<Pick<Record<ParamName, string>, "path" | "content">>
}

export interface ApplyDiffTool extends ToolUse {
  name: "apply_diff"
  params: Partial<
    Pick<
      Record<ParamName, string>,
      "path" | "diff" | "start_line" | "end_line"
    >
  >
}

export interface SearchFilesToolUse extends ToolUse {
  name: "search_files"
  params: Partial<
    Pick<Record<ParamName, string>, "path" | "regex" | "file_pattern">
  >
}

export interface ListFilesToolUse extends ToolUse {
  name: "list_files"
  params: Partial<Pick<Record<ParamName, string>, "path" | "recursive">>
}

export interface ListCodeDefinitionNamesToolUse extends ToolUse {
  name: "list_code_definition_names"
  params: Partial<Pick<Record<ParamName, string>, "path">>
}

export interface AskFollowupQuestionToolUse extends ToolUse {
  name: "ask_followup_question"
  params: Partial<Pick<Record<ParamName, string>, "question">>
}

export interface AttemptCompletionToolUse extends ToolUse {
  name: "attempt_completion"
  params: Partial<Pick<Record<ParamName, string>, "result" | "command">>
}

function replaceHtmlEntities(text: string) {
  // Create a map of HTML entities to their corresponding characters
  const entityMap = {
    "&lt;": "<",
    "&gt;": ">",
    "&amp;": "&",
    "&quot;": "\"",
    "&#39;": "'",
    "&nbsp;": " "
  };

  // Replace all entities with their corresponding characters
  let decodedText = text;
  Object.entries(entityMap).forEach(([entity, char]) => {
    const regex = new RegExp(entity, "g");
    decodedText = decodedText.replace(regex, char);
  });

  return decodedText;
}

export function toolParser(message: string) {
  const assistantMessage = replaceHtmlEntities(message)
  const contentBlocks: AssistantMessageContent[] = []
  let currentTextContent: TextContent | undefined = undefined
  let currentTextContentStartIndex = 0
  let currentToolUse: ToolUse | undefined = undefined
  let currentToolUseStartIndex = 0
  let currentParamName: ParamName | undefined = undefined
  let currentParamValueStartIndex = 0
  let accumulator = ""

  for (let i = 0; i < assistantMessage.length; i++) {
    const char = assistantMessage[i]
    accumulator += char

    if (currentToolUse && currentParamName) {
      const currentParamValue = accumulator.slice(currentParamValueStartIndex)
      const paramClosingTag = `</${currentParamName}>`
      if (currentParamValue.endsWith(paramClosingTag)) {
        currentToolUse.params[currentParamName] = currentParamValue
          .slice(0, -paramClosingTag.length)
          .trim()
        currentParamName = undefined
        continue
      } else {
        continue
      }
    }

    if (currentToolUse) {
      const currentToolValue = accumulator.slice(currentToolUseStartIndex)
      const toolUseClosingTag = `</${currentToolUse.name}>`
      if (currentToolValue.endsWith(toolUseClosingTag)) {
        currentToolUse.partial = false
        contentBlocks.push(currentToolUse)
        currentToolUse = undefined
        continue
      } else {
        const possibleParamOpeningTags = parameterNames.map(
          (name) => `<${name}>`
        )
        for (const paramOpeningTag of possibleParamOpeningTags) {
          if (accumulator.endsWith(paramOpeningTag)) {
            currentParamName = paramOpeningTag.slice(1, -1) as ParamName
            currentParamValueStartIndex = accumulator.length
            break
          }
        }

        const contentParamName: ParamName = "content"
        if (
          currentToolUse.name === "write_to_file" &&
          accumulator.endsWith(`</${contentParamName}>`)
        ) {
          const toolContent = accumulator.slice(currentToolUseStartIndex)
          const contentStartTag = `<${contentParamName}>`
          const contentEndTag = `</${contentParamName}>`
          const contentStartIndex =
            toolContent.indexOf(contentStartTag) + contentStartTag.length
          const contentEndIndex = toolContent.lastIndexOf(contentEndTag)
          if (
            contentStartIndex !== -1 &&
            contentEndIndex !== -1 &&
            contentEndIndex > contentStartIndex
          ) {
            currentToolUse.params[contentParamName] = toolContent
              .slice(contentStartIndex, contentEndIndex)
              .trim()
          }
        }

        continue
      }
    }

    let didStartToolUse = false
    const possibleToolUseOpeningTags = allToolNames.map((name) => `<${name}>`)
    for (const toolUseOpeningTag of possibleToolUseOpeningTags) {
      if (accumulator.endsWith(toolUseOpeningTag)) {
        currentToolUse = {
          type: "tool_use",
          name: toolUseOpeningTag.slice(1, -1) as ToolName,
          params: {},
          partial: true
        }
        console.log("started tool use", currentToolUse)
        currentToolUseStartIndex = accumulator.length
        if (currentTextContent) {
          currentTextContent.partial = false
          currentTextContent.content = currentTextContent.content
            .slice(0, -toolUseOpeningTag.slice(0, -1).length)
            .trim()
          contentBlocks.push(currentTextContent)
          currentTextContent = undefined
        }

        didStartToolUse = true
        break
      }
    }

    if (!didStartToolUse) {
      if (currentTextContent === undefined) {
        currentTextContentStartIndex = i
      }
      currentTextContent = {
        type: "text",
        content: accumulator.slice(currentTextContentStartIndex).trim(),
        partial: true
      }
    }
  }

  if (currentToolUse) {
    if (currentParamName) {
      currentToolUse.params[currentParamName] = accumulator
        .slice(currentParamValueStartIndex)
        .trim()
    }
    contentBlocks.push(currentToolUse)
  }

  if (currentTextContent) {
    contentBlocks.push(currentTextContent)
  }

  return contentBlocks
}
