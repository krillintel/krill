// Tweet card: new GET /api/deliveries feature — "did the alert actually land?"
// Shows a delivery log with a 500 that used to read as success. 1600×900 dark.
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

// Mock delivery log: [token, result, status, latency, note, colour]
const entries = [
  ['$XRUG',  'FAILED',    '500', '412ms', 'receiver errored — alert lost', RED],
  ['$LNCH',  'FAILED',    '—',   '—',     'connection refused',            RED],
  ['$KRILL', 'DELIVERED', '200', '88ms',  'landed',                        GREEN],
  ['$NOVA',  'DELIVERED', '200', '71ms',  'landed',                        GREEN],
];

let rows = '';
let ry = 366;
for (const [sym, result, status, ms, note, col] of entries) {
  const bad = result === 'FAILED';
  const rowBg = bad ? 'rgba(248,113,113,0.06)' : 'rgba(74,222,128,0.03)';
  rows += `
    <rect x="112" y="${ry - 36}" width="1376" height="68" rx="6" fill="${rowBg}"/>
    <text x="148" y="${ry}" font-size="28" font-weight="700" fill="${INK}">${sym}</text>
    <rect x="410" y="${ry - 28}" width="176" height="38" rx="6" fill="${col}" opacity="0.15"/>
    <text x="498" y="${ry}" font-size="20" font-weight="700" fill="${col}" text-anchor="middle">${result}</text>
    <text x="640" y="${ry}" font-size="26" font-weight="700" fill="${col}">${status}</text>
    <text x="756" y="${ry}" font-size="22" fill="${DIM}">${ms}</text>
    <text x="900" y="${ry}" font-size="22" fill="${bad ? RED : MUTE}">${note}</text>
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
    <text x="140" y="148" font-size="17" fill="${DIM}" letter-spacing="3">LAUNCH INTELLIGENCE · ALERT DELIVERY</text>
  </g>

  <!-- hook -->
  <g font-family="'IBM Plex Mono'">
    <text x="112" y="254" font-size="54" font-weight="700" fill="${INK}">An alert you never got</text>
    <text x="112" y="316" font-size="54" font-weight="700" fill="${INK}">isn't <tspan fill="${RED}">silence.</tspan> It's a <tspan fill="${RED}">miss.</tspan></text>
  </g>

  <!-- column headers -->
  <g font-family="'IBM Plex Mono'">
    <text x="148" y="358" font-size="16" fill="${DIM}" letter-spacing="3">TOKEN</text>
    <text x="410" y="358" font-size="16" fill="${DIM}" letter-spacing="3">RESULT</text>
    <text x="640" y="358" font-size="16" fill="${DIM}" letter-spacing="3">HTTP</text>
    <text x="756" y="358" font-size="16" fill="${DIM}" letter-spacing="3">TOOK</text>
    <text x="900" y="358" font-size="16" fill="${DIM}" letter-spacing="3">DETAIL</text>
    <line x1="112" y1="374" x2="1488" y2="374" stroke="${LINE}" stroke-width="2"/>
  </g>

  <!-- rows -->
  <g font-family="'IBM Plex Mono'">${rows}
  </g>

  <!-- before/after -->
  <g font-family="'IBM Plex Mono'">
    <rect x="112" y="700" width="672" height="76" rx="6" fill="rgba(248,113,113,0.05)" stroke="rgba(248,113,113,0.2)" stroke-width="1"/>
    <text x="140" y="730" font-size="17" fill="${DIM}" letter-spacing="3">BEFORE</text>
    <text x="140" y="760" font-size="22" fill="${RED}">HTTP 500 counted as delivered</text>

    <rect x="816" y="700" width="672" height="76" rx="6" fill="rgba(74,222,128,0.05)" stroke="rgba(74,222,128,0.2)" stroke-width="1"/>
    <text x="844" y="730" font-size="17" fill="${DIM}" letter-spacing="3">AFTER</text>
    <text x="844" y="760" font-size="22" fill="${GREEN}">only 2xx counts as delivered</text>
  </g>

  <!-- footer -->
  <g font-family="'IBM Plex Mono'">
    <line x1="112" y1="806" x2="1488" y2="806" stroke="${LINE}" stroke-width="2"/>
    <text x="112" y="852" font-size="22" fill="${GREEN}">GET</text>
    <text x="172" y="852" font-size="22" fill="${MUTE}">krill.live/api/deliveries</text>
    <text x="1488" y="852" font-size="24" font-weight="700" fill="${GREEN}" text-anchor="end">krill.live</text>
  </g>
</svg>`;

const r = await Resvg.async(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontBuffers: [FONT_REGULAR, FONT_BOLD], defaultFontFamily: 'IBM Plex Mono' },
});
const png = r.render().asPng();
writeFileSync(new URL('../thread-img/tweet-delivery.png', import.meta.url), png);
console.log('wrote thread-img/tweet-delivery.png', png.length, 'bytes');
