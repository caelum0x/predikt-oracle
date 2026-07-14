// SSRF guard for user-supplied webhook URLs.
//
// The dispatcher POSTs signed delivery bodies to whatever URL a subscriber
// registers, so an unrestricted URL lets an authenticated caller aim the
// server at internal services (cloud metadata endpoints, RFC-1918 hosts,
// loopback) and use the delivery outcome (failureCount / isActive, exposed by
// GET /webhooks) as a port-scanning side channel.
//
// We block obviously-dangerous destinations at CREATE time by inspecting the
// URL's literal host. RESIDUAL RISK: this rejects literal private/loopback/
// link-local IPs and localhost forms, but does NOT resolve DNS, so a public
// hostname that resolves to a private address (including DNS-rebinding) is not
// caught here. Doing DNS at create time is racy (the record can change before
// delivery), so callers that need airtight protection should additionally run
// the dispatcher through an egress proxy / firewall that denies private ranges.

// Returns true when the host is a private, loopback, link-local, or
// cloud-metadata destination that a webhook must never target.
export function isBlockedWebhookHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase()
  if (host === '') return true

  // Strip IPv6 brackets, e.g. "[::1]" -> "::1".
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)

  // Loopback and metadata hostnames.
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === 'metadata.google.internal') return true

  // IPv6 loopback / unspecified.
  if (host === '::1' || host === '::') return true
  // IPv6 link-local (fe80::/10) and unique-local (fc00::/7).
  if (/^fe[89ab]/.test(host)) return true
  if (/^f[cd]/.test(host)) return true

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — evaluate the embedded IPv4.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host)
  if (mapped) host = mapped[1] as string

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 0) return true // "this" network / 0.0.0.0
    if (a === 127) return true // loopback 127.0.0.0/8
    if (a === 10) return true // private 10.0.0.0/8
    if (a === 169 && b === 254) return true // link-local 169.254.0.0/16
    if (a === 192 && b === 168) return true // private 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true // private 172.16.0.0/12
  }

  return false
}

// Validates a candidate webhook URL. Returns an error message when the URL is
// unusable or targets a blocked host, or null when it is acceptable.
export function webhookUrlError(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return 'url must be a valid http(s) URL.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'url must use http or https.'
  }
  if (isBlockedWebhookHost(url.hostname)) {
    return 'url must not target a private, loopback, link-local, or metadata address.'
  }
  return null
}
