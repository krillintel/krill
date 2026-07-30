// Tweet (audit): "we audited our own gate — it scored unknown as clean".
// Before/after comparison card. 1600×900, dark, IBM Plex Mono. Matches krill.live.
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

const BG = '#040604', INK = '#eef5ef', MUTE = '#8a948a',
      DIM = '#5a645a', LINE = '#1a211a', GREEN = '#4ade80',
      WARN = '#fbbf24', RED = '#f87171';

const W = 1600, H = 900;

// [what we couldn't read, what the gate used to claim, what it says now]
const rows = [
  ['top holder %', 'scored 0% — "no whale"', 'not measured'],
  ['owner drain flags', 'scored as "clean"', 'not assessed'],
  ['sell tax', 'scored 0% — "no tax"', 'not reported'],
];

const X_LABEL = 112, X_OLD = 620, X_NEW = 1130;
let body = '';
let y = 476;
for (const [label, was, now] of rows) {
  body += `
    <text x="${X_LABEL}" y="${y}" font-size="30" font-weight="700" fill="${INK}">${label}</text>
    <text x="${X_OLD}" y="${y}" font-size="26" fill="${RED}">${was}</text>
    <text x="${X_NEW}" y="${y}" font-size="26" fill="${GREEN}">${now}</text>
    <line x1="${X_LABEL}" y1="${y + 26}" x2="1488" y2="${y + 26}" stroke="${LINE}" stroke-width="1"/>`;
  y += 78;
}

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="-5%" r="72%">
      <stop offset="0%" stop-color="rgba(74,222,128,0.13)"/>
      <stop offset="58%" stop-color="rgba(74,222,128,0)"/>
    </radialGradient>
    <radialGradient id="glowRed" cx="88%" cy="16%" r="32%">
      <stop offset="0%" stop-color="rgba(248,113,113,0.15)"/>
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
    <text x="140" y="148" font-size="17" fill="${DIM}" letter-spacing="3">LAUNCH INTELLIGENCE · SELF-AUDIT</text>
  </g>

  <!-- hook -->
  <g font-family="'IBM Plex Mono'">
    <text x="112" y="268" font-size="58" font-weight="700" fill="${INK}">We audited our own gate.</text>
    <text x="112" y="336" font-size="58" font-weight="700" fill="${INK}">It scored <tspan fill="${RED}">unknown</tspan> as <tspan fill="${RED}">clean.</tspan></text>
  </g>

  <!-- column headers -->
  <g font-family="'IBM Plex Mono'">
    <text x="${X_LABEL}" y="410" font-size="17" fill="${DIM}" letter-spacing="3">WHAT IT COULDN'T READ</text>
    <text x="${X_OLD}" y="410" font-size="17" fill="${DIM}" letter-spacing="3">WHAT IT CLAIMED</text>
    <text x="${X_NEW}" y="410" font-size="17" fill="${DIM}" letter-spacing="3">WHAT IT SAYS NOW</text>
    <line x1="${X_LABEL}" y1="432" x2="1488" y2="432" stroke="${LINE}" stroke-width="2"/>
  </g>

  <!-- rows -->
  <g font-family="'IBM Plex Mono'">${body}
  </g>

  <!-- verdict flip -->
  <g font-family="'IBM Plex Mono'">
    <rect x="${X_LABEL}" y="702" width="440" height="72" rx="8" fill="none" stroke="${RED}" stroke-width="2" opacity="0.7"/>
    <text x="${X_LABEL + 24}" y="731" font-size="15" fill="${DIM}" letter-spacing="2">SAME TOKEN, BEFORE</text>
    <text x="${X_LABEL + 24}" y="759" font-size="26" font-weight="700" fill="${RED}">100/100 · SAFE · PROCEED</text>

    <text x="608" y="748" font-size="34" fill="${WARN}">→</text>

    <rect x="672" y="702" width="440" height="72" rx="8" fill="none" stroke="${GREEN}" stroke-width="2" opacity="0.7"/>
    <text x="696" y="731" font-size="15" fill="${DIM}" letter-spacing="2">SAME TOKEN, AFTER</text>
    <text x="696" y="759" font-size="26" font-weight="700" fill="${GREEN}">CAUTION · DO NOT PROCEED</text>
  </g>

  <!-- footer -->
  <g font-family="'IBM Plex Mono'">
    <line x1="112" y1="806" x2="1488" y2="806" stroke="${LINE}" stroke-width="2"/>
    <text x="112" y="852" font-size="22" fill="${MUTE}">a gate that guesses isn't a gate. 181 tests say unknown stays unknown. 🦐</text>
    <text x="1488" y="852" font-size="24" font-weight="700" fill="${GREEN}" text-anchor="end">krill.live</text>
  </g>
</svg>`;

const r = await Resvg.async(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontBuffers: [FONT_REGULAR, FONT_BOLD], defaultFontFamily: 'IBM Plex Mono' },
});
const png = r.render().asPng();

writeFileSync(new URL('../thread-img/tweet-audit.png', import.meta.url), png);
console.log('wrote thread-img/tweet-audit.png', png.length, 'bytes');
