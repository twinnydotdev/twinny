import * as vscode from "vscode"

import { InteractionItem } from "../common/types"

import { LRUCache } from "./cache"

export class FileInteractionCache {
  private _currentFile: string | null = null
  private _inactivityTimeout: ReturnType<typeof setTimeout> | null = null
  private _interactions = new LRUCache<InteractionItem>(20)
  private _sessionPauseTime: Date | null = null
  private _sessionStartTime: Date | null = null
  private readonly _disposables: vscode.Disposable[] = []
  private readonly _inactivityThreshold = 5 * 60 * 1000
  private readonly FILTER_REGEX = /\.git|git|package.json|.hg/
  private static readonly KEY_STROKE_WEIGHT = 2
  private static readonly OPEN_FILE_WEIGHT = 10
  private static readonly RECENCY_WEIGHT = 2.1
  private static readonly SESSION_LENGTH_WEIGHT = 1
  private static readonly VISIT_WEIGHT = 0.5

  constructor() {
    this._disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const item = this._interactions.get(doc.fileName)
        if (item) {
          this._interactions.set(doc.fileName, { ...item, isOpen: false })
        }
      })
    )

    this.resetInactivityTimeout()
    this.addOpenFilesWithPriority()
  }

  dispose() {
    if (this._inactivityTimeout) {
      clearTimeout(this._inactivityTimeout)
    }
    this._disposables.forEach((d) => d.dispose())
  }

  resetInactivityTimeout() {
    if (this._inactivityTimeout) {
      clearTimeout(this._inactivityTimeout)
    }
    this._inactivityTimeout = setTimeout(
      () => this.pauseSession(),
      this._inactivityThreshold
    )
  }

  pauseSession() {
    if (!this._sessionStartTime || this._sessionPauseTime) return
    this._sessionPauseTime = new Date()
  }

  resumeSession() {
    if (!this._sessionStartTime || !this._sessionPauseTime) return

    const pausedDuration =
      new Date().getTime() - this._sessionPauseTime.getTime()
    this._sessionStartTime = new Date(
      this._sessionStartTime.getTime() + pausedDuration
    )

    this._sessionPauseTime = null
    this.resetInactivityTimeout()
  }

  private calculateRelevanceScore(interaction: InteractionItem | null): number {
    if (!interaction) return 0

    const recencyInHours =
      (Date.now() - (interaction.lastVisited || 0)) / (1000 * 60 * 60)
    const recencyScore = Math.max(0, 24 - recencyInHours) // Caps at 24 hours

    return (
      (interaction.keyStrokes || 0) * FileInteractionCache.KEY_STROKE_WEIGHT +
      (interaction.visits || 0) * FileInteractionCache.VISIT_WEIGHT +
      (interaction.sessionLength || 0) *
        FileInteractionCache.SESSION_LENGTH_WEIGHT +
      recencyScore * FileInteractionCache.RECENCY_WEIGHT +
      (interaction.isOpen ? FileInteractionCache.OPEN_FILE_WEIGHT : 0)
    )
  }

  getAll(): InteractionItem[] {
    return Array.from(this._interactions.getAll())
      .map(([name, interaction]) => ({
        keyStrokes: interaction?.keyStrokes || 0,
        visits: interaction?.visits || 0,
        sessionLength: interaction?.sessionLength || 0,
        lastVisited: interaction?.lastVisited || 0,
        activeLines: interaction?.activeLines || [],
        isOpen: interaction?.isOpen || false,
        name,
        relevanceScore: this.calculateRelevanceScore(interaction)
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
  }

  addOpenFilesWithPriority(): void {
    const openFiles = vscode.workspace.textDocuments
      .filter((doc) => !doc.isUntitled)
      .map((doc) => doc.fileName)
      .filter((fileName) => !fileName.match(this.FILTER_REGEX))

    for (const filePath of openFiles) {
      this.putOpenFile(filePath)
    }
  }

  getCurrentFile(): string | null {
    return this._currentFile
  }

  incrementVisits() {
    if (!this._currentFile) return
    const item = this._interactions.get(this._currentFile)
    if (!item) return
    this._interactions.set(this._currentFile, {
      ...item,
      visits: (item.visits || 0) + 1,
      lastVisited: Date.now()
    })
  }

  incrementStrokes(currentLine: number, currentCharacter: number) {
    if (!this._currentFile) return
    const item = this._interactions.get(this._currentFile)
    if (!item) return

    this._interactions.set(this._currentFile, {
      ...item,
      keyStrokes: (item.keyStrokes || 0) + 1,
      activeLines: [
        ...item.activeLines,
        { line: currentLine, character: currentCharacter }
      ],
      lastVisited: Date.now()
    })

    this.resumeSession()
    this.resetInactivityTimeout()
  }

  startSession(filePath: string): void {
    this._sessionStartTime = new Date()
    this.putOpenFile(filePath)
    this.incrementVisits()
    this.resetInactivityTimeout()
  }

  endSession(): void {
    if (!this._currentFile || !this._sessionStartTime) return
    if (this._inactivityTimeout) {
      clearTimeout(this._inactivityTimeout)
    }

    let sessionEndTime = new Date()
    if (this._sessionPauseTime) {
      sessionEndTime = this._sessionPauseTime
    }

    const sessionLength =
      (sessionEndTime.getTime() - this._sessionStartTime.getTime()) / 1000

    const item = this._interactions.get(this._currentFile)
    if (item) {
      this._interactions.set(this._currentFile, {
        ...item,
        sessionLength: (item.sessionLength || 0) + sessionLength,
        lastVisited: Date.now()
      })
    }

    this._sessionStartTime = null
    this._sessionPauseTime = null
    this._currentFile = null
  }

  delete(filePath: string): void {
    if (!this._interactions.get(filePath)) return
    this._interactions.delete(filePath)
  }

  putOpenFile(filePath: string): void {
    this.putFile(filePath, true)
  }

  putClosedFile(filePath: string): void {
    this.putFile(filePath, false)
  }

  putFile(filePath: string, isOpen: boolean): void {
    if (filePath.match(this.FILTER_REGEX)) return

    this._currentFile = filePath

    const fileExtension = filePath.split(".").pop()

    if (this._interactions.get(filePath)) return

    if (filePath.includes(".") && fileExtension) {
      this._interactions.set(filePath, {
        name: filePath,
        keyStrokes: 0,
        visits: 1,
        sessionLength: 0,
        activeLines: [],
        lastVisited: Date.now(),
        isOpen
      })
    }
  }
}
