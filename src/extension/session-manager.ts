/* eslint-disable @typescript-eslint/no-explicit-any */
export class SessionManager {
  private sessionData: Map<string, any>

  constructor() {
    this.sessionData = new Map()
  }

  set(key: string, value: any): void {
    this.sessionData.set(key, value)
  }

  get(key: string): any {
    return this.sessionData.get(key)
  }

  clear(): void {
    this.sessionData.clear()
  }
}
