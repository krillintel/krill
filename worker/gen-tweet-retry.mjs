// Tweet card: webhook retry + dead-letter — "a receiver down for 60s shouldn't
// cost you the alert". Shows the four delivery states. 1600×900 dark.
import { Resvg } from '@cf-wasm/resvg';
import { readFileSync, writeFileSync } from 'node:fs';

const fontsSrc = readFileSync(new URL('./src/fonts.js', import.meta.url), 'utf8');
const grab = (name) => {
  const m = fontsSrc.match(new RegExp(name + ' = "([^"]+)"'));
  if (!m) throw new Error('font not found: ' + name);
  return new Uint8Array(Buffer.from(m[1], 'base64'));
};
const FONT_REGULAR = grab('REG_B64');
const FONT_BOLD   = grab('BOLD_B64');

const BG = '#040604', INK = '#eef5ef', MUTE = '#8a948a',
      DIM = '#5a645a', LINE = '#1a211a', GREEN = '#4ade80',
      WARN = '#fbbf24', RED = '#f87171', BG2 = '#0c120c';

const W = 1600, H = 900;

// Delivery states: [token, state, attempts, http, detail, colour]
const entries = [
  ['$XRUG',  'DELIVERED', '3/4', '200', 'landed on retry 2 — alert saved', GREEN],
  ['$LNCH',  'PENDING',   '2/4', '503', 'receiver down — queued for replay', WARN],
  ['$MOON',  'DEAD',      '4/4', '503', 'gave up after the cap',            RED],
  ['$STALE', 'PERMANENT', '1/4', '404', 'wrong URL — retrying can’t fix it', RED],
];

let rows = '';
let ry = 372;
for (const [sym, state, att, http, detail, col] of entries) {
  const good = state === 'DELIVERED';
  const rowBg = good ? 'rgba(74,222,128,0.05)'
    : state === 'PENDING' ? 'rgba(251,191,36,0.05)' : 'rgba(248,113,113,0.05)';
  rows += `
    <rect x="112" y="${ry - 36}" width="1376" height="68" rx="6" fill="${rowBg}"/>
    <text x="148" y="${ry}" font-size="27" font-weight="700" fill="${INK}">${sym}</text>
    <rect x="404" y="${ry - 28}" width="188" height="38" rx="6" fill="${col}" opacity="0.15"/>
    <text x="498" y="${ry}" font-size="19" font-weight="700" fill="${col}" text-anchor="middle">${state}</text>
    <text x="648" y="${ry}" font-size="24" fill="${MUTE}">${att}</text>
    <text x="760" y="${ry}" font-size="24" font-weight="700" fill="${col}">${http}</text>
    <text x="884" y="${ry}" font-size="21" fill="${good ? MUTE : col}">${detail}</text>
    <line x1="112" y1="${ry + 32}" x2="1488" y2="${ry + 32}" stroke="${LINE}" stroke-width="1"/>`;
  ry += 78;
}

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="-5%" r="72%">
      <stop offset="0%" stop-color="rgba(74,222,128,0.12)"/>
      <stop offset="58%" stop-color="rgba(74,222,128,0)"/>
    </radialGradient>
    <radialGradient id="glowWarn" cx="92%" cy="22%" r="30%">
      <stop offset="0%" stop-color="rgba(251,191,36,0.12)"/>
      <stop offset="70%" stop-color="rgba(251,191,36,0)"/>
    </radialGradient>
    <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse">
      <path d="M42 0H0V42" fill="none" stroke="rgba(74,222,128,0.035)" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#glowWarn)"/>

  <!-- brand -->
  <g font-family="'IBM Plex Mono'">
    <circle cx="112" cy="104" r="9" fill="${GREEN}"/>
    <text x="140" y="114" font-size="30" font-weight="700" fill="${INK}" letter-spacing="6">KRILL</text>
    <text x="140" y="148" font-size="17" fill="${DIM}" letter-spacing="3">LAUNCH INTELLIGENCE · ALERT RETRY</text>
  </g>

  <!-- hook -->
  <g font-family="'IBM Plex Mono'">
    <text x="112" y="254" font-size="52" font-weight="700" fill="${INK}">A receiver down for 60s</text>
    <text x="112" y="316" font-size="52" font-weight="700" fill="${INK}">shouldn't cost you <tspan fill="${GREEN}">the alert.</tspan></text>
  </g>

  <!-- column headers -->
  <g font-family="'IBM Plex Mono'">
    <text x="148" y="364" font-size="15" fill="${DIM}" letter-spacing="3">TOKEN</text>
    <text x="404" y="364" font-size="15" fill="${DIM}" letter-spacing="3">STATE</text>
    <text x="648" y="364" font-size="15" fill="${DIM}" letter-spacing="3">TRIES</text>
    <text x="760" y="364" font-size="15" fill="${DIM}" letter-spacing="3">HTTP</text>
    <text x="884" y="364" font-size="15" fill="${DIM}" letter-spacing="3">DETAIL</text>
    <line x1="112" y1="380" x2="1488" y2="380" stroke="${LINE}" stroke-width="2"/>
  </g>

  <!-- rows -->
  <g font-family="'IBM Plex Mono'">${rows}
  </g>

  <!-- the rule -->
  <g font-family="'IBM Plex Mono'">
    <rect x="112" y="700" width="672" height="78" rx="6" fill="rgba(74,222,128,0.05)" stroke="rgba(74,222,128,0.2)" stroke-width="1"/>
    <text x="140" y="730" font-size="16" fill="${DIM}" letter-spacing="3">RETRY</text>
    <text x="140" y="762" font-size="21" fill="${GREEN}">5xx · 429 · 408 · no reply at all</text>

    <rect x="816" y="700" width="672" height="78" rx="6" fill="rgba(248,113,113,0.05)" stroke="rgba(248,113,113,0.2)" stroke-width="1"/>
    <text x="844" y="730" font-size="16" fill="${DIM}" letter-spacing="3">DON'T</text>
    <text x="844" y="762" font-size="21" fill="${RED}">404 · 401 · 410 — the request is the problem</text>
  </g>

  <!-- footer -->
  <g font-family="'IBM Plex Mono'">
    <line x1="112" y1="808" x2="1488" y2="808" stroke="${LINE}" stroke-width="2"/>
    <text x="112" y="854" font-size="22" fill="${GREEN}">GET</text>
    <text x="172" y="854" font-size="22" fill="${MUTE}">krill.live/api/deliveries</text>
    <text x="1488" y="854" font-size="24" font-weight="700" fill="${GREEN}" text-anchor="end">krill.live</text>
  </g>
</svg>`;

const r = await Resvg.async(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontBuffers: [FONT_REGULAR, FONT_BOLD], defaultFontFamily: 'IBM Plex Mono' },
});
const png = r.render().asPng();
writeFileSync(new URL('../thread-img/tweet-retry.png', import.meta.url), png);
console.log('wrote thread-img/tweet-retry.png', png.length, 'bytes');
