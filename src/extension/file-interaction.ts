import { InteractionItem } from '../common/types'
import { LRUCache } from './cache'

export class FileInteractionCache {
  private _currentFile: string | null = null
  private _inactivityTimeout: ReturnType<typeof setTimeout> | null = null
  private _interactions = new LRUCache<InteractionItem>(20)
  private _sessionPauseTime: Date | null = null
  private _sessionStartTime: Date | null = null
  private readonly _inactivityThreshold = 5 * 60 * 1000 // 5 minutes
  private static readonly KEY_STROKE_WEIGHT = 2
  private static readonly OPEN_FILE_WEIGHT = 10
  private static readonly RECENCY_WEIGHT = 2.1
  private static readonly SESSION_LENGTH_WEIGHT = 1
  private static readonly VISIT_WEIGHT = 0.5

  constructor() {
    this.resetInactivityTimeout()
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

    const recency = Date.now() - (interaction.lastVisited || 0)
    const score =
      (interaction.keyStrokes || 0) * FileInteractionCache.KEY_STROKE_WEIGHT +
      (interaction.visits || 0) * FileInteractionCache.VISIT_WEIGHT +
      (interaction.sessionLength || 0) *
        FileInteractionCache.SESSION_LENGTH_WEIGHT -
      recency * FileInteractionCache.RECENCY_WEIGHT

    return (
      score + (interaction.isOpen ? FileInteractionCache.OPEN_FILE_WEIGHT : 0)
    )
  }

  getAll(): InteractionItem[] {
    return Array.from(this._interactions.getAll())
      .map(([name, interaction]) => ({
        name,
        keyStrokes: interaction?.keyStrokes || 0,
        visits: interaction?.visits || 0,
        sessionLength: interaction?.sessionLength || 0,
        lastVisited: interaction?.lastVisited || 0,
        activeLines: interaction?.activeLines || [],
        relevanceScore: this.calculateRelevanceScore(interaction)
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
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
    this.put(filePath)
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

  put(filePath: string): void {
    this._currentFile = filePath.replace('.git', '').replace('.hg', '')
    const fileExtension = this._currentFile.split('.').pop()
    if (this._interactions.get(this._currentFile)) {
      this.incrementVisits()
      return
    }
    if (this._currentFile.includes('.') && fileExtension) {
      this._interactions.set(this._currentFile, {
        name: this._currentFile,
        keyStrokes: 0,
        visits: 1,
        sessionLength: 0,
        activeLines: [],
        lastVisited: Date.now(),
        relevanceScore: 0
      })
    }
  }
}
