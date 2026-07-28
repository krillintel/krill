// Tweet 2: "cuts through it" — shows clarity card with noise/signal contrast.
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
      WARN = '#fbbf24';

const W = 1600, H = 900;

// Left side: "noise" — hype messages fading/struck through
// Right side: clarity card (mini version of the real scan result)

const cx = 1150, cy = 340, rad = 130, stroke = 18;
const circ = 2 * Math.PI * rad;
const pct = 83 / 100;
const dash = `${(circ * pct).toFixed(1)} ${(circ * (1 - pct)).toFixed(1)}`;

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="0%" r="65%">
      <stop offset="0%" stop-color="rgba(74,222,128,0.14)"/>
      <stop offset="60%" stop-color="rgba(74,222,128,0)"/>
    </radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${GREEN}"/>
      <stop offset="100%" stop-color="${GREEN_DEEP}"/>
    </linearGradient>
    <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse">
      <path d="M42 0H0V42" fill="none" stroke="rgba(74,222,128,0.035)" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- divider line (vertical, subtle) -->
  <line x1="800" y1="180" x2="800" y2="720" stroke="${LINE}" stroke-width="2"/>

  <!-- LEFT: noise/hype messages -->
  <g font-family="'IBM Plex Mono'">
    <text x="120" y="140" font-size="26" font-weight="700" fill="${DIM}" letter-spacing="2">NOISE</text>
    
    <!-- struck-through hype -->
    <text x="120" y="260" font-size="28" fill="${DIM}" opacity="0.6">"100/100 SUPER SAFE 🚀"</text>
    <line x1="120" y1="248" x2="620" y2="248" stroke="${DIM}" stroke-width="2" opacity="0.5"/>
    
    <text x="120" y="340" font-size="28" fill="${DIM}" opacity="0.5">"LFG MOON IMMINENT 🔥"</text>
    <line x1="120" y1="328" x2="580" y2="328" stroke="${DIM}" stroke-width="2" opacity="0.4"/>
    
    <text x="120" y="420" font-size="28" fill="${DIM}" opacity="0.4">"TRUST ME BRO"</text>
    <line x1="120" y1="408" x2="440" y2="408" stroke="${DIM}" stroke-width="2" opacity="0.3"/>
    
    <text x="120" y="500" font-size="28" fill="${DIM}" opacity="0.3">"98/100 LEGIT"</text>
    <line x1="120" y1="488" x2="400" y2="488" stroke="${DIM}" stroke-width="2" opacity="0.3"/>

    <text x="120" y="620" font-size="24" fill="${MUTE}" opacity="0.7">same CA → rug in 3 hours</text>
  </g>

  <!-- RIGHT: clarity signal -->
  <g font-family="'IBM Plex Mono'">
    <text x="860" y="140" font-size="26" font-weight="700" fill="${GREEN}" letter-spacing="2">CLARITY</text>
    
    <!-- mini card -->
    <rect x="860" y="180" width="660" height="520" fill="${BG2}" stroke="${LINE}" stroke-width="2" rx="8"/>
    
    <!-- dial (centered top) -->
    <circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="${LINE}" stroke-width="${stroke}"/>
    <circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="url(#ring)" stroke-width="${stroke}"
            stroke-linecap="round" stroke-dasharray="${dash}"
            transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy + 8}" font-size="86" font-weight="700" fill="${INK}" text-anchor="middle">83</text>
    <text x="${cx}" y="${cy + 48}" font-size="18" fill="${DIM}" text-anchor="middle" letter-spacing="2">CLARITY</text>
    
    <!-- verdict (left column under dial) -->
    <text x="900" y="530" font-size="32" font-weight="700" fill="${INK}">$KRILL</text>
    <text x="900" y="570" font-size="20" fill="${GREEN}">✓ SAFE · READABLE</text>
    
    <!-- signals (compact 2-col layout) -->
    <text x="900" y="620" font-size="17" fill="${MUTE}">holder 70 · safety 100 · integrity 75</text>
    
    <text x="900" y="655" font-size="16" fill="${DIM}">same engine. no exceptions.</text>
    
    <text x="1420" y="670" font-size="20" font-weight="700" fill="${GREEN}" text-anchor="end">krill.live</text>
  </g>

  <!-- bottom brand -->
  <g font-family="'IBM Plex Mono'">
    <circle cx="80" cy="830" r="7" fill="${GREEN}"/>
    <text x="100" y="838" font-size="24" font-weight="700" fill="${INK}" letter-spacing="4">KRILL</text>
    <text x="240" y="838" font-size="20" fill="${DIM}">clarity before conviction</text>
  </g>
</svg>`;

const r = await Resvg.async(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontBuffers: [FONT_REGULAR, FONT_BOLD], defaultFontFamily: 'IBM Plex Mono' },
});
const png = r.render().asPng();

writeFileSync(new URL('../thread-img/tweet-cuts.png', import.meta.url), png);
console.log('wrote thread-img/tweet-cuts.png', png.length, 'bytes');
