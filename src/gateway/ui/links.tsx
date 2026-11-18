/**
 * Links out of the admin page. Every address the page shows came from
 * somewhere else: a forge's API (a check's URL is whatever a commit
 * status said), a pull's description, a model's answer. Only http(s)
 * addresses become links; anything else is shown as plain text.
 */
import React from "react"

/** The address if the page may link to it, else nothing. */
export const httpUrl = (url: string | null | undefined): string | undefined => {
  if (typeof url !== "string") return undefined
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined
  } catch {
    return undefined
  }
}

interface ExternalLinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "target" | "rel"> {
  href: string | null | undefined
}

/** Opens in a new tab that learns nothing about this one; plain text when the address is not http(s). */
export const ExternalLink = ({ href, children, className, ...rest }: ExternalLinkProps) => {
  const safe = httpUrl(href)
  if (!safe) return <span className={className}>{children}</span>
  return (
    <a {...rest} className={className} href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}
