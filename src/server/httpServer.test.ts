import { describe, expect, it } from 'vitest'
import { resolveGzippedStaticAssetPath } from './httpServer'

describe('resolveGzippedStaticAssetPath', () => {
  it('resolves gzip-eligible frontend assets inside dist/assets', () => {
    const assetPath = resolveGzippedStaticAssetPath('/assets/index.js')

    expect(assetPath).toMatch(/\/dist\/assets\/index\.js$/u)
  })

  it('rejects encoded paths that escape dist/assets', () => {
    expect(resolveGzippedStaticAssetPath('/assets/%2f..%2f..%2fdist-cli%2findex.js')).toBeNull()
    expect(resolveGzippedStaticAssetPath('/assets/%2e%2e/index.js')).toBeNull()
  })

  it('rejects non-gzipped asset extensions', () => {
    expect(resolveGzippedStaticAssetPath('/assets/logo.png')).toBeNull()
  })
})
