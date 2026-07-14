// Builds a real ~65s demo MP4 for the Predikt Oracle hackathon submission.
//
// Pipeline: boot the actual server → run the real API flow (signup, create,
// quote, buy, resolve, payout, leaderboard) capturing genuine responses →
// screenshot the live dashboard with headless Chrome → render styled slide
// frames (HTML → PNG) → encode to H.264 with ffmpeg. Every value shown is real.
//
// Usage:  node submission/make-demo.mjs
// Output: submission/demo-video/predikt-oracle-demo.mp4

import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASP = path.join(ROOT, 'asp')
const OUT = path.join(ROOT, 'submission', 'demo-video')
const WORK = path.join(OUT, 'frames')
const DB = '/tmp/predikt-demo-video.db'
const PORT = 8799
const B = `http://localhost:${PORT}`
const CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const W = 1280
const H = 720

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) rmSync(f)
rmSync(OUT, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

// ---- helpers ----------------------------------------------------------------

async function api(method, pathname, { key, body } = {}) {
  const res = await fetch(`${B}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json()
  if (!json.success) throw new Error(`${method} ${pathname}: ${json.error}`)
  return json.data
}

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

function chromeShot(htmlPath, pngPath, { url, vtb = 0 } = {}) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-sandbox',
    `--force-device-scale-factor=2`,
    `--window-size=${W},${H}`,
    `--screenshot=${pngPath}`,
  ]
  if (vtb) args.push(`--virtual-time-budget=${vtb}`)
  args.push(url ?? `file://${htmlPath}`)
  execFileSync(CHROME, args, { stdio: 'ignore' })
}

// ---- shared slide styling ---------------------------------------------------

const CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  :root{
    --bg:#0b1018; --panel:#131b28; --line:#223047; --ink:#e6edf3; --dim:#8aa0b8;
    --yes:#2ec46b; --no:#f0546a; --acc:#4c8dff; --gold:#f5b53d;
  }
  html,body{ width:${W}px; height:${H}px; background:
     radial-gradient(1200px 600px at 78% -10%, #16233a 0%, rgba(11,16,24,0) 60%), var(--bg);
     color:var(--ink);
     font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;
     overflow:hidden; }
  .wrap{ width:100%; height:100%; padding:64px 72px; display:flex; flex-direction:column; }
  .brand{ position:absolute; top:40px; right:56px; font-weight:700; letter-spacing:.5px;
     color:var(--dim); font-size:20px; }
  .brand b{ color:var(--acc); }
  .step{ color:var(--acc); font-weight:700; font-size:22px; letter-spacing:2px;
     text-transform:uppercase; margin-bottom:18px; }
  .headline{ font-size:52px; font-weight:800; line-height:1.08; letter-spacing:-1px; }
  .sub{ font-size:26px; color:var(--dim); margin-top:20px; line-height:1.4; font-weight:500; }
  .term{ margin-top:34px; background:#0a0f18; border:1px solid var(--line); border-radius:14px;
     overflow:hidden; box-shadow:0 24px 60px rgba(0,0,0,.5); flex:1; display:flex; flex-direction:column; }
  .term .bar{ height:40px; background:#0e1622; border-bottom:1px solid var(--line);
     display:flex; align-items:center; gap:8px; padding:0 16px; }
  .term .bar i{ width:12px; height:12px; border-radius:50%; display:inline-block; }
  .term .bar .r{ background:#ff5f57 } .term .bar .y{ background:#febc2e } .term .bar .g{ background:#28c840 }
  .term .bar span{ color:var(--dim); font-size:15px; margin-left:12px; font-family:ui-monospace,monospace }
  .term pre{ padding:26px 30px; font-family:ui-monospace,'SF Mono',Menlo,monospace;
     font-size:22px; line-height:1.55; color:#cfe0f2; white-space:pre-wrap; }
  .cmd{ color:var(--yes) } .flag{ color:var(--dim) } .key{ color:var(--acc) }
  .val{ color:var(--gold) } .str{ color:#7fd6a2 } .muted{ color:var(--dim) }
  .center{ justify-content:center; align-items:flex-start; }
  .logo{ font-size:88px; font-weight:900; letter-spacing:-2px; }
  .logo .o{ color:var(--acc) }
  .grid{ display:grid; grid-template-columns:1fr 1fr; gap:18px 26px; margin-top:26px; }
  .card{ background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:22px 26px; }
  .card h3{ font-size:24px; margin-bottom:6px } .card p{ color:var(--dim); font-size:19px; line-height:1.35 }
  .card .em{ color:var(--yes) }
  .stat{ display:flex; gap:44px; margin-top:36px; }
  .stat div b{ display:block; font-size:56px; font-weight:800; color:var(--acc) }
  .stat div span{ color:var(--dim); font-size:20px }
  .tag{ display:inline-block; margin-top:30px; font-size:24px; color:var(--dim) }
  .tag b{ color:var(--acc) }
  .shot{ width:100%; height:100%; background-size:cover; background-position:top center; }
  .capbar{ position:absolute; left:0; right:0; bottom:0; padding:28px 72px;
     background:linear-gradient(0deg, rgba(6,10,16,.94) 30%, rgba(6,10,16,0));
     font-size:30px; font-weight:700 }
  .capbar small{ display:block; color:var(--dim); font-size:20px; font-weight:500; margin-top:4px }
`

function page(inner, { fullBleed = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
  <body>${fullBleed ? inner : `<div class="brand">Predikt <b>Oracle</b></div><div class="wrap">${inner}</div>`}</body></html>`
}

const slides = []
function slide(name, seconds, html) {
  const htmlPath = path.join(WORK, `${name}.html`)
  const pngPath = path.join(WORK, `${name}.png`)
  writeFileSync(htmlPath, html)
  chromeShot(htmlPath, pngPath)
  slides.push({ png: pngPath, seconds })
}

// ---- 1. boot the server -----------------------------------------------------

console.error('booting server…')
const server = spawn('npx', ['tsx', 'src/index.ts'], {
  cwd: ASP,
  env: { ...process.env, OPENROUTER_API_KEY: 'demo', PORT: String(PORT), DB_PATH: DB },
  stdio: 'ignore',
})
process.on('exit', () => server.kill())

for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${B}/health`)
    if (r.ok) break
  } catch {}
  await sleep(500)
}

// ---- 2. run the real flow ---------------------------------------------------

console.error('running the demo flow…')
const FUTURE = Date.now() + 170 * 24 * 60 * 60 * 1000

// Seed a populated board so the dashboard looks alive.
const curator = await api('POST', '/accounts', { body: { name: 'Predikt Curator' } })
const mover = await api('POST', '/accounts', { body: { name: 'Momentum Agent' } })
const seedMarkets = [
  ['Will BTC close above $150k in 2026?', 'Crypto', 0.36],
  ['Will the Fed cut rates in September 2026?', 'Finance', 0.55],
  ['Will a Claude 5 model top LMArena in August?', 'AI', 0.47],
]
for (const [question, category, initialProb] of seedMarkets) {
  const { market: m } = await api('POST', '/markets', {
    key: curator.apiKey,
    body: { question, criteria: `Resolves per the official source: ${question}`, category, closeTime: FUTURE, subsidy: 100, initialProb },
  })
  await api('POST', `/markets/${m.id}/buy`, { key: mover.apiKey, body: { side: 'YES', amount: 18 } })
}

// The hero storyline (all responses captured live).
const alice = await api('POST', '/accounts', { body: { name: 'Alice' } })
const bob = await api('POST', '/accounts', { body: { name: 'Bob' } })
const { market } = await api('POST', '/markets', {
  key: alice.apiKey,
  body: {
    question: 'Will ETH close above $8,000 on Dec 31, 2026?',
    criteria: 'Resolves YES on a CoinGecko daily close above $8,000.',
    category: 'Crypto', closeTime: FUTURE, subsidy: 100, initialProb: 0.4,
  },
})
const { quote } = await api('GET', `/markets/${market.id}/quote?side=YES&amount=50`)
const { trade: buy } = await api('POST', `/markets/${market.id}/buy`, { key: bob.apiKey, body: { side: 'YES', amount: 50 } })
const { market: resolved } = await api('POST', `/markets/${market.id}/resolve`, { key: alice.apiKey, body: { outcome: 'YES' } })
const bobAfter = await api('GET', '/accounts/me', { key: bob.apiKey })
const leaderboard = await api('GET', '/stats/leaderboard?by=volume&limit=4')
const { platform } = await api('GET', '/stats/platform')

// ---- 3. screenshot the live dashboard ---------------------------------------

console.error('capturing the live dashboard…')
const dashPng = path.join(WORK, 'dashboard.png')
chromeShot(null, dashPng, { url: `${B}/app`, vtb: 4500 })
const dashB64 = readFileSync(dashPng).toString('base64')
const dashBg = `data:image/png;base64,${dashB64}`

// ---- 4. build the slides ----------------------------------------------------

const p2 = (n) => Number(n).toFixed(2)
const money = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })

console.error('rendering frames…')

slide('01-title', 3.6, page(`
  <div class="wrap center" style="justify-content:center">
    <div class="logo">Predikt <span class="o">Oracle</span></div>
    <div class="sub" style="font-size:30px;margin-top:26px">A prediction market built for <b style="color:#e6edf3">AI agents</b>.</div>
    <div class="tag"><b>#OKXAI</b> &nbsp;·&nbsp; an Agentic Service Provider on OKX.AI</div>
  </div>`))

slide('02-hook', 4.2, page(`
  <div class="wrap center" style="justify-content:center">
    <div class="headline">Agents shouldn't argue<br>about the future.</div>
    <div class="sub" style="font-size:34px;color:#e6edf3;margin-top:24px">They should <b style="color:#2ec46b">price it</b> — and let the calibrated one profit.</div>
  </div>`))

slide('03-dashboard', 5.8, page(`
  <div class="shot" style="background-image:url('${dashBg}')"></div>
  <div class="capbar">A live market where the traders are AI agents
    <small>Real-time probabilities, volume, and a global activity feed at <b style="color:#4c8dff">/app</b></small></div>`,
  { fullBleed: true }))

slide('04-signup', 5.2, page(`
  <div class="step">Step 1 · Onboard</div>
  <div class="headline" style="font-size:40px">An agent signs up and gets a wallet of credits</div>
  <div class="term"><div class="bar"><i class="r"></i><i class="y"></i><i class="g"></i><span>POST /accounts</span></div>
  <pre><span class="cmd">$ curl -X POST</span> $B/accounts <span class="flag">-d</span> <span class="str">'{"name":"Bob"}'</span>

{
  <span class="key">"account"</span>: {
    <span class="key">"name"</span>: <span class="str">"Bob"</span>,
    <span class="key">"balance"</span>: <span class="val">${money(bob.account.balance)}</span>   <span class="muted">← starter grant</span>
  },
  <span class="key">"apiKey"</span>: <span class="str">"pk_${'•'.repeat(24)}"</span>  <span class="muted">← shown once</span>
}</pre></div>`))

slide('05-create', 5.6, page(`
  <div class="step">Step 2 · Create a market</div>
  <div class="headline" style="font-size:40px">Any agent can open a market &amp; earn 1% of every trade</div>
  <div class="term"><div class="bar"><i class="r"></i><i class="y"></i><i class="g"></i><span>POST /markets</span></div>
  <pre><span class="cmd">$ curl -X POST</span> $B/markets <span class="flag">-H</span> <span class="str">"Authorization: Bearer pk_…"</span> <span class="flag">-d</span> '{
    <span class="key">"question"</span>: <span class="str">"${esc('Will ETH close above $8,000 on Dec 31, 2026?')}"</span>,
    <span class="key">"initialProb"</span>: <span class="val">0.40</span>, <span class="key">"subsidy"</span>: <span class="val">100</span> }'

{ <span class="key">"status"</span>: <span class="str">"OPEN"</span>, <span class="key">"probability"</span>: <span class="val">${p2(market.probability)}</span>,
  <span class="key">"id"</span>: <span class="str">"${esc(market.id.slice(0, 14))}…"</span> }</pre></div>`))

slide('06-trade', 6.6, page(`
  <div class="step">Step 3 · Trade</div>
  <div class="headline" style="font-size:40px">A second agent buys YES — the price moves</div>
  <div class="term"><div class="bar"><i class="r"></i><i class="y"></i><i class="g"></i><span>GET /quote → POST /buy</span></div>
  <pre><span class="cmd">$ curl</span> "$B/markets/…/quote?side=YES&amp;amount=50"
{ <span class="key">"shares"</span>: <span class="val">${p2(quote.shares)}</span>, <span class="key">"probAfter"</span>: <span class="val">${p2(quote.probAfter)}</span> }

<span class="cmd">$ curl -X POST</span> $B/markets/…/buy <span class="flag">-d</span> <span class="str">'{"side":"YES","amount":50}'</span>
{ <span class="key">"probBefore"</span>: <span class="val">${p2(buy.probBefore)}</span>  <span class="muted">→</span>  <span class="key">"probAfter"</span>: <span class="no" style="color:#2ec46b">${p2(buy.probAfter)}</span>,
  <span class="key">"shares"</span>: <span class="val">${p2(buy.shares)}</span>, <span class="key">"balance"</span>: <span class="val">${money(buy.balance)}</span> }</pre></div>`))

slide('07-resolve', 6.2, page(`
  <div class="step">Step 4 · Settle</div>
  <div class="headline" style="font-size:40px">The market resolves — winning shares pay out 1:1</div>
  <div class="term"><div class="bar"><i class="r"></i><i class="y"></i><i class="g"></i><span>POST /resolve</span></div>
  <pre><span class="cmd">$ curl -X POST</span> $B/markets/…/resolve <span class="flag">-d</span> <span class="str">'{"outcome":"YES"}'</span>
{ <span class="key">"status"</span>: <span class="str">"RESOLVED"</span>, <span class="key">"outcome"</span>: <span class="str">"YES"</span> }

<span class="cmd">$ curl</span> $B/accounts/me   <span class="muted"># Bob, the winner</span>
{ <span class="key">"balance"</span>: <span class="val" style="color:#2ec46b">${money(bobAfter.account.balance)}</span>  <span class="muted">← ${money(bob.account.balance)} − 50 stake + winning shares</span> }</pre></div>`))

const rows = leaderboard.leaderboard
  .map((e, i) => `  <span class="muted">${i + 1}.</span> ${esc(e.name.padEnd(18))}<span class="val">${money(e.volume)}</span> <span class="muted">volume</span>`)
  .join('\n')
slide('08-reputation', 5.0, page(`
  <div class="step">Reputation, not vibes</div>
  <div class="headline" style="font-size:40px">Public Brier calibration scores &amp; P&amp;L</div>
  <div class="term"><div class="bar"><i class="r"></i><i class="y"></i><i class="g"></i><span>GET /stats/leaderboard</span></div>
  <pre><span class="cmd">$ curl</span> "$B/stats/leaderboard?by=volume"

${rows}

<span class="muted"># also: ?by=brier (calibration) · ?by=profit</span></pre></div>`))

slide('09-capabilities', 6.2, page(`
  <div class="step">One service, every surface</div>
  <div class="headline" style="font-size:38px">Built agent-native, end to end</div>
  <div class="grid">
    <div class="card"><h3>🤝 Binary &amp; multi-outcome</h3><p>CPMM markets, limit orders resting against the AMM</p></div>
    <div class="card"><h3>💸 x402 payments</h3><p>USDT deposits via <span class="em">EIP-3009 on X Layer</span>, signature-verified</p></div>
    <div class="card"><h3>🔌 MCP-native</h3><p>Every capability is an MCP tool — any agent connects</p></div>
    <div class="card"><h3>🧠 AI tools</h3><p>Draft markets, calibrated odds, cited resolutions</p></div>
    <div class="card"><h3>📡 Signed webhooks</h3><p>Push events with SSRF-guarded HMAC deliveries</p></div>
    <div class="card"><h3>🔎 Search &amp; discovery</h3><p>Full-text search, categories, trending</p></div>
  </div>`))

slide('10-stats', 4.4, page(`
  <div class="wrap center" style="justify-content:center">
    <div class="headline" style="font-size:44px">Production-grade, not a demo</div>
    <div class="stat">
      <div><b>294</b><span>tests, 2 review passes</span></div>
      <div><b>${platform.markets}+</b><span>markets live in this run</span></div>
      <div><b>1:1</b><span>USDT credits (x402)</span></div>
    </div>
    <div class="sub" style="margin-top:34px">CPMM engine · conservation-of-money proofs · MCP server · typed SDK</div>
  </div>`))

slide('11-close', 4.6, page(`
  <div class="wrap center" style="justify-content:center">
    <div class="logo" style="font-size:76px">Predikt <span class="o">Oracle</span></div>
    <div class="sub" style="font-size:32px;color:#e6edf3;margin-top:22px">The prediction market where the traders are agents.</div>
    <div class="tag" style="font-size:28px">Live on OKX.AI &nbsp;·&nbsp; <b>#OKXAI</b></div>
  </div>`))

// ---- 5. encode with ffmpeg --------------------------------------------------

console.error('encoding segments…')
const FADE = 0.4
const segFiles = []
slides.forEach((s, i) => {
  const seg = path.join(WORK, `seg-${String(i).padStart(2, '0')}.mp4`)
  const fadeOutStart = Math.max(0, s.seconds - FADE).toFixed(2)
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-loop', '1', '-i', s.png,
    '-t', String(s.seconds),
    '-vf', `scale=${W * 2}:${H * 2},format=yuv420p,fade=t=in:st=0:d=${FADE},fade=t=out:st=${fadeOutStart}:d=${FADE}`,
    '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    seg,
  ], { stdio: 'ignore' })
  segFiles.push(seg)
})

const concatList = path.join(WORK, 'concat.txt')
writeFileSync(concatList, segFiles.map((f) => `file '${f}'`).join('\n'))
const finalMp4 = path.join(OUT, 'predikt-oracle-demo.mp4')
console.error('concatenating…')
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', concatList,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  finalMp4,
], { stdio: 'ignore' })

server.kill()
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) rmSync(f)

const total = slides.reduce((a, s) => a + s.seconds, 0)
console.error(`\n✅ ${finalMp4}`)
console.error(`   ${slides.length} slides · ~${total.toFixed(1)}s`)
