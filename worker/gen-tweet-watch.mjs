// Tweet (krill-watch): the gate is one moment, the rug isn't.
// Timeline card — SAFE at buy, verdict flips later, KRILL fires an alert.
// 1600×900, dark bg, IBM Plex Mono, palette from web.
import { Resvg } from '@cf-wasm/resvg';
import { readFileSync, writeFileSync } from 'node:fs';

const fontsSrc = readFileSync(new URL('./src/fonts.js', import.meta.url), 'utf8');
const grab = (name) => {
  const m = fontsSrc.match(new RegExp(name + ' = "([^"]+)"'));
  if (!m) throw new Error('font not found: ' + name);
  return new Uint8Array(Buffer.from(m[1], 'base64'));
};
const FONT_REGULAR = grab('REG_B64');
const FONT_BOLD = grab('BOLD_B64');

const BG = '#040604', BG2 = '#0a0f0a', INK = '#eef5ef', MUTE = '#8a948a',
      DIM = '#5a645a', LINE = '#1a211a', GREEN = '#4ade80', GREEN_DEEP = '#16a34a',
      WARN = '#fbbf24', RED = '#f87171', RED_DEEP = '#b91c1c';

const W = 1600, H = 900;

// Timeline geometry
const trackY = 470;
const x0 = 180;   // buy
const x1 = 560;   // +2h clean
const x2 = 940;   // +5h owner reappears
const x3 = 1320;  // ALERT flip
const nodeR = 14;

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="0%" r="70%">
      <stop offset="0%" stop-color="rgba(74,222,128,0.12)"/>
      <stop offset="60%" stop-color="rgba(74,222,128,0)"/>
    </radialGradient>
    <radialGradient id="glowRed" cx="82%" cy="52%" r="30%">
      <stop offset="0%" stop-color="rgba(248,113,113,0.18)"/>
      <stop offset="70%" stop-color="rgba(248,113,113,0)"/>
    </radialGradient>
    <linearGradient id="track" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${GREEN}"/>
      <stop offset="55%" stop-color="${GREEN_DEEP}"/>
      <stop offset="78%" stop-color="${WARN}"/>
      <stop offset="100%" stop-color="${RED}"/>
    </linearGradient>
    <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse">
      <path d="M42 0H0V42" fill="none" stroke="rgba(74,222,128,0.035)" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#glowRed)"/>

  <!-- headline -->
  <g font-family="'IBM Plex Mono'">
    <text x="120" y="150" font-size="30" font-weight="700" fill="${DIM}" letter-spacing="3">KRILL · WATCH</text>
    <text x="120" y="230" font-size="58" font-weight="700" fill="${INK}">The gate is one moment.</text>
    <text x="120" y="300" font-size="58" font-weight="700" fill="${RED}">The rug isn't.</text>
  </g>

  <!-- timeline track -->
  <line x1="${x0}" y1="${trackY}" x2="${x3}" y2="${trackY}" stroke="url(#track)" stroke-width="6" stroke-linecap="round"/>

  <!-- node: buy / SAFE -->
  <g font-family="'IBM Plex Mono'">
    <circle cx="${x0}" cy="${trackY}" r="${nodeR}" fill="${GREEN}"/>
    <circle cx="${x0}" cy="${trackY}" r="${nodeR + 8}" fill="none" stroke="${GREEN}" stroke-width="2" opacity="0.35"/>
    <text x="${x0}" y="${trackY - 44}" font-size="22" font-weight="700" fill="${GREEN}" text-anchor="middle">✓ SAFE</text>
    <text x="${x0}" y="${trackY + 56}" font-size="20" fill="${MUTE}" text-anchor="middle">you buy</text>
    <text x="${x0}" y="${trackY + 84}" font-size="16" fill="${DIM}" text-anchor="middle">t0 · score 83</text>
  </g>

  <!-- node: +2h clean -->
  <g font-family="'IBM Plex Mono'">
    <circle cx="${x1}" cy="${trackY}" r="10" fill="${GREEN_DEEP}"/>
    <text x="${x1}" y="${trackY + 56}" font-size="18" fill="${DIM}" text-anchor="middle">+2h · still clean</text>
  </g>

  <!-- node: +5h owner reappears -->
  <g font-family="'IBM Plex Mono'">
    <circle cx="${x2}" cy="${trackY}" r="11" fill="${WARN}"/>
    <text x="${x2}" y="${trackY - 40}" font-size="19" font-weight="700" fill="${WARN}" text-anchor="middle">⚠ ownership back</text>
    <text x="${x2}" y="${trackY + 56}" font-size="18" fill="${DIM}" text-anchor="middle">+5h · sell tax → 60%</text>
  </g>

  <!-- node: ALERT flip -->
  <g font-family="'IBM Plex Mono'">
    <circle cx="${x3}" cy="${trackY}" r="${nodeR}" fill="${RED}"/>
    <circle cx="${x3}" cy="${trackY}" r="${nodeR + 8}" fill="none" stroke="${RED}" stroke-width="2" opacity="0.4"/>
    <text x="${x3}" y="${trackY - 44}" font-size="22" font-weight="700" fill="${RED}" text-anchor="middle">✕ DANGER</text>
    <text x="${x3}" y="${trackY + 56}" font-size="20" fill="${RED}" text-anchor="middle" font-weight="700">alert fired</text>
    <text x="${x3}" y="${trackY + 84}" font-size="16" fill="${DIM}" text-anchor="middle">verdict flip → webhook</text>
  </g>

  <!-- alert chip -->
  <g font-family="'IBM Plex Mono'">
    <rect x="1050" y="600" width="470" height="118" rx="10" fill="${BG2}" stroke="${RED_DEEP}" stroke-width="2"/>
    <circle cx="1085" cy="640" r="6" fill="${RED}"/>
    <text x="1105" y="647" font-size="19" font-weight="700" fill="${RED}" letter-spacing="1">VERDICT CHANGE</text>
    <text x="1075" y="683" font-size="17" fill="${INK}">SAFE → DANGER · sell tax 60%</text>
    <text x="1075" y="708" font-size="15" fill="${DIM}">POST /api/watch · alert on flip</text>
  </g>

  <!-- left explainer -->
  <g font-family="'IBM Plex Mono'">
    <text x="120" y="640" font-size="26" fill="${INK}">A one-time gate can't stop a rug</text>
    <text x="120" y="678" font-size="26" fill="${INK}">that happens <tspan fill="${RED}" font-weight="700">after</tspan> you buy.</text>
    <text x="120" y="726" font-size="21" fill="${MUTE}">KRILL keeps watching &amp; pings you the second it turns.</text>
  </g>

  <!-- bottom brand -->
  <g font-family="'IBM Plex Mono'">
    <circle cx="80" cy="835" r="7" fill="${GREEN}"/>
    <text x="100" y="843" font-size="24" font-weight="700" fill="${INK}" letter-spacing="4">KRILL</text>
    <text x="240" y="843" font-size="20" fill="${DIM}">clarity before conviction</text>
    <text x="1520" y="843" font-size="22" font-weight="700" fill="${GREEN}" text-anchor="end">krill.live</text>
  </g>
</svg>`;

const r = await Resvg.async(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontBuffers: [FONT_REGULAR, FONT_BOLD], defaultFontFamily: 'IBM Plex Mono' },
});
const png = r.render().asPng();

writeFileSync(new URL('../thread-img/tweet-watch.png', import.meta.url), png);
console.log('wrote thread-img/tweet-watch.png', png.length, 'bytes');
