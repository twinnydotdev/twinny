import { LRUCache } from './cache'

interface CacheItem {
  keyStrokes: number | null | undefined
  lastVisited: number
  name: string | null | undefined
  sessionLength: number
  visits: number | null | undefined
}

export class FileInteractionCache {
  private _interactions = new LRUCache<CacheItem>(20)
  private _currentFile: string | null = null
  private _sessionStartTime: Date | null = null
  private _sessionPauseTime: Date | null = null
  private _inactivityTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly _inactivityThreshold = 5 * 60 * 1000

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
    console.log('Session paused due to inactivity.')
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
    console.log('Session resumed.')
  }

  getAll() {
    const recencyWeight = 3
    const keyStrokeWeight = 2
    const sessionLengthWeight = 1
    const visitWeight = 0.5

    return Array.from(this._interactions.getAll())
      .map(([a, b]) => ({
        name: a,
        keyStrokes: b?.keyStrokes || 0,
        visits: b?.visits || 0,
        sessionLength: b?.sessionLength || 0,
        lastVisited: b?.lastVisited || 0
      }))
      .sort((a, b) => {
        const recencyA = Date.now() - (a.lastVisited || 0)
        const recencyB = Date.now() - (b.lastVisited || 0)
        const scoreA =
          a.keyStrokes * keyStrokeWeight +
          a.visits * visitWeight +
          a.sessionLength * sessionLengthWeight -
          recencyA * recencyWeight
        const scoreB =
          b.keyStrokes * keyStrokeWeight +
          b.visits * visitWeight +
          b.sessionLength * sessionLengthWeight -
          recencyB * recencyWeight
        return scoreB - scoreA
      })
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
      visits: (item.visits || 0) + 1
    })
  }

  incrementStrokes() {
    if (!this._currentFile) return
    const item = this._interactions.get(this._currentFile)
    if (!item) return

    this._interactions.set(this._currentFile, {
      ...item,
      keyStrokes: (item.keyStrokes || 0) + 1
    })

    this.resumeSession()
  }

  startSession(filePath: string): void {
    this._sessionStartTime = new Date()
    this.put(filePath)
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
        sessionLength: (item.sessionLength || 0) + sessionLength
      })
    }

    this._sessionStartTime = null
    this._sessionPauseTime = null
    console.log('Session ended.')
  }

  delete(filePath: string): void {
    if (!this._interactions.get(filePath)) return
    this._interactions.delete(filePath)
  }

  put(filePath: string): void {
    this._currentFile = filePath.replace('.git', '')
    const fileExtension = this._currentFile.split('.').pop()
    if (this._interactions.get(this._currentFile)) return
    if (this._currentFile.includes('.') && fileExtension) {
      this._interactions.set(this._currentFile, {
        name: this._currentFile,
        keyStrokes: 0,
        visits: 0,
        sessionLength: 0,
        lastVisited: Date.now()
      })
    }
  }
}
