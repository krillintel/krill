// Tweet (timeline): the stealth-rug timeline — a token that passed the gate at
// hour 0 and turned at hour 5, with KRILL's webhook firing on the flip.
// Concept: one horizontal spine, four checkpoints, colour tells the story.
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
      WARN = '#fbbf24', RED  = '#f87171';

const W = 1600, H = 900;
const F = "'IBM Plex Mono'";

// Timeline checkpoints: [x, hour, action, colour, headline, detail]
const MARKS = [
  [ 250, 'HOUR 0',  'PROCEED', GREEN, 'gate passed',      'clean read \u00b7 you buy'],
  [ 560, 'HOUR 2',  'PROCEED', GREEN, 'still clean',      'nothing moved'],
  [ 870, 'HOUR 5',  'STOP',    RED,   'sell tax \u2192 60%', 'owner came back'],
  [1180, 'HOUR 5',  'ALERT',   WARN,  'webhook fired',    'you already knew'],
];

const SPINE_Y = 470;

let marks = '';
for (const [x, hour, action, col, head, detail] of MARKS) {
  const isStop = action === 'STOP';
  marks += `
    <line x1="${x}" y1="${SPINE_Y - 96}" x2="${x}" y2="${SPINE_Y - 26}" stroke="${col}" stroke-width="2" opacity="0.32"/>
    <circle cx="${x}" cy="${SPINE_Y}" r="${isStop ? 27 : 21}" fill="${BG}" stroke="${col}" stroke-width="${isStop ? 4 : 3}"/>
    <circle cx="${x}" cy="${SPINE_Y}" r="${isStop ? 9 : 7}" fill="${col}"/>
    <text x="${x}" y="${SPINE_Y - 116}" font-size="26" font-weight="700" fill="${col}" text-anchor="middle" font-family="${F}">${action}</text>
    <text x="${x}" y="${SPINE_Y - 148}" font-size="17" fill="${DIM}" text-anchor="middle" letter-spacing="2" font-family="${F}">${hour}</text>
    <text x="${x}" y="${SPINE_Y + 78}" font-size="27" font-weight="700" fill="${INK}" text-anchor="middle" font-family="${F}">${head}</text>
    <text x="${x}" y="${SPINE_Y + 112}" font-size="19" fill="${MUTE}" text-anchor="middle" font-family="${F}">${detail}</text>`;
}

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="spine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="${GREEN}"/>
      <stop offset="42%"  stop-color="${GREEN}"/>
      <stop offset="58%"  stop-color="${RED}"/>
      <stop offset="100%" stop-color="${WARN}"/>
    </linearGradient>
    <radialGradient id="glowG" cx="14%" cy="52%" r="42%">
      <stop offset="0%"   stop-color="rgba(74,222,128,0.11)"/>
      <stop offset="100%" stop-color="rgba(74,222,128,0)"/>
    </radialGradient>
    <radialGradient id="glowR" cx="58%" cy="52%" r="40%">
      <stop offset="0%"   stop-color="rgba(248,113,113,0.15)"/>
      <stop offset="100%" stop-color="rgba(248,113,113,0)"/>
    </radialGradient>
    <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse">
      <path d="M42 0H0V42" fill="none" stroke="rgba(74,222,128,0.03)" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#glowG)"/>
  <rect width="${W}" height="${H}" fill="url(#glowR)"/>

  <!-- brand -->
  <circle cx="112" cy="92" r="9" fill="${GREEN}"/>
  <text x="140" y="102" font-size="30" font-weight="700" fill="${INK}" letter-spacing="6" font-family="${F}">KRILL</text>
  <text x="140" y="132" font-size="16" fill="${DIM}" letter-spacing="3" font-family="${F}">LAUNCH INTELLIGENCE \u00b7 WATCH</text>

  <!-- hook -->
  <text x="112" y="232" font-size="60" font-weight="700" fill="${INK}" font-family="${F}">The rug didn't happen at launch.</text>
  <text x="112" y="296" font-size="60" font-weight="700" fill="${MUTE}" font-family="${F}">It happened at <tspan fill="${RED}">hour 5.</tspan></text>

  <!-- timeline spine -->
  <line x1="180" y1="${SPINE_Y}" x2="1420" y2="${SPINE_Y}" stroke="url(#spine)" stroke-width="4" opacity="0.85"/>

  <!-- checkpoints -->
  ${marks}

  <!-- the point -->
  <line x1="112" y1="704" x2="1488" y2="704" stroke="${LINE}" stroke-width="2"/>
  <text x="112" y="756" font-size="30" font-weight="700" fill="${INK}" font-family="${F}">A one-time check would have missed all of it.</text>
  <text x="112" y="800" font-size="22" fill="${MUTE}" font-family="${F}">KRILL re-scores every watched token on a schedule and fires the second a verdict flips.</text>

  <!-- footer -->
  <text x="112" y="856" font-size="21" font-weight="700" fill="${GREEN}" font-family="${F}">@krillintel</text>
  <text x="1488" y="856" font-size="21" font-weight="700" fill="${MUTE}" text-anchor="end" font-family="${F}">krill.live</text>
</svg>`;

const resvg = await Resvg.async(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontBuffers: [FONT_REGULAR, FONT_BOLD], defaultFontFamily: 'IBM Plex Mono', loadSystemFonts: false },
});
const png = resvg.render().asPng();
writeFileSync(new URL('../thread-img/tweet-timeline.png', import.meta.url), png);
console.log('wrote thread-img/tweet-timeline.png', png.length, 'bytes');
