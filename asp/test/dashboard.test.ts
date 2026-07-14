// Dashboard static-serving tests: the SPA shell, stylesheet, and script are
// served with correct content types; unknown /app paths 404.

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
})
