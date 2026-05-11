import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'

const DEFAULT_JSON_GZIP_MIN_BYTES = 1024

export function acceptsGzipEncoding(value: IncomingHttpHeaders['accept-encoding']): boolean {
  const acceptEncoding = Array.isArray(value) ? value.join(',') : value ?? ''
  return acceptEncoding.split(',').some((entry) => {
    const [encoding = '', ...params] = entry.trim().split(';').map((part) => part.trim().toLowerCase())
    if (encoding !== 'gzip' && encoding !== '*') return false
    return !params.some((param) => /^q=0(?:\.0*)?$/u.test(param))
  })
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
