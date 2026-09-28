export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message)
  }
}

export const api = async <T,>(path: string, key: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {})
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  })
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const message =
      (body as { error?: { message?: string } } | undefined)?.error?.message ||
      `The gateway answered ${response.status}.`
    throw new ApiError(message, response.status)
  }
  return body as T
}


/** Trades a page link's code for the key that asked for it. The code is the credential, once. */
export const openPageLink = async (code: string): Promise<{ key: string; name: string }> => {
  const response = await fetch("/twinny/v1/page-link/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  })
  const body = (await response.json().catch(() => undefined)) as { key?: string; name?: string; error?: { message?: string } } | undefined
  if (!response.ok || typeof body?.key !== "string") {
    throw new ApiError(body?.error?.message || `The gateway answered ${response.status}.`, response.status)
  }
  return { key: body.key, name: body.name ?? "" }
}
