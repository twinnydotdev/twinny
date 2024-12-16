import { JSONSchema7 } from "json-schema"

import { FunctionTool } from "./types"

export const tools: FunctionTool[] = [
  {
    type: "function",
    function: {
      name: "openFile",
      description: "Open a file in the editor",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file relative to workspace root"
          },
          preview: {
            type: "boolean",
            description: "Open in preview mode"
          },
          viewColumn: {
            type: "string",
            enum: ["beside", "active", "new"],
            description: "Where to open the file"
          },
          encoding: {
            type: "string",
            description: "File encoding (e.g. 'utf-8')"
          },
          revealIfOpen: {
            type: "boolean",
            description: "If true, reveal the tab if the file is already open"
          }
        },
        required: ["path"]
      } satisfies JSONSchema7
    }
  },

  {
    type: "function",
    function: {
      name: "editFile",
      description: "Edit a file",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file relative to workspace root"
          },
          edit: {
            type: "string",
            description: "Text edit to apply"
          },
          createIfNotExists: {
            type: "boolean",
            description: "Create file if it doesn't exist"
          },
          backupBeforeEdit: {
            type: "boolean",
            description: "Create a backup copy before editing"
          }
        },
        required: ["path", "edit"]
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
          },
          createIntermediateDirs: {
            type: "boolean",
            description: "Create intermediate directories if they don't exist"
          },
          fileTemplate: {
            type: "string",
            description: "Template to use for file content"
          },
          permissions: {
            type: "string",
            description: "File permissions (e.g. '0644')"
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
          },
          env: {
            type: "object",
            description: "Additional environment variables"
          },
          shell: {
            type: "string",
            description: "Specific shell to use"
          },
          timeout: {
            type: "number",
            description: "Command timeout in milliseconds"
          },
          captureOutput: {
            type: "boolean",
            description: "If true, capture command output and return it"
          },
          runInBackground: {
            type: "boolean",
            description:
              "If true, run the command in background without blocking"
          }
        },
        required: ["command"]
      } satisfies JSONSchema7
    }
  }
]
