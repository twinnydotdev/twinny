/**
 * The little of S3 a backup needs, signed with AWS Signature V4 by hand
 * so the server stays dependency-free: put, get, list and delete objects
 * under one prefix. Works against AWS, MinIO, Cloudflare R2, Backblaze
 * B2, Wasabi, Hetzner and anything else that speaks the S3 API.
 */
import { createHash, createHmac } from "node:crypto"

export interface S3Settings {
  /** `https://s3.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`, `http://minio:9000`… */
  endpoint: string
  region: string
  bucket: string
  /** Key prefix inside the bucket, e.g. `twinny/`; empty for the bucket root. */
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key`; what MinIO wants. */
  forcePathStyle: boolean
}

export interface S3Object {
  key: string
  size: number
  lastModified: string
}

const sha256 = (data: Buffer | string): string =>
  createHash("sha256").update(data as Uint8Array | string).digest("hex")
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key as Uint8Array | string).update(data, "utf8").digest()

/** RFC 3986 encoding, as SigV4 wants it: `/` kept in paths, everything else strict. */
const encode = (value: string, keepSlash: boolean): string =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, keepSlash ? "/" : "%2F")

const amzDate = (now: Date): { date: string; stamp: string } => {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  return { date: stamp.slice(0, 8), stamp }
}

export class S3Client {
  constructor(
    private readonly _settings: S3Settings,
    private readonly _fetch: typeof fetch = fetch,
    private readonly _now: () => number = Date.now
  ) {}

  private url(key: string, query: Record<string, string> = {}): {
    url: URL
    canonicalPath: string
    host: string
  } {
    const endpoint = new URL(this._settings.endpoint)
    const { bucket, forcePathStyle } = this._settings
    const host = forcePathStyle ? endpoint.host : `${bucket}.${endpoint.host}`
    const basePath = endpoint.pathname.replace(/\/$/, "")
    const objectPath = key ? `/${encode(key, true)}` : ""
    const canonicalPath = `${basePath}${forcePathStyle ? `/${bucket}` : ""}${objectPath}` || "/"
    const url = new URL(`${endpoint.protocol}//${host}${canonicalPath}`)
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
    return { url, canonicalPath, host }
  }

  private async request(
    method: string,
    key: string,
    options: { query?: Record<string, string>; body?: Buffer } = {}
  ): Promise<Response> {
    const { url, canonicalPath, host } = this.url(key, options.query)
    const body = options.body ?? Buffer.alloc(0)
    const payloadHash = sha256(body)
    const { date, stamp } = amzDate(new Date(this._now()))
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": stamp
    }
    const signedHeaders = Object.keys(headers).sort().join(";")
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((name) => `${name}:${headers[name].trim()}\n`)
      .join("")
    const canonicalQuery = [...url.searchParams.entries()]
      .map(([name, value]) => [encode(name, false), encode(value, false)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
      .map(([name, value]) => `${name}=${value}`)
      .join("&")
    const canonicalRequest = [method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n")
    const scope = `${date}/${this._settings.region}/s3/aws4_request`
    const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonicalRequest)].join("\n")
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this._settings.secretAccessKey}`, date), this._settings.region), "s3"), "aws4_request")
    const signature = createHmac("sha256", signingKey as Uint8Array).update(stringToSign, "utf8").digest("hex")
    const { host: _host, ...sent } = headers
    void _host
    return this._fetch(url.toString(), {
      method,
      headers: {
        ...sent,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this._settings.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        ...(method === "PUT" ? { "Content-Type": "application/octet-stream", "Content-Length": String(body.length) } : {})
      },
      ...(method === "PUT" ? { body: body as Uint8Array } : {})
    })
  }

  private async fail(response: Response, what: string): Promise<never> {
    const text = (await response.text()).slice(0, 400)
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1]
    const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1]
    throw new Error(
      `${what}: ${response.status}${code ? ` ${code}` : ""}${message ? ` (${message})` : ""}.`
    )
  }

  private fullKey(name: string): string {
    return `${this._settings.prefix}${name}`
  }

  public async put(name: string, data: Buffer): Promise<void> {
    const response = await this.request("PUT", this.fullKey(name), { body: data })
    if (!response.ok) await this.fail(response, `Uploading ${name}`)
    await response.arrayBuffer()
  }

  public async get(name: string): Promise<Buffer> {
    const response = await this.request("GET", this.fullKey(name))
    if (!response.ok) await this.fail(response, `Downloading ${name}`)
    return Buffer.from(await response.arrayBuffer())
  }

  public async delete(name: string): Promise<void> {
    const response = await this.request("DELETE", this.fullKey(name))
    if (!response.ok && response.status !== 404) await this.fail(response, `Deleting ${name}`)
    await response.arrayBuffer()
  }

  /** Objects under the prefix, names without it, oldest first. */
  public async list(): Promise<S3Object[]> {
    const objects: S3Object[] = []
    let token: string | undefined
    do {
      const query: Record<string, string> = { "list-type": "2", "max-keys": "1000" }
      if (this._settings.prefix) query.prefix = this._settings.prefix
      if (token) query["continuation-token"] = token
      const response = await this.request("GET", "", { query })
      if (!response.ok) await this.fail(response, "Listing the bucket")
      const xml = await response.text()
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const entry = match[1]
        const key = /<Key>([^<]+)<\/Key>/.exec(entry)?.[1]
        if (!key) continue
        objects.push({
          key: key.slice(this._settings.prefix.length),
          size: Number(/<Size>(\d+)<\/Size>/.exec(entry)?.[1] ?? 0),
          lastModified: /<LastModified>([^<]+)<\/LastModified>/.exec(entry)?.[1] ?? ""
        })
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1]
        : undefined
    } while (token)
    return objects.sort((a, b) => a.key.localeCompare(b.key))
  }
}
