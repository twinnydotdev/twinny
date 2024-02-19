import fs from 'fs'
import path from 'path'
import * as vscode from 'vscode'
import { StreamOptionsOllama, StreamRequestOptions } from './types'
import { streamEmbedding } from './stream'
import * as lancedb from 'vectordb'

type Vector = number[]

type Value = { id: string; chunk: string; vector: Vector }

export class VectorDB {
  private _contexts: Record<string, Value> = {}
  private chunks: string[] = []

  private dbPath: string
  private tbl: lancedb.Table<number[]> | null = null

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  public async createDatabase () {
    const db = await lancedb.connect(this.dbPath)
    this.tbl = await db.createTable(
      'embeddings',
      [],
      { writeMode: lancedb.WriteMode.Overwrite }
    )
  }

  public async addVector(id: string, chunk: string, vector: Vector) {
    if (this.chunks.includes(chunk.trim().toLowerCase())) {
      return
    }
    this.chunks.push(chunk.trim().toLowerCase())
    const context = { id, chunk, vector }
    const data = JSON.stringify(context)
    await this.tbl?.add([{
      vector,
      item: id,
      code: data,
    }]);

  }



  public async getEmbedding(content: string) {
    const requestBody: StreamOptionsOllama = {
      model: 'codellama:7b-instruct',
      prompt: content,
      stream: false,
      options: {}
    }

    const requestOptions: StreamRequestOptions = {
      hostname: 'localhost',
      port: 11434,
      path: '/api/embeddings',
      protocol: 'http',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }

    return new Promise<Vector>((resolve) => {
      streamEmbedding({
        body: requestBody,
        options: requestOptions,
        onData: (response: { embedding: Vector }) => {
          const embedding = response?.embedding
          resolve(embedding)
        }
      })
    })
  }

  public async injest(directoryPath: string) {
    fs.readdir(directoryPath, { withFileTypes: true }, (err, dirents) => {
      if (err) {
        vscode.window.showErrorMessage('Error reading directory')
        return
      }

      dirents.forEach((dirent) => {
        const fullPath = path.join(directoryPath, dirent.name)

        if (this.isDirectoryToIgnore(dirent.name)) {
          return
        }

        if (dirent.isDirectory()) {
          console.log('isDir', dirent)
          this.injest(fullPath)
        } else if (dirent.isFile()) {
          fs.readFile(fullPath, 'utf-8', async (err, content) => {
            if (err)
              return vscode.window.showErrorMessage(
                `Error reading file: ${fullPath}`
              )
            const MAX_CHUNK_SIZE = 1000
            const chunks = this.splitIntoChunks(content, MAX_CHUNK_SIZE)

            for (const chunk of chunks) {
              const embedding = await this.getEmbedding(chunk)
              this.addVector(fullPath, chunk.trim(), embedding)
            }
            return ''
          })
        }
      })
    })
  }

  splitIntoChunks(content: string, maxChunkSize: number): string[] {
    const chunks: string[] = []
    let currentChunkStart = 0

    while (currentChunkStart < content.length) {
      const end = Math.min(currentChunkStart + maxChunkSize, content.length)
      let boundary = content.lastIndexOf('\n', end)
      if (boundary === -1 || boundary - currentChunkStart < maxChunkSize / 2) {
        boundary = end
      }
      chunks.push(content.substring(currentChunkStart, boundary))
      currentChunkStart = boundary + 1
    }

    return chunks
  }

  public isDirectoryToIgnore(dirName: string): boolean {
    const ignoreList = [
      '.git',
      '.svn',
      '.hg',
      'node_modules',
      'bower_components',
      'dist',
      'build',
      'out',
      'release',
      'bin',
      'temp',
      'tmp',
      '.eslintignore',
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.json',
      '.babelrc',
      '.babelrc.js',
      '.babelrc.json',
      '.stylelintrc',
      '.stylelintrc.js',
      '.stylelintrc.json',
      '.prettierrc',
      '.prettierrc.js',
      '.prettierrc.json',
      'webpack.config.js',
      'tsconfig.json',
      'package-lock.json',
      'package.json',
      'yarn.lock',
      'composer.json',
      'composer.lock',
      '.editorconfig',
      '.travis.yml',
      '.gitignore',
      '.gitattributes',
      '.gitlab-ci.yml',
      '.dockerignore',
      'vagrantfile',
      'Dockerfile',
      'Makefile',
      'Procfile',
      'build.gradle',
      'pom.xml',
      'Gemfile',
      'Gemfile.lock',
      '.env',
      '.env.development',
      '.env.test',
      '.env.production',
      '.log',
      '.tmp',
      '.temp',
      '.swp',
      '.idea',
      '.vscode',
      '.eclipse',
      '.classpath',
      '.project',
      '.settings',
      '.DS_Store',
      'Thumbs.db',
      '__tests__',
      '__mocks__',
      'test',
      'tests',
      'Test',
      'Tests',
      'doc',
      'docs',
      'Doc',
      'Docs',
      'documentation',
      'LICENSE',
      'README.md',
      'CHANGELOG.md',
      'scripts',
      'tools',
      'util',
      'utils',
      'Resources',
      'assets',
      '.storybook',
      'storybook-static',
      'reports',
      'coverage',
      '.circleci',
      'jenkins',
      'public',
      'private',
      'sample',
      'samples',
      'demo',
      'demos',
      'example',
      'examples',
      'archive',
      'archives',
      'backup',
      'backups'
    ]

    return ignoreList.some((ignoreItem) => dirName.startsWith(ignoreItem))
  }
}
