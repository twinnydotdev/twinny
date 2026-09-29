/**
 * Indexing runs: a developer's embedding calls to one alias with no gap
 * longer than this are one run. Used by the usage summary (a run counts as
 * one request) and the Recordings page (a run is one expandable row).
 * Pure, so the admin page can import it.
 */
export const RUN_GAP_MS = 2 * 60 * 1000
