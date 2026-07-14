// Public web dashboard for Predikt Oracle. Serves the static single-page app
// (index.html / app.css / app.js) from the project's /public directory.
// All three files are read eagerly when the routes are created (startup),
// so the synchronous file I/O never runs inside a request handler where it
// would block the event loop — no extra dependencies, no build step.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { Context } from 'hono'

type StaticEntry = { file: string; contentType: string }

const STATIC_ENTRIES: Readonly<Record<string, StaticEntry>> = {
  '/app': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/app/app.css': { file: 'app.css', contentType: 'text/css; charset=utf-8' },
  '/app/app.js': {
    file: 'app.js',
    contentType: 'text/javascript; charset=utf-8',
  },
}

// Module-level cache: absolute file path -> file contents.
const fileCache = new Map<string, string>()

function readPublicFile(fileName: string): string {
  const fullPath = join(process.cwd(), 'public', fileName)
  const cached = fileCache.get(fullPath)
  if (cached !== undefined) return cached
  const contents = readFileSync(fullPath, 'utf8')
  fileCache.set(fullPath, contents)
  return contents
}

function serveEntry(c: Context, entry: StaticEntry): Response {
  try {
    const body = readPublicFile(entry.file)
    return c.body(body, 200, { 'Content-Type': entry.contentType })
  } catch (err) {
    console.error(
      `dashboard: failed to read public/${entry.file}:`,
      err instanceof Error ? err.message : 'unknown error'
    )
    return c.json({ success: false, error: 'Dashboard asset unavailable.' }, 500)
  }
}

export function createDashboardRoutes(): Hono {
  const app = new Hono()

  // Warm the cache now (server startup) so the first request never pays for
  // a blocking readFileSync. A missing file is reported per-request by
  // serveEntry, so a broken deploy still gets a clean 500 instead of a crash.
  for (const entry of Object.values(STATIC_ENTRIES)) {
    try {
      readPublicFile(entry.file)
    } catch {
      // Surfaced with full context by serveEntry when the path is requested.
    }
  }

  for (const [path, entry] of Object.entries(STATIC_ENTRIES)) {
    app.get(path, (c) => serveEntry(c, entry))
  }

  // Anything else under /app is an explicit 404 (registered after the
  // static routes so it never shadows them).
  app.get('/app/*', (c) =>
    c.json({ success: false, error: 'Not found.' }, 404)
  )

  return app
}
