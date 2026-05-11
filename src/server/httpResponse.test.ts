import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { acceptsGzipEncoding, sendJsonResponse } from './httpResponse'

class TestResponse {
  statusCode = 200
  headers = new Map<string, string | number | string[]>()
  body: Buffer | null = null
  req = { headers: {} as Record<string, string> }

  setHeader(name: string, value: string | number | string[]): void {
    this.headers.set(name.toLowerCase(), value)
  }

  end(value?: Buffer | string): void {
    this.body = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '')
  }
}

describe('acceptsGzipEncoding', () => {
  it('accepts gzip and wildcard encodings unless q=0 disables them', () => {
    expect(acceptsGzipEncoding('br, gzip')).toBe(true)
    expect(acceptsGzipEncoding('br, *;q=0.5')).toBe(true)
    expect(acceptsGzipEncoding('gzip;q=0')).toBe(false)
    expect(acceptsGzipEncoding('gzip;q=0, *;q=1')).toBe(false)
    expect(acceptsGzipEncoding('gzip;q=0.25, *;q=0')).toBe(true)
    expect(acceptsGzipEncoding('br')).toBe(false)
  })
})

describe('sendJsonResponse', () => {
  it('sends small JSON responses without gzip', () => {
    const res = new TestResponse()
    res.req.headers['accept-encoding'] = 'gzip'

    sendJsonResponse(res as never, 201, { ok: true }, { minGzipBytes: 1024 })

    expect(res.statusCode).toBe(201)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store, private')
    expect(res.headers.get('content-encoding')).toBeUndefined()
    expect(res.body?.toString('utf8')).toBe('{"ok":true}')
  })

  it('gzips JSON responses when the client accepts gzip and the body is large enough', () => {
    const res = new TestResponse()
    res.req.headers['accept-encoding'] = 'br, gzip'

    sendJsonResponse(res as never, 200, { text: 'x'.repeat(128) }, { minGzipBytes: 16 })

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(JSON.parse(gunzipSync(res.body ?? Buffer.alloc(0)).toString('utf8'))).toEqual({ text: 'x'.repeat(128) })
  })
})
