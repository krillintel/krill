// Tweet card: the docs/persona signal-accuracy fix, as a COMPARISON BAR CHART.
// 1600×900 dark.
//
// Third distinct concept in this set, on purpose — gen-tweet-retry.mjs is a state
// table and gen-tweet-retry-track.mjs is a track diagram. Neither fits here: the
// story is a mismatch between two lists of numbers, and bar length is the only
// encoding where "we said 25 and it's actually 0" is visible without reading.
//
// Left column is what the docs advertised, right is what computeScore actually
// weights. Hollow bars are the advertised signals that carry weight 0, so the
// lie is drawn rather than captioned.
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
      RED = '#f87171', BG2 = '#0c120c';

const W = 1600, H = 900;
const SCALE = 5;          // px per weight unit — 40 → 200px, the widest bar
const BAR_H = 15;

// A weight bar. Hollow means "advertised, but weight 0 in the engine" — drawn as
// a dashed outline at the claimed length so the gap between claim and reality is
// the thing you see first.
const bar = (x, y, units, col, hollow = false) => {
  const w = Math.max(units * SCALE, 3);
  if (hollow) {
    return `
  <rect x="${x}" y="${y - BAR_H / 2}" width="${w}" height="${BAR_H}" rx="3"
        fill="none" stroke="${col}" stroke-width="1.5" stroke-opacity="0.65" stroke-dasharray="5 5"/>`;
  }
  return `
  <rect x="${x}" y="${y - BAR_H / 2}" width="${w}" height="${BAR_H}" rx="3" fill="${col}" fill-opacity="0.85"/>`;
};

// One row: name, bar, value. `hollow` marks a claimed-but-unweighted signal.
const row = (labelX, barX, valX, y, label, units, col, hollow = false) => `
  <text x="${labelX}" y="${y + 6}" font-size="19" fill="${hollow ? DIM : INK}">${label}</text>
  ${bar(barX, y, units, col, hollow)}
  <text x="${valX}" y="${y + 7}" font-size="19" font-weight="700" fill="${hollow ? DIM : col}">${hollow ? '0' : units}</text>`;

// Row geometry. Five rows a side, so the two columns end level.
const ROW_Y = [452, 510, 568, 626, 684];

// ── Left: what the docs advertised ──
// Percentages as published. The three hollow ones map to signals the engine
// carries at weight 0; the numbers next to them are what the docs claimed.
const L_LABEL = 112, L_BAR = 366, L_VAL = 586;
const claimed = [
  ['liquidity path',   25, true],
  ['holder shape',     25, false],
  ['social velocity',  20, true],
  ['contract claims',  20, false],
  ['narrative fit',    10, true],
];
const leftRows = claimed.map(([name, pct, hollow], i) => {
  // Claimed percentages get the same SCALE so the two columns are comparable by
  // eye; a hollow bar's length is the claim, and its value reads 0 — the engine's.
  const y = ROW_Y[i];
  return `
  <text x="${L_LABEL}" y="${y + 6}" font-size="19" fill="${hollow ? DIM : INK}">${name}</text>
  ${bar(L_BAR, y, pct, RED, hollow)}
  <text x="${L_VAL}" y="${y + 7}" font-size="19" font-weight="700" fill="${hollow ? DIM : RED}">${pct}%</text>`;
}).join('');

// ── Right: what computeScore actually weights ──
const R_LABEL = 848, R_BAR = 1176, R_VAL = 1396;
const actual = [
  ['holder_distribution', 40],
  ['contract_safety',     40],
  ['contract_integrity',  20],
  ['deployer_reputation', 20],
  ['tax_analysis',        15],
];
const rightRows = actual.map(([name, wt], i) =>
  row(R_LABEL, R_BAR, R_VAL, ROW_Y[i], name, wt, GREEN)).join('');

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="-5%" r="72%">
      <stop offset="0%" stop-color="rgba(74,222,128,0.12)"/>
      <stop offset="58%" stop-color="rgba(74,222,128,0)"/>
    </radialGradient>
    <radialGradient id="glowRed" cx="14%" cy="62%" r="34%">
      <stop offset="0%" stop-color="rgba(248,113,113,0.10)"/>
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
    <text x="140" y="148" font-size="17" fill="${DIM}" letter-spacing="3">LAUNCH INTELLIGENCE · SCORING MODEL</text>
  </g>

  <!-- hook -->
  <g font-family="'IBM Plex Mono'">
    <text x="112" y="248" font-size="52" font-weight="700" fill="${INK}">We documented a scoring model</text>
    <text x="112" y="308" font-size="52" font-weight="700" fill="${INK}">the engine <tspan fill="${RED}">never implemented.</tspan></text>
  </g>

  <!-- column headers -->
  <g font-family="'IBM Plex Mono'">
    <text x="${L_LABEL}" y="390" font-size="18" font-weight="700" fill="${RED}" letter-spacing="3">WHAT THE DOCS SAID</text>
    <line x1="${L_LABEL}" y1="410" x2="700" y2="410" stroke="${LINE}" stroke-width="2"/>
    <text x="${R_LABEL}" y="390" font-size="18" font-weight="700" fill="${GREEN}" letter-spacing="3">WHAT THE ENGINE WEIGHTS</text>
    <line x1="${R_LABEL}" y1="410" x2="1488" y2="410" stroke="${LINE}" stroke-width="2"/>
  </g>

  <!-- rows -->
  <g font-family="'IBM Plex Mono'">${leftRows}${rightRows}</g>

  <!-- vertical split between the two claims -->
  <line x1="774" y1="376" x2="774" y2="712" stroke="${LINE}" stroke-width="2"/>

  <!-- the read -->
  <g font-family="'IBM Plex Mono'">
    <text x="112" y="762" font-size="20" fill="${MUTE}">Dashed = advertised, but weight <tspan fill="${RED}" font-weight="700">0</tspan> in the engine. The two signals that carry the most weight weren't listed at all.</text>
  </g>

  <!-- footer -->
  <g font-family="'IBM Plex Mono'">
    <line x1="112" y1="800" x2="1488" y2="800" stroke="${LINE}" stroke-width="2"/>
    <text x="112" y="846" font-size="21" fill="${MUTE}">Weights are relative, not percentages — the score normalizes over what was actually measured.</text>
    <text x="1488" y="846" font-size="24" font-weight="700" fill="${GREEN}" text-anchor="end">krill.live</text>
  </g>
</svg>`;

const r = await Resvg.async(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontBuffers: [FONT_REGULAR, FONT_BOLD], defaultFontFamily: 'IBM Plex Mono' },
});
const png = r.render().asPng();
writeFileSync(new URL('../thread-img/tweet-signals.png', import.meta.url), png);
console.log('wrote thread-img/tweet-signals.png', png.length, 'bytes');
