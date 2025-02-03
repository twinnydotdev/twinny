export type AssistantMessageContent = TextContent | ToolUse

export interface TextContent {
  type: "text"
  content: string
  partial: boolean
}

export const toolUseNames = [
  "execute_command",
  "read_file",
  "write_to_file",
  "replace_in_file",
  "search_files",
  "list_files",
  "list_code_definition_names",
  "browser_action",
  "ask_followup_question",
  "plan_mode_response",
  "attempt_completion"
] as const

// Converts array of tool call names into a union type ("execute_command" | "read_file" | ...)
export type ToolUseName = (typeof toolUseNames)[number]

export const toolParamNames = [
  "command",
  "requires_approval",
  "path",
  "content",
  "diff",
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

export type ToolParamName = (typeof toolParamNames)[number]

export interface ToolUse {
  type: "tool_use"
  id: string
  name: ToolUseName
  // params is a partial record, allowing only some or none of the possible parameters to be used
  params: Partial<Record<ToolParamName, string>>
  partial: boolean
}

let toolUseCounter = 0;

function generateUniqueId(): string {
  return `tool_${Date.now()}_${toolUseCounter++}`;
}

export interface ExecuteCommandToolUse extends ToolUse {
  name: "execute_command"
  // Pick<Record<ToolParamName, string>, "command"> makes "command" required, but Partial<> makes it optional
  params: Partial<
    Pick<Record<ToolParamName, string>, "command" | "requires_approval">
  >
}

export interface ReadFileToolUse extends ToolUse {
  name: "read_file"
  params: Partial<Pick<Record<ToolParamName, string>, "path">>
}

export interface WriteToFileToolUse extends ToolUse {
  name: "write_to_file"
  params: Partial<Pick<Record<ToolParamName, string>, "path" | "content">>
}

export interface ReplaceInFileToolUse extends ToolUse {
  name: "replace_in_file"
  params: Partial<Pick<Record<ToolParamName, string>, "path" | "diff">>
}

export interface SearchFilesToolUse extends ToolUse {
  name: "search_files"
  params: Partial<
    Pick<Record<ToolParamName, string>, "path" | "regex" | "file_pattern">
  >
}

export interface ListFilesToolUse extends ToolUse {
  name: "list_files"
  params: Partial<Pick<Record<ToolParamName, string>, "path" | "recursive">>
}

export interface ListCodeDefinitionNamesToolUse extends ToolUse {
  name: "list_code_definition_names"
  params: Partial<Pick<Record<ToolParamName, string>, "path">>
}

export interface BrowserActionToolUse extends ToolUse {
  name: "browser_action"
  params: Partial<
    Pick<
      Record<ToolParamName, string>,
      "action" | "url" | "coordinate" | "text"
    >
  >
}

export interface AskFollowupQuestionToolUse extends ToolUse {
  name: "ask_followup_question"
  params: Partial<Pick<Record<ToolParamName, string>, "question">>
}

export interface AttemptCompletionToolUse extends ToolUse {
  name: "attempt_completion"
  params: Partial<Pick<Record<ToolParamName, string>, "result" | "command">>
}

export function parseAssistantMessage(assistantMessage: string) {
  const contentBlocks: AssistantMessageContent[] = []
  let currentTextContent: TextContent | undefined = undefined
  let currentTextContentStartIndex = 0
  let currentToolUse: ToolUse | undefined = undefined
  let currentToolUseStartIndex = 0
  let currentParamName: ToolParamName | undefined = undefined
  let currentParamValueStartIndex = 0
  let accumulator = ""

  for (let i = 0; i < assistantMessage.length; i++) {
    const char = assistantMessage[i]
    accumulator += char

    // there should not be a param without a tool use
    if (currentToolUse && currentParamName) {
      const currentParamValue = accumulator.slice(currentParamValueStartIndex)
      const paramClosingTag = `</${currentParamName}>`
      if (currentParamValue.endsWith(paramClosingTag)) {
        // end of param value
        currentToolUse.params[currentParamName] = currentParamValue
          .slice(0, -paramClosingTag.length)
          .trim()
        currentParamName = undefined
        continue
      } else {
        // partial param value is accumulating
        continue
      }
    }

    // no currentParamName

    if (currentToolUse) {
      const currentToolValue = accumulator.slice(currentToolUseStartIndex)
      const toolUseClosingTag = `</${currentToolUse.name}>`
      if (currentToolValue.endsWith(toolUseClosingTag)) {
        // end of a tool use
        currentToolUse.partial = false
        contentBlocks.push(currentToolUse)
        currentToolUse = undefined
        continue
      } else {
        const possibleParamOpeningTags = toolParamNames.map(
          (name) => `<${name}>`
        )
        for (const paramOpeningTag of possibleParamOpeningTags) {
          if (accumulator.endsWith(paramOpeningTag)) {
            // start of a new parameter
            currentParamName = paramOpeningTag.slice(1, -1) as ToolParamName
            currentParamValueStartIndex = accumulator.length
            break
          }
        }

        // there's no current param, and not starting a new param

        // special case for write_to_file where file contents could contain the closing tag, in which case the param would have closed and we end up with the rest of the file contents here. To work around this, we get the string between the starting content tag and the LAST content tag.
        const contentParamName: ToolParamName = "content"
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

        // partial tool value is accumulating
        continue
      }
    }

    // no currentToolUse

    let didStartToolUse = false
    const possibleToolUseOpeningTags = toolUseNames.map((name) => `<${name}>`)
    for (const toolUseOpeningTag of possibleToolUseOpeningTags) {
      if (accumulator.endsWith(toolUseOpeningTag)) {
        // start of a new tool use
        currentToolUse = {
          type: "tool_use",
          name: toolUseOpeningTag.slice(1, -1) as ToolUseName,
          params: {},
          id: generateUniqueId(),
          partial: true
        }
        currentToolUseStartIndex = accumulator.length
        // this also indicates the end of the current text content
        if (currentTextContent) {
          currentTextContent.partial = false
          // remove the partially accumulated tool use tag from the end of text (<tool)
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
      // no tool use, so it must be text either at the beginning or between tools
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
    // stream did not complete tool call, add it as partial
    if (currentParamName) {
      // tool call has a parameter that was not completed
      currentToolUse.params[currentParamName] = accumulator
        .slice(currentParamValueStartIndex)
        .trim()
    }
    contentBlocks.push(currentToolUse)
  }

  // Note: it doesnt matter if check for currentToolUse or currentTextContent, only one of them will be defined since only one can be partial at a time
  if (currentTextContent) {
    // stream did not complete text content, add it as partial
    contentBlocks.push(currentTextContent)
  }

  return contentBlocks
}
