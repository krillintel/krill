// Tweet (yap): rant-style card — "stop trusting one-time 'safe' checks".
// Big hook + yap bullet points. 1600×900, dark, IBM Plex Mono. Matches krill.live.
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
      WARN = '#fbbf24', RED = '#f87171';

const W = 1600, H = 900;

// yap points: [marker, marker-color, text, sub]
const points = [
  ['01', RED,   'a rug checker scans once', 'then calls it "safe" forever'],
  ['02', WARN,  'the owner comes back later', 'flips sell tax to 60% at hour 5'],
  ['03', GREEN, 'KRILL never stops watching', 'pings you the second it flips'],
];

let rows = '';
let y = 430;
for (const [n, col, txt, sub] of points) {
  rows += `
    <circle cx="140" cy="${y - 10}" r="26" fill="none" stroke="${col}" stroke-width="2"/>
    <text x="140" y="${y}" font-size="24" font-weight="700" fill="${col}" text-anchor="middle">${n}</text>
    <text x="200" y="${y - 2}" font-size="34" font-weight="700" fill="${INK}">${txt}</text>
    <text x="200" y="${y + 36}" font-size="22" fill="${MUTE}">${sub}</text>`;
  y += 130;
}

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="-5%" r="72%">
      <stop offset="0%" stop-color="rgba(74,222,128,0.13)"/>
      <stop offset="58%" stop-color="rgba(74,222,128,0)"/>
    </radialGradient>
    <radialGradient id="glowRed" cx="88%" cy="18%" r="34%">
      <stop offset="0%" stop-color="rgba(248,113,113,0.16)"/>
      <stop offset="70%" stop-color="rgba(248,113,113,0)"/>
    </radialGradient>
    <linearGradient id="spine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${RED}"/>
      <stop offset="55%" stop-color="${WARN}"/>
      <stop offset="100%" stop-color="${GREEN}"/>
    </linearGradient>
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
    <text x="140" y="148" font-size="17" fill="${DIM}" letter-spacing="3">LAUNCH INTELLIGENCE · WATCH</text>
  </g>

  <!-- hook -->
  <g font-family="'IBM Plex Mono'">
    <text x="112" y="270" font-size="62" font-weight="700" fill="${INK}">"Safe" is not a</text>
    <text x="112" y="340" font-size="62" font-weight="700" fill="${INK}">one-time <tspan fill="${GREEN}">screenshot.</tspan></text>
  </g>

  <!-- vertical spine connecting the yap points -->
  <line x1="140" y1="418" x2="140" y2="672" stroke="url(#spine)" stroke-width="3" opacity="0.55"/>

  <!-- yap points -->
  <g font-family="'IBM Plex Mono'">${rows}
  </g>

  <!-- footer -->
  <g font-family="'IBM Plex Mono'">
    <line x1="112" y1="778" x2="1488" y2="778" stroke="${LINE}" stroke-width="2"/>
    <text x="112" y="828" font-size="22" fill="${MUTE}">the gate is one moment. the rug isn't. 🦐</text>
    <text x="1488" y="828" font-size="24" font-weight="700" fill="${GREEN}" text-anchor="end">krill.live</text>
  </g>
</svg>`;

const r = await Resvg.async(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontBuffers: [FONT_REGULAR, FONT_BOLD], defaultFontFamily: 'IBM Plex Mono' },
});
const png = r.render().asPng();

writeFileSync(new URL('../thread-img/tweet-yap.png', import.meta.url), png);
console.log('wrote thread-img/tweet-yap.png', png.length, 'bytes');
