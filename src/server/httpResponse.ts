import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'

const DEFAULT_JSON_GZIP_MIN_BYTES = 1024

export function acceptsGzipEncoding(value: IncomingHttpHeaders['accept-encoding']): boolean {
  const acceptEncoding = Array.isArray(value) ? value.join(',') : value ?? ''
  let gzipQ: number | null = null
  let wildcardQ: number | null = null
  for (const entry of acceptEncoding.split(',')) {
    const [encoding = '', ...params] = entry.trim().split(';').map((part) => part.trim().toLowerCase())
    if (encoding !== 'gzip' && encoding !== '*') continue
    const qParam = params.find((param) => param.startsWith('q='))
    const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1
    const normalizedQ = Number.isFinite(q) ? Math.max(0, Math.min(1, q)) : 0
    if (encoding === 'gzip') gzipQ = normalizedQ
    if (encoding === '*') wildcardQ = normalizedQ
  }
  if (gzipQ !== null) return gzipQ > 0
  return (wildcardQ ?? 0) > 0
}

export function sendJsonResponse(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  options: { minGzipBytes?: number } = {},
): void {
  const body = Buffer.from(JSON.stringify(payload))
  const minGzipBytes = options.minGzipBytes ?? DEFAULT_JSON_GZIP_MIN_BYTES
  const request = (res as ServerResponse & { req?: IncomingMessage }).req
  const shouldGzip = body.length >= minGzipBytes && acceptsGzipEncoding(request?.headers['accept-encoding'])

  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Vary', 'Accept-Encoding')

  if (shouldGzip) {
    const gzipped = gzipSync(body)
    res.setHeader('Content-Encoding', 'gzip')
    res.setHeader('Content-Length', String(gzipped.length))
    res.end(gzipped)
    return
  }

  res.setHeader('Content-Length', String(body.length))
  res.end(body)
}
