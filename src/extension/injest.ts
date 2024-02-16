import fs from 'fs'
import path from 'path'
import * as vscode from 'vscode'
import { StreamOptionsOllama, StreamRequestOptions } from './types'
import { streamEmbedding } from './stream'

type Vector = number[]

type Value = { id: string; chunk: string; vector: Vector }

export class VectorDB {
  private _contexts: Record<string, Value> = {}
  private chunks: string[] = []

  private filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  public addVector(id: string, chunk: string, vector: Vector) {
    if (this.chunks.includes(chunk.trim().toLowerCase())) {
      return
    }
    this.chunks.push(chunk.trim().toLowerCase())
    const context = { id, chunk, vector }
    this._contexts[id] = context
    const data = JSON.stringify(context)
    fs.appendFileSync(this.filePath, data + '\n', 'utf8')
    this.saveContextsToFile()
  }

  private saveContextsToFile() {
    const data = JSON.stringify(this._contexts, null, 2)
    fs.writeFileSync(this.filePath, data, 'utf8')
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

  private cosineSimilarity(vecA: Vector, vecB: Vector): number {
    let dotProduct = 0.0,
      normA = 0.0,
      normB = 0.0
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i]
      normA += vecA[i] * vecA[i]
      normB += vecB[i] * vecB[i]
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  public loadAllVectors() {
    try {
      const fileContent = fs.readFileSync(this.filePath, 'utf8')
      const json = JSON.parse(fileContent)
      this._contexts = json
    } catch (error) {
      console.error('Error loading vectors from file:', error)
    }
  }

  public findMostSimilar(vector: Vector) {
    let mostSimilar = { id: '', code: '', similarity: -1 }
    for (const item of Object.values(this._contexts)) {
      const similarity = this.cosineSimilarity(item.vector, vector)
      if (similarity > mostSimilar.similarity) {
        mostSimilar = { id: item.id, code: item.chunk, similarity }
      }
    }
    return mostSimilar
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
            const embedding = await this.getEmbedding(content)
            return this.addVector(dirent.name, content.trim(), embedding)
          })
        }
      })
    })
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
