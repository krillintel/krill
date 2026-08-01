// Tweet card: new GET /api/watchlist feature — "one call, full portfolio status".
// Shows a mock watchlist with mixed verdicts + a drift alert. 1600×900 dark.
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

// Mock watchlist entries: [symbol, score, safety/action, color, note]
const entries = [
  ['$NOVA',  92, 'PROCEED',  GREEN, 'clean read · 92/100'],
  ['$KRILL', 75, 'CAUTION',  WARN,  'GoPlus shell · watching'],
  ['$LNCH',  58, 'CAUTION',  WARN,  'tax modifiable · high risk'],
  ['$XRUG',  12, 'STOP',     RED,   '⚠ DRIFT — was PROCEED 4h ago'],
];

let rows = '';
let ry = 366;
for (const [sym, score, action, col, note] of entries) {
  const isDrift = note.startsWith('⚠');
  const rowBg = isDrift ? 'rgba(248,113,113,0.06)' : 'rgba(74,222,128,0.03)';
  rows += `
    <rect x="112" y="${ry - 36}" width="1376" height="68" rx="6" fill="${rowBg}"/>
    <text x="148" y="${ry}" font-size="28" font-weight="700" fill="${INK}">${sym}</text>
    <text x="440" y="${ry}" font-size="26" fill="${col}" font-weight="700">${score}/100</text>
    <rect x="570" y="${ry - 28}" width="152" height="38" rx="6" fill="${col}" opacity="0.15"/>
    <text x="646" y="${ry}" font-size="20" font-weight="700" fill="${col}" text-anchor="middle">${action}</text>
    <text x="760" y="${ry}" font-size="22" fill="${isDrift ? RED : MUTE}">${note}</text>
    <line x1="112" y1="${ry + 32}" x2="1488" y2="${ry + 32}" stroke="${LINE}" stroke-width="1"/>`;
  ry += 80;
}

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="-5%" r="72%">
      <stop offset="0%" stop-color="rgba(74,222,128,0.12)"/>
      <stop offset="58%" stop-color="rgba(74,222,128,0)"/>
    </radialGradient>
    <radialGradient id="glowRed" cx="92%" cy="20%" r="30%">
      <stop offset="0%" stop-color="rgba(248,113,113,0.14)"/>
      <stop offset="70%" stop-color="rgba(248,113,113,0)"/>
    </radialGradient>
    <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse">
      <path d="M42 0H0V42" fill="none" stroke="rgba(74,222,128,0.035)" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#glowRed)"/>

  <!-- brand -->
  <g font-family="'IBM Plex Mono'">
    <circle cx="112" cy="104" r="9" fill="${GREEN}"/>
    <text x="140" y="114" font-size="30" font-weight="700" fill="${INK}" letter-spacing="6">KRILL</text>
    <text x="140" y="148" font-size="17" fill="${DIM}" letter-spacing="3">LAUNCH INTELLIGENCE · WATCHLIST</text>
  </g>

  <!-- hook -->
  <g font-family="'IBM Plex Mono'">
    <text x="112" y="254" font-size="54" font-weight="700" fill="${INK}">Every token you're watching.</text>
    <text x="112" y="316" font-size="54" font-weight="700" fill="${INK}">One call. <tspan fill="${GREEN}">Live verdicts.</tspan></text>
  </g>

  <!-- column headers -->
  <g font-family="'IBM Plex Mono'">
    <text x="148" y="358" font-size="16" fill="${DIM}" letter-spacing="3">TOKEN</text>
    <text x="440" y="358" font-size="16" fill="${DIM}" letter-spacing="3">SCORE</text>
    <text x="570" y="358" font-size="16" fill="${DIM}" letter-spacing="3">ACTION</text>
    <text x="760" y="358" font-size="16" fill="${DIM}" letter-spacing="3">STATUS</text>
    <line x1="112" y1="374" x2="1488" y2="374" stroke="${LINE}" stroke-width="2"/>
  </g>

  <!-- rows -->
  <g font-family="'IBM Plex Mono'">${rows}
  </g>

  <!-- api call hint -->
  <g font-family="'IBM Plex Mono'">
    <rect x="112" y="720" width="680" height="52" rx="6" fill="${BG2}" stroke="${LINE}" stroke-width="1"/>
    <text x="140" y="753" font-size="22" fill="${GREEN}">GET</text>
    <text x="200" y="753" font-size="22" fill="${MUTE}">krill.live/api/watchlist</text>
    <text x="840" y="753" font-size="22" fill="${DIM}">POST /api/watch { token } to add</text>
  </g>

  <!-- footer -->
  <g font-family="'IBM Plex Mono'">
    <line x1="112" y1="806" x2="1488" y2="806" stroke="${LINE}" stroke-width="2"/>
    <text x="112" y="852" font-size="22" fill="${MUTE}">drifted: true means the live verdict flipped since the last checkpoint. 🦐</text>
    <text x="1488" y="852" font-size="24" font-weight="700" fill="${GREEN}" text-anchor="end">krill.live</text>
  </g>
</svg>`;

const r = await Resvg.async(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontBuffers: [FONT_REGULAR, FONT_BOLD], defaultFontFamily: 'IBM Plex Mono' },
});
const png = r.render().asPng();
writeFileSync(new URL('../thread-img/tweet-watchlist.png', import.meta.url), png);
console.log('wrote thread-img/tweet-watchlist.png', png.length, 'bytes');
