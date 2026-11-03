import { createHash } from "crypto"
import os from "os"
import path from "path"
import type { Uri, WorkspaceFolder } from "vscode"

/**
 * A display name cannot identify an index: unrelated folders can share it.
 * Include URI schemes and authorities, the workspace file, and every root.
 * Root ordering is cosmetic; a changed membership needs a different index.
 */
export const workspaceIndexPath = (
  storageUri: Uri | undefined,
  workspaceFile: Uri | undefined,
  folders: readonly WorkspaceFolder[] | undefined
): string | undefined => {
  if (!folders?.length) return undefined
  const identity = JSON.stringify({
    workspace: workspaceFile?.toString() ?? null,
    roots: [...new Set(folders.map((folder) => folder.uri.toString()))].sort()
  })
  const key = createHash("sha256").update(identity).digest("hex")
  const base = storageUri?.scheme === "file"
    ? path.join(storageUri.fsPath, "embeddings")
    : path.join(os.homedir(), ".twinny", "embeddings", "workspaces")
  // Never open a legacy name-based directory: its ownership is ambiguous.
  return path.join(base, key)
}
