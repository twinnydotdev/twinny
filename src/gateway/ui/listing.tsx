/**
 * The pieces a filterable, sortable listing shares: state that survives a
 * reload, a sortable column header, an "age" filter and the comparators.
 * Used by the pull-request plugins for their pulls and issues tables.
 */
import React, { useEffect, useState } from "react"

/** Column sort: which key, and which way. */
export interface Sort<K extends string> {
  key: K
  dir: "asc" | "desc"
}

/**
 * State remembered in localStorage under `key`, so the filters an operator
 * set are there after a reload. Storage may be unavailable (private windows,
 * cleared site data): the page then simply forgets.
 */
export const useStoredState = <T,>(key: string, initial: T, valid?: (value: unknown) => value is T): [T, (next: T | ((current: T) => T)) => void] => {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return initial
      const parsed: unknown = JSON.parse(raw)
      return valid ? (valid(parsed) ? parsed : initial) : (parsed as T)
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* forgotten on reload; nothing else to do */
    }
  }, [key, value])
  return [value, setValue]
}

/** "Not updated for …": how far back the newest rows may reach. */
export type Age = "" | "1d" | "7d" | "30d" | "stale"

export const AGE_OPTIONS: Array<{ value: Age; label: string }> = [
  { value: "", label: "any time" },
  { value: "1d", label: "updated today" },
  { value: "7d", label: "updated this week" },
  { value: "30d", label: "updated this month" },
  { value: "stale", label: "quiet for 30 days" }
]

export const withinAge = (iso: string, age: Age, now: number = Date.now()): boolean => {
  if (!age) return true
  const days = (now - Date.parse(iso)) / 86_400_000
  if (!Number.isFinite(days)) return age === "stale"
  return age === "1d" ? days <= 1 : age === "7d" ? days <= 7 : age === "30d" ? days <= 30 : days > 30
}

/** Sorts a copy of `rows` by `pick`, strings case-insensitively, `undefined` last. */
export const sortRows = <T,>(rows: T[], dir: "asc" | "desc", pick: (row: T) => string | number | undefined): T[] => {
  const sign = dir === "asc" ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = pick(a)
    const y = pick(b)
    if (x === undefined && y === undefined) return 0
    if (x === undefined) return 1
    if (y === undefined) return -1
    if (typeof x === "string" && typeof y === "string") return sign * x.localeCompare(y, undefined, { sensitivity: "base" })
    return sign * (Number(x) - Number(y))
  })
}

/** Flips direction when the same column is clicked, else starts the new column its natural way. */
export const toggleSort = <K extends string>(current: Sort<K>, key: K, natural: "asc" | "desc"): Sort<K> => ({
  key,
  dir: current.key === key ? (current.dir === "asc" ? "desc" : "asc") : natural
})

interface SortHeaderProps<K extends string> {
  column: K
  sort: Sort<K>
  onSort: (key: K) => void
  children: React.ReactNode
  title?: string
  className?: string
}

/** A column header that sorts the table. */
export const SortHeader = <K extends string>({ column, sort, onSort, children, title, className }: SortHeaderProps<K>) => {
  const on = sort.key === column
  return (
    <th className={`sortable ${on ? "on" : ""} ${className ?? ""}`} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} title={title}>
      <button type="button" onClick={() => onSort(column)}>
        {children}
        <span className="sort-mark" aria-hidden="true">
          {on ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  )
}

interface FilterSelectProps {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
  /** The option for "no filter"; the first entry when left out. */
  any?: string
}

/** A toolbar select that reads as "label: value" and lights when set. */
export const FilterSelect = ({ label, value, onChange, options, any }: FilterSelectProps) => (
  <label className={`filter ${value ? "on" : ""}`}>
    <span>{label}</span>
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {any !== undefined && <option value="">{any}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
)

/** Distinct, sorted values for a select. */
export const distinct = (values: Array<string | undefined>): string[] =>
  [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
