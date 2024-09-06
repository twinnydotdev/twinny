/* eslint-disable @typescript-eslint/no-explicit-any */
export class SessionManager {
  private _sessionData: Map<string, any>

  constructor() {
    this._sessionData = new Map()
  }

  set(key: string, value: any): void {
    this._sessionData.set(key, value)
  }

  get(key: string): any {
    return this._sessionData.get(key)
  }

  clear(): void {
    this._sessionData.clear()
  }
}
