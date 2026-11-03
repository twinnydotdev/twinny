import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { EmbeddingDatabase } from "../../extension/embeddings/database"
import { Embedder } from "../../extension/embeddings/embedder"
import { Reranker } from "../../extension/embeddings/reranker"
import { WorkspaceSearch } from "../../extension/embeddings/search"
import { workspaceIndexPath } from "../../extension/embeddings/storage"

const folders = (...uris: vscode.Uri[]): vscode.WorkspaceFolder[] =>
  uris.map((uri, index) => ({ uri, index, name: path.basename(uri.path) }))

suite("Embeddings: workspace storage", () => {
  test("same basenames and sanitized display names do not share an index", () => {
    const index = (root: string) => workspaceIndexPath(undefined, undefined, folders(vscode.Uri.file(root)))
    assert.notStrictEqual(index("/project-a/api"), index("/project-b/api"))
    assert.notStrictEqual(index("/projects/a b"), index("/projects/a_b"))
    assert.strictEqual(index("/project-a/api"), index("/project-a/api"))
  })

  test("uses file-backed workspace storage and separates root membership", () => {
    const storage = vscode.Uri.file(path.join(os.tmpdir(), "workspace-storage"))
    const a = vscode.Uri.file("/projects/a")
    const b = vscode.Uri.file("/projects/b")
    const index = workspaceIndexPath(storage, undefined, folders(a))!
    assert.strictEqual(path.dirname(index), path.join(storage.fsPath, "embeddings"))
    assert.notStrictEqual(index, workspaceIndexPath(storage, undefined, folders(a, b)))
    assert.strictEqual(
      workspaceIndexPath(storage, undefined, folders(a, b)),
      workspaceIndexPath(storage, undefined, folders(b, a))
    )
    assert.notStrictEqual(
      workspaceIndexPath(storage, vscode.Uri.file("/one.code-workspace"), folders(a)),
      workspaceIndexPath(storage, vscode.Uri.file("/two.code-workspace"), folders(a))
    )
  })

  test("includes URI schemes and remote authorities in fallback identity", () => {
    const index = (uri: string) => workspaceIndexPath(undefined, undefined, folders(vscode.Uri.parse(uri)))
    assert.notStrictEqual(index("vscode-remote://ssh-remote+one/work/api"), index("vscode-remote://ssh-remote+two/work/api"))
    assert.notStrictEqual(index("file:///work/api"), index("vscode-remote://ssh-remote+one/work/api"))
    const virtualStorage = vscode.Uri.parse("memfs://storage/index")
    assert.strictEqual(
      workspaceIndexPath(virtualStorage, undefined, folders(vscode.Uri.file("/projects/api"))),
      workspaceIndexPath(undefined, undefined, folders(vscode.Uri.file("/projects/api")))
    )
    assert.strictEqual(workspaceIndexPath(undefined, undefined, undefined), undefined)
    assert.strictEqual(workspaceIndexPath(undefined, undefined, []), undefined)
  })

  test("separate stores do not reuse another project's rows, and search filters stale roots", async function () {
    this.timeout(30000)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-workspace-"))
    const storage = vscode.Uri.file(path.join(dir, "storage"))
    const firstRoot = path.join(dir, "first", "api")
    const secondRoot = path.join(dir, "second", "api")
    const firstPath = workspaceIndexPath(storage, undefined, folders(vscode.Uri.file(firstRoot)))!
    const secondPath = workspaceIndexPath(storage, undefined, folders(vscode.Uri.file(secondRoot)))!
    const file = path.join(firstRoot, "only-first.ts")
    const row = {
      file, content: "private to first workspace", startLine: 0, endLine: 0,
      keywords: "private first workspace", part: 0, vector: [0.1, 0.2, 0.3]
    }
    const stamp = { hash: "fixture", size: 26, mtimeMs: 1, chunks: 1 }
    const manifest = { version: 3, model: "fixture", dimensions: 3, files: { [file]: stamp } }
    try {
      const first = new EmbeddingDatabase(firstPath)
      await first.connect()
      await first.replaceFiles([file], [row])
      await first.saveManifest(manifest)
      const second = new EmbeddingDatabase(secondPath)
      await second.connect()
      assert.strictEqual(second.hasIndex, false)
      assert.deepStrictEqual(await second.vectorSearch(row.vector, 5), [])
      const reopened = new EmbeddingDatabase(firstPath)
      await reopened.connect()
      assert.strictEqual(reopened.hasIndex, true)
      assert.deepStrictEqual((await reopened.vectorSearch(row.vector, 5)).map((hit) => hit.file), [file])

      // A removed workspace root must not reach reranking or the final prompt,
      // even if an already-open database still contains its old rows.
      let reranked = false
      const search = new WorkspaceSearch(
        reopened,
        { embedOne: async () => row.vector } as unknown as Embedder,
        { rerank: async () => { reranked = true; return [1] } } as unknown as Reranker,
        async () => undefined,
        (candidate) => candidate.startsWith(secondRoot + path.sep)
      )
      const result = await search.searchDetailed("private", {
        limit: 5, threshold: 0.1, maxChars: 1000, focus: [file]
      })
      assert.deepStrictEqual(result.hits, [])
      assert.deepStrictEqual(result.nearMisses, [])
      assert.strictEqual(result.candidates, 0)
      assert.strictEqual(reranked, false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
