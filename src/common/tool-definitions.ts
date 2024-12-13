import { JSONSchema7 } from "json-schema"

import { FunctionTool } from "./types"

export const tools: FunctionTool[] = [
  {
    type: "function",
    function: {
      name: "getFileTree",
      description:
        "Get the file tree of the current workspace, respecting .gitignore",
      parameters: {
        type: "object",
        properties: {
          excludePatterns: {
            type: "array",
            items: { type: "string" },
            description: "Additional patterns to exclude"
          }
        },
        required: []
      } satisfies JSONSchema7
    }
  },
  {
    type: "function",
    function: {
      name: "createFile",
      description: "Create a new file in the workspace",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path from workspace root"
          },
          content: {
            type: "string",
            description: "Content to write to file"
          },
          openAfterCreate: {
            type: "boolean",
            description: "Whether to open the file after creation"
          }
        },
        required: ["path", "content"]
      } satisfies JSONSchema7
    }
  },
  {
    type: "function",
    function: {
      name: "runCommand",
      description: "Run a shell command in the integrated terminal",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Command to execute"
          },
          cwd: {
            type: "string",
            description: "Working directory relative to workspace root"
          }
        },
        required: ["command"]
      } satisfies JSONSchema7
    }
  },

  {
    type: "function",
    function: {
      name: "renameFile",
      description: "Rename a file or directory",
      parameters: {
        type: "object",
        properties: {
          oldPath: {
            type: "string",
            description: "Current path relative to workspace root"
          },
          newPath: {
            type: "string",
            description: "New path relative to workspace root"
          }
        },
        required: ["oldPath", "newPath"]
      } satisfies JSONSchema7
    }
  }
]
