// Tweet (engage): "tag any CA → @krillintel" — left: hook + bullets, right: mock live scan card.
// 1600×900, dark, IBM Plex Mono. Matches krill.live.
import { Resvg } from '@cf-wasm/resvg';
import { readFileSync, writeFileSync } from 'node:fs';

const fontsSrc = readFileSync(new URL('./src/fonts.js', import.meta.url), 'utf8');
const grab = (name) => {
  const m = fontsSrc.match(new RegExp(name + ' = "([^"]+)"'));
  if (!m) throw new Error('font not found: ' + name);
  return new Uint8Array(Buffer.from(m[1], 'base64'));
};
const FONT_REGULAR = grab('REG_B64');
const FONT_BOLD    = grab('BOLD_B64');

const BG   = '#040604', INK  = '#eef5ef', MUTE = '#8a948a',
      DIM  = '#5a645a', LINE = '#1a211a', GREEN = '#4ade80',
      WARN = '#fbbf24', BLUE = '#60a5fa';

const W = 1600, H = 900;
const F = "'IBM Plex Mono'";

// ── mock scan card signal bars ────────────────────────────────────────────────
const MOCK_SIGNALS = [
  ['holder dist',     70,  220],
  ['contract safety', 100, 220],
  ['integrity',       100, 220],
];
let mockBars = '';
let barY = 478;
for (const [label, val, maxW] of MOCK_SIGNALS) {
  const bw = ((val / 100) * maxW).toFixed(1);
  mockBars += `
    <text x="892" y="${barY + 3}" font-size="15" fill="${DIM}" font-family="${F}">${label}</text>
    <rect x="1068" y="${barY - 9}" width="${maxW}" height="8" rx="4" fill="${LINE}"/>
    <rect x="1068" y="${barY - 9}" width="${bw}" height="8" rx="4" fill="${GREEN}"/>
    <text x="1416" y="${barY + 3}" font-size="16" fill="${INK}" text-anchor="end" font-family="${F}">${val}</text>`;
  barY += 46;
}

// ── left bullet rows ───────────────────────────────────────────────────────────
const BULLETS = [
  ['01', GREEN, 'CLARITY SCORE',  '0–100 · deterministic · no vibes'],
  ['02', WARN,  'SAFETY LABEL',   'SAFE · CAUTION · NOT SAFE'],
  ['03', BLUE,  'PLAIN VERDICT',  'in plain English · no jargon'],
];
let bullets = '';
const SPINE_TOP    = 406;
const SPINE_BOTTOM = 564;
let bY = 388;
for (const [n, col, title, sub] of BULLETS) {
  bullets += `
    <circle cx="152" cy="${bY}" r="22" fill="none" stroke="${col}" stroke-width="2"/>
    <text x="152" y="${bY + 7}" font-size="18" font-weight="700" fill="${col}" text-anchor="middle" font-family="${F}">${n}</text>
    <text x="202" y="${bY + 4}" font-size="30" font-weight="700" fill="${INK}" font-family="${F}">${title}</text>
    <text x="202" y="${bY + 36}" font-size="20" fill="${MUTE}" font-family="${F}">${sub}</text>`;
  bY += 102;
}

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glowL" cx="20%" cy="10%" r="60%">
      <stop offset="0%" stop-color="rgba(74,222,128,0.10)"/>
      <stop offset="100%" stop-color="rgba(74,222,128,0)"/>
    </radialGradient>
    <radialGradient id="glowR" cx="88%" cy="50%" r="46%">
      <stop offset="0%" stop-color="rgba(96,165,250,0.09)"/>
      <stop offset="100%" stop-color="rgba(96,165,250,0)"/>
    </radialGradient>
    <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse">
      <path d="M42 0H0V42" fill="none" stroke="rgba(74,222,128,0.032)" stroke-width="1"/>
    </pattern>
  </defs>

  <!-- background -->
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#glowL)"/>
  <rect width="${W}" height="${H}" fill="url(#glowR)"/>

  <!-- section divider (dashed) -->
  <line x1="792" y1="52" x2="792" y2="848" stroke="${LINE}" stroke-width="1" stroke-dasharray="6 10"/>

  <!-- ═══════════════════ LEFT SECTION ═══════════════════ -->

  <!-- brand -->
  <circle cx="112" cy="90" r="9" fill="${GREEN}"/>
  <text x="140" y="100" font-size="30" font-weight="700" fill="${INK}" letter-spacing="6" font-family="${F}">KRILL</text>
  <text x="140" y="130" font-size="16" fill="${DIM}" letter-spacing="3" font-family="${F}">LAUNCH INTELLIGENCE · SCAN</text>

  <!-- hook -->
  <text x="112" y="238" font-size="80" font-weight="700" fill="${INK}" font-family="${F}">tag any CA.</text>
  <text x="112" y="298" font-size="38" fill="${MUTE}" font-family="${F}">I'll scan it live.</text>

  <!-- separator -->
  <line x1="112" y1="334" x2="728" y2="334" stroke="${LINE}" stroke-width="2"/>

  <!-- bullets -->
  ${bullets}

  <!-- vertical spine between bullets -->
  <line x1="152" y1="${SPINE_TOP}" x2="152" y2="${SPINE_BOTTOM}" stroke="${LINE}" stroke-width="2"/>

  <!-- CTA handle -->
  <text x="112" y="728" font-size="54" font-weight="700" fill="${GREEN}" font-family="${F}">@krillintel</text>
  <text x="112" y="768" font-size="21" fill="${DIM}" font-family="${F}">reply to any tweet · drop a CA in the thread</text>

  <!-- footer -->
  <line x1="112" y1="820" x2="728" y2="820" stroke="${LINE}" stroke-width="1"/>
  <text x="112" y="856" font-size="19" fill="${DIM}" font-family="${F}">free · public · on-chain</text>
  <text x="728" y="856" font-size="19" font-weight="700" fill="${MUTE}" text-anchor="end" font-family="${F}">krill.live</text>

  <!-- ═══════════════════ RIGHT SECTION: mock scan card ═══════════════════ -->
  <g transform="rotate(2, 1152, 450)">

    <!-- outer glow shadow -->
    <rect x="852" y="182" width="600" height="536" rx="24" fill="rgba(74,222,128,0.05)"/>

    <!-- card body -->
    <rect x="856" y="186" width="592" height="528" rx="22" fill="#090e09" stroke="#1c241c" stroke-width="1.5"/>

    <!-- card header band -->
    <rect x="856" y="186" width="592" height="74" rx="22" fill="#0d140d"/>
    <rect x="856" y="238" width="592" height="22" fill="#0d140d"/>

    <!-- header content -->
    <circle cx="896" cy="223" r="8" fill="${GREEN}"/>
    <text x="922" y="230" font-size="22" font-weight="700" fill="${INK}" letter-spacing="2" font-family="${F}">KRILL SCAN</text>
    <text x="1416" y="230" font-size="15" fill="${DIM}" text-anchor="end" font-family="${F}">live</text>
    <circle cx="1422" cy="224" r="4" fill="${GREEN}" opacity="0.9"/>

    <!-- contract + symbol -->
    <text x="892" y="292" font-size="13" fill="${DIM}" letter-spacing="2" font-family="${F}">CONTRACT</text>
    <text x="892" y="316" font-size="18" font-weight="700" fill="${MUTE}" font-family="${F}">0x9D08...E7BB · $KRILL</text>

    <!-- separator -->
    <line x1="892" y1="334" x2="1416" y2="334" stroke="${LINE}" stroke-width="1"/>

    <!-- score block -->
    <text x="892" y="368" font-size="14" fill="${DIM}" letter-spacing="1" font-family="${F}">CLARITY</text>
    <text x="1416" y="374" font-size="46" font-weight="700" fill="${GREEN}" text-anchor="end" font-family="${F}">88</text>

    <text x="892" y="398" font-size="13" fill="${DIM}" letter-spacing="1" font-family="${F}">SAFETY</text>
    <text x="1416" y="400" font-size="22" font-weight="700" fill="${GREEN}" text-anchor="end" font-family="${F}">SAFE</text>

    <text x="892" y="426" font-size="13" fill="${DIM}" letter-spacing="1" font-family="${F}">ACTION</text>
    <text x="1416" y="428" font-size="22" font-weight="700" fill="${GREEN}" text-anchor="end" font-family="${F}">PROCEED</text>

    <!-- separator -->
    <line x1="892" y1="446" x2="1416" y2="446" stroke="${LINE}" stroke-width="1"/>

    <!-- signal bars -->
    ${mockBars}

    <!-- separator -->
    <line x1="892" y1="622" x2="1416" y2="622" stroke="${LINE}" stroke-width="1"/>

    <!-- verdict snippet -->
    <text x="892" y="652" font-size="14" fill="${DIM}" font-family="${F}">"Strong contract safety;</text>
    <text x="892" y="673" font-size="14" fill="${DIM}" font-family="${F}"> watch holder distribution."</text>

  </g>
</svg>`;

const resvg = await Resvg.async(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontBuffers: [FONT_REGULAR, FONT_BOLD], defaultFontFamily: 'IBM Plex Mono', loadSystemFonts: false },
});
const png = resvg.render().asPng();
writeFileSync(new URL('../thread-img/tweet-engage.png', import.meta.url), png);
console.log('wrote thread-img/tweet-engage.png', png.length, 'bytes');
