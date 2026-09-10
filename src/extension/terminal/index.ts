import { TerminalHistory } from "./history"

export { NO_TERMINAL_OUTPUT, TerminalHistory } from "./history"

/** One watcher for the whole extension; disposed with it. */
export const terminalHistory = new TerminalHistory()
