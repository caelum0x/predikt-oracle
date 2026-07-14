// Viral-style launch videos for the X (#OKXAI) participation post.
//
// Text-first, fast-cut, silent — the format X autoplays well. Big bold
// typography with motion (slow zoom), hard cuts, accent-colored keywords.
// Produces three cuts:
//   predikt-launch-hype.mp4   (~32s) — the "we shipped it" launch energy
//   predikt-use-case.mp4      (~30s) — a concrete two-agent scenario
//   predikt-build-story.mp4   (~38s) — the build process (encouraged by the brief)
//
// Usage:  node submission/make-launch-videos.mjs

import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'submission', 'demo-video')
const WORK = path.join(OUT, 'launch-frames')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const W = 1280, H = 720

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

const CSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  :root{--bg:#070b12;--ink:#f2f7fc;--dim:#8aa0b8;--acc:#4c8dff;--yes:#2ee27a;--no:#ff5470;--gold:#ffcc4d;--vio:#a970ff}
  html,body{width:${W}px;height:${H}px;color:var(--ink);overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;
    background:radial-gradient(1100px 700px at 50% 8%,var(--glow,#16264a) 0%,rgba(7,11,18,0) 62%),var(--bg)}
  .stage{width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;
    align-items:center;text-align:center;padding:0 90px}
  .kick{font-size:26px;font-weight:800;letter-spacing:5px;text-transform:uppercase;color:var(--acc);margin-bottom:26px}
  .big{font-size:96px;font-weight:900;line-height:1.02;letter-spacing:-2.5px}
  .huge{font-size:150px;font-weight:900;letter-spacing:-4px;line-height:.95}
  .mid{font-size:60px;font-weight:800;line-height:1.1;letter-spacing:-1px}
  .sub{font-size:34px;color:var(--dim);font-weight:600;margin-top:28px;line-height:1.35}
  em{font-style:normal;background:linear-gradient(100deg,var(--acc),var(--vio));-webkit-background-clip:text;background-clip:text;color:transparent}
  .yes{color:var(--yes)} .no{color:var(--no)} .gold{color:var(--gold)} .acc{color:var(--acc)}
  .chips{display:flex;flex-wrap:wrap;gap:16px 18px;justify-content:center;max-width:1040px;margin-top:12px}
  .chip{font-size:32px;font-weight:800;padding:16px 26px;border-radius:999px;background:#111b2c;border:1px solid #24344e}
  .chip.on{background:linear-gradient(100deg,var(--acc),var(--vio));border:0;color:#08101f}
  .punch{width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center}
  .brandline{position:absolute;bottom:52px;left:0;right:0;text-align:center;font-size:28px;font-weight:800;color:var(--dim)}
  .brandline b{color:var(--acc)}
  .dialog{text-align:left;max-width:1000px}
  .dialog .row{font-size:52px;font-weight:800;margin:10px 0;line-height:1.15}
  .dialog .a{color:var(--yes)} .dialog .b{color:var(--no)} .dialog .who{color:var(--dim);font-weight:700}
  .tick{color:var(--yes);font-weight:900}
  .logo{font-size:110px;font-weight:900;letter-spacing:-4px}.logo .o{color:var(--acc)}
`
const page = (glow, inner, brand = true) =>
  `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
   <div style="--glow:${glow};width:100%;height:100%">${inner}${brand ? '<div class="brandline">Predikt <b>Oracle</b> · #OKXAI</div>' : ''}</div>`

const stage = (glow, html, brand) => page(glow, `<div class="stage">${html}</div>`, brand)
const punch = (glow, bg, html) => page(glow, `<div class="punch" style="background:${bg}">${html}</div>`, false)

// ---- render + encode helpers ------------------------------------------------

let idc = 0
function frame(html) {
  const id = `s${String(idc++).padStart(3, '0')}`
  const hp = path.join(WORK, `${id}.html`), pp = path.join(WORK, `${id}.png`)
  writeFileSync(hp, html)
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    '--force-device-scale-factor=2', `--window-size=${W},${H}`, `--screenshot=${pp}`, `file://${hp}`], { stdio: 'ignore' })
  return pp
}

// Encode a single slide to a motion clip (slow zoom) of `dur` seconds.
function clip(png, dur, dir = 'in') {
  const out = png.replace('.png', '.mp4')
  const frames = Math.round(dur * 30)
  const z = dir === 'in'
    ? `min(zoom+0.0012,1.14)`
    : `if(eq(on,1),1.14,max(zoom-0.0012,1.0))`
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', png, '-t', dur.toFixed(3),
    '-vf', `scale=${W * 2}:${H * 2},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W * 2}x${H * 2}:fps=30,format=yuv420p,fade=t=in:st=0:d=0.12,fade=t=out:st=${Math.max(0, dur - 0.12).toFixed(2)}:d=0.12`,
    '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', out], { stdio: 'ignore' })
  return out
}

function build(name, slides) {
  console.error(`rendering ${name} (${slides.length} slides)…`)
  const clips = slides.map((s, i) => clip(frame(s.html), s.sec, i % 2 ? 'out' : 'in'))
  const list = path.join(WORK, `${name}.txt`)
  writeFileSync(list, clips.map((c) => `file '${c}'`).join('\n'))
  const mp4 = path.join(OUT, `${name}.mp4`)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'ignore' })
  const total = slides.reduce((a, s) => a + s.sec, 0)
  console.error(`  ✅ ${mp4}  (~${total.toFixed(1)}s)`)
}

const G_BLUE = '#16264a', G_GREEN = '#0f3324', G_GOLD = '#3a2f10', G_VIO = '#241542'

// ---- 1. LAUNCH HYPE ---------------------------------------------------------

build('predikt-launch-hype', [
  { sec: 1.8, html: stage(G_BLUE, `<div class="logo">🔮</div>`, false) },
  { sec: 2.2, html: stage(G_BLUE, `<div class="big">We built a<br><em>prediction market</em></div>`) },
  { sec: 2.4, html: stage(G_VIO, `<div class="big">where the traders<br>are <em>AI agents</em>.</div>`) },
  { sec: 1.5, html: punch(G_GREEN, 'linear-gradient(120deg,#0f3324,#07130d)', `<div class="huge yes">Not a<br>chatbot.</div>`) },
  { sec: 1.6, html: punch(G_BLUE, 'linear-gradient(120deg,#12243f,#080f1a)', `<div class="huge">A <span class="acc">real</span><br>market.</div>`) },
  { sec: 2.6, html: stage(G_BLUE, `<div class="mid">Agents <span class="acc">create</span> markets.<br>Agents <span class="gold">trade</span> probabilities.<br>Agents <span class="yes">get paid</span>.</div>`) },
  { sec: 2.4, html: stage(G_GOLD, `<div class="kick">Under the hood</div><div class="chips">
      <span class="chip on">CPMM engine</span><span class="chip">x402 payments</span>
      <span class="chip on">MCP-native</span><span class="chip">limit orders</span>
      <span class="chip">Brier reputation</span><span class="chip on">signed webhooks</span></div>`) },
  { sec: 1.4, html: punch(G_GREEN, 'linear-gradient(120deg,#0f3324,#07130d)', `<div class="huge yes">294</div><div class="mid" style="margin-top:6px">tests. all green.</div>`) },
  { sec: 2.2, html: stage(G_VIO, `<div class="big">Deposit <span class="gold">USDT</span> via <em>x402</em><div class="sub">EIP-3009 on X Layer · settled per call</div></div>`) },
  { sec: 2.4, html: stage(G_BLUE, `<div class="logo">Predikt <span class="o">Oracle</span></div><div class="sub" style="font-size:38px;color:#f2f7fc">Live on <span class="acc">OKX.AI</span></div>`, false) },
  { sec: 2.0, html: punch(G_BLUE, 'linear-gradient(120deg,#12243f,#080f1a)', `<div class="huge"><em>#OKXAI</em></div>`) },
])

// ---- 2. USE CASE ------------------------------------------------------------

build('predikt-use-case', [
  { sec: 2.2, html: stage(G_BLUE, `<div class="big">Two AI agents.<br>One <em>question</em>.</div>`) },
  { sec: 2.6, html: stage(G_BLUE, `<div class="dialog">
      <div class="row"><span class="who">Agent A:</span> "ETH hits $8k." <span class="a">70%</span></div>
      <div class="row"><span class="who">Agent B:</span> "No way." <span class="b">30%</span></div></div>`) },
  { sec: 1.6, html: punch(G_VIO, 'linear-gradient(120deg,#241542,#0a0713)', `<div class="huge">They don't<br><span class="no">argue</span>.</div>`) },
  { sec: 2.0, html: stage(G_GREEN, `<div class="big">They open a<br><em>market</em>.</div>`) },
  { sec: 2.2, html: stage(G_BLUE, `<div class="mid">Each trades its belief.<br>The AMM <span class="gold">finds the price</span>.</div>`) },
  { sec: 1.8, html: punch(G_GREEN, 'linear-gradient(120deg,#0f3324,#07130d)', `<div class="huge yes">62%</div><div class="mid" style="margin-top:6px">the market's answer</div>`) },
  { sec: 2.6, html: stage(G_GOLD, `<div class="mid">When it resolves,<br>the <span class="yes">calibrated</span> agent <span class="gold">profits</span>.</div>`) },
  { sec: 2.2, html: stage(G_BLUE, `<div class="big">Reputation you<br><em>earn</em>, not claim.</div><div class="sub">public Brier calibration scores</div>`) },
  { sec: 2.4, html: stage(G_VIO, `<div class="logo">Predikt <span class="o">Oracle</span></div><div class="sub" style="font-size:34px">The market where the traders are agents.</div>`, false) },
  { sec: 1.8, html: punch(G_BLUE, 'linear-gradient(120deg,#12243f,#080f1a)', `<div class="huge"><em>#OKXAI</em></div>`) },
])

// ---- 3. BUILD STORY ---------------------------------------------------------

build('predikt-build-story', [
  { sec: 2.0, html: stage(G_BLUE, `<div class="kick">Build log</div><div class="big">How we built an<br><em>ASP</em> in days</div>`) },
  { sec: 2.2, html: stage(G_BLUE, `<div class="mid">Started from a<br>Polymarket-style stack.</div>`) },
  { sec: 2.0, html: punch(G_VIO, 'linear-gradient(120deg,#241542,#0a0713)', `<div class="huge">Rebuilt it<br><em>agent-native</em>.</div>`) },
  { sec: 2.2, html: stage(G_GREEN, `<div class="mid">A <span class="yes">CPMM engine</span>. Pure math.<br><span class="dim" style="color:#8aa0b8">k = yes^p · no^(1-p)</span></div>`) },
  { sec: 2.2, html: stage(G_GOLD, `<div class="mid"><span class="gold">x402</span> payments on X Layer.<br>A native <span class="acc">MCP</span> server.</div>`) },
  { sec: 2.2, html: stage(G_BLUE, `<div class="big">Then we let<br><em>AI agents</em> review it.</div>`) },
  { sec: 1.8, html: punch(G_BLUE, 'linear-gradient(120deg,#12243f,#080f1a)', `<div class="huge acc">2</div><div class="mid" style="margin-top:6px">adversarial security passes</div>`) },
  { sec: 2.4, html: stage(G_GREEN, `<div class="dialog">
      <div class="row"><span class="tick">✓</span> caught a <span class="no">money-mint</span> bug on CANCEL</div>
      <div class="row"><span class="tick">✓</span> caught an <span class="no">SSRF</span> hole in webhooks</div>
      <div class="row"><span class="tick">✓</span> both <span class="yes">fixed</span>, with regression tests</div></div>`) },
  { sec: 1.5, html: punch(G_GREEN, 'linear-gradient(120deg,#0f3324,#07130d)', `<div class="huge yes">294</div><div class="mid" style="margin-top:6px">tests. all green.</div>`) },
  { sec: 2.4, html: stage(G_BLUE, `<div class="logo">Predikt <span class="o">Oracle</span></div><div class="sub" style="font-size:34px">Built for the OKX.AI Genesis Hackathon</div>`, false) },
  { sec: 1.8, html: punch(G_VIO, 'linear-gradient(120deg,#241542,#0a0713)', `<div class="huge"><em>#OKXAI</em></div>`) },
])

console.error('\n✅ launch pack done')
