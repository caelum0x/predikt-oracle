// Dashboard static-serving tests: the SPA shell, stylesheet, and script are
// served with correct content types; unknown /app paths 404; assets are read
// eagerly at route creation so no request ever blocks on file I/O.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createDashboardRoutes } from '../src/routes/dashboard'

function makeApp(): Hono {
  return new Hono().route('/', createDashboardRoutes())
}

describe('dashboard routes', () => {
  it('serves the app shell at /app as HTML', async () => {
    const res = await makeApp().request('/app')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Predikt Oracle')
    expect(html).toContain('/app/app.css')
    expect(html).toContain('/app/app.js')
    expect(html).toContain('id="markets-grid"')
  })

  it('serves the stylesheet with a CSS content type', async () => {
    const res = await makeApp().request('/app/app.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/css')
    const css = await res.text()
    expect(css).toContain(':root')
    expect(css).toContain('--bg')
  })

  it('serves the script with a JavaScript content type', async () => {
    const res = await makeApp().request('/app/app.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('javascript')
    const js = await res.text()
    expect(js).toContain('loadMarkets')
    expect(js).toContain('/markets')
  })

  it('serves assets from cache on repeat requests', async () => {
    const app = makeApp()
    const first = await app.request('/app/app.css')
    const second = await app.request('/app/app.css')
    expect(second.status).toBe(200)
    expect(await second.text()).toBe(await first.text())
  })

  it('returns 404 for unknown paths under /app', async () => {
    const res = await makeApp().request('/app/nope')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { success: boolean; error?: string }
    expect(body.success).toBe(false)
  })

  it('reads all assets eagerly at route creation, not inside request handlers', async () => {
    // Regression: files used to be read lazily with readFileSync inside the
    // handler, blocking the event loop on the first request per file. Serve
    // from a temp public dir, create the routes (which must read the files
    // NOW), then rewrite the files on disk — responses must still carry the
    // original contents because no request-time read happens.
    const dir = mkdtempSync(join(tmpdir(), 'predikt-dash-'))
    const publicDir = join(dir, 'public')
    mkdirSync(publicDir)
    const original = {
      'index.html': '<html>preloaded-shell</html>',
      'app.css': ':root { --preloaded: 1; }',
      'app.js': 'const preloaded = true',
    }
    for (const [name, contents] of Object.entries(original)) {
      writeFileSync(join(publicDir, name), contents)
    }

    const previousCwd = process.cwd()
    try {
      process.chdir(dir)
      const app = new Hono().route('/', createDashboardRoutes())

      for (const name of Object.keys(original)) {
        writeFileSync(join(publicDir, name), 'MODIFIED AFTER STARTUP')
      }

      expect(await (await app.request('/app')).text()).toBe(
        original['index.html']
      )
      expect(await (await app.request('/app/app.css')).text()).toBe(
        original['app.css']
      )
      expect(await (await app.request('/app/app.js')).text()).toBe(
        original['app.js']
      )
    } finally {
      process.chdir(previousCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
