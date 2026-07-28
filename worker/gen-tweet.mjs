// One-off: render the "honest scanner" concept card for the launch tweet.
// Uses the SAME resvg + IBM Plex Mono fonts as the live /card.png route so
// typography/colours match krill.live exactly.
import { Resvg } from '@cf-wasm/resvg';
import { readFileSync, writeFileSync } from 'node:fs';

// Pull the embedded base64 fonts straight out of the worker source.
const fontsSrc = readFileSync(new URL('./src/fonts.js', import.meta.url), 'utf8');
const grab = (name) => {
  const m = fontsSrc.match(new RegExp(name + ' = "([^"]+)"'));
  if (!m) throw new Error('font not found: ' + name);
  const bin = Buffer.from(m[1], 'base64');
  return new Uint8Array(bin);
};
const FONT_REGULAR = grab('REG_B64');
const FONT_BOLD = grab('BOLD_B64');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Palette — mirrored from css/landing.css :root
const BG = '#040604', BG2 = '#0a0f0a', INK = '#eef5ef', MUTE = '#8a948a',
      DIM = '#5a645a', LINE = '#1a211a', GREEN = '#4ade80', GREEN_DEEP = '#16a34a';

const W = 1600, H = 900;

// ring geometry for the 83 clarity dial
const cx = 1200, cy = 300, rad = 150, stroke = 22;
const circ = 2 * Math.PI * rad;
const pct = 83 / 100;
const dash = `${(circ * pct).toFixed(1)} ${(circ * (1 - pct)).toFixed(1)}`;

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="-5%" r="70%">
      <stop offset="0%" stop-color="rgba(74,222,128,0.16)"/>
      <stop offset="55%" stop-color="rgba(74,222,128,0)"/>
    </radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${GREEN}"/>
      <stop offset="100%" stop-color="${GREEN_DEEP}"/>
    </linearGradient>
    <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse">
      <path d="M42 0H0V42" fill="none" stroke="rgba(74,222,128,0.045)" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="${LINE}" stroke-width="2" rx="0"/>

  <!-- brand row -->
  <g font-family="'IBM Plex Mono'">
    <circle cx="112" cy="104" r="9" fill="${GREEN}"/>
    <text x="140" y="114" font-size="34" font-weight="700" fill="${INK}" letter-spacing="6">KRILL</text>
    <text x="140" y="150" font-size="19" fill="${DIM}" letter-spacing="3">LAUNCH INTELLIGENCE</text>
  </g>

  <!-- headline -->
  <g font-family="'IBM Plex Mono'">
    <text x="112" y="330" font-size="54" font-weight="700" fill="${INK}">most scanners hype</text>
    <text x="112" y="398" font-size="54" font-weight="700" fill="${INK}">whatever pays them.</text>

    <text x="112" y="486" font-size="30" fill="${MUTE}">KRILL scores every launch on the</text>
    <text x="112" y="528" font-size="30" fill="${MUTE}">same engine —</text>
    <text x="500" y="528" font-size="30" font-weight="700" fill="${GREEN}">including $KRILL itself.</text>

    <text x="112" y="606" font-size="26" fill="${DIM}">no fake numbers. signals without a</text>
    <text x="112" y="642" font-size="26" fill="${DIM}">source say</text>
    <text x="290" y="642" font-size="26" fill="${MUTE}">"no data yet."</text>
  </g>

  <!-- clarity dial (right) -->
  <g>
    <circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="${LINE}" stroke-width="${stroke}"/>
    <circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="url(#ring)" stroke-width="${stroke}"
            stroke-linecap="round" stroke-dasharray="${dash}"
            transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy + 6}" font-family="'IBM Plex Mono'" font-size="96" font-weight="700"
          fill="${INK}" text-anchor="middle">83</text>
    <text x="${cx}" y="${cy + 54}" font-family="'IBM Plex Mono'" font-size="20" fill="${DIM}"
          text-anchor="middle" letter-spacing="3">CLARITY 0–100</text>
  </g>
  <text x="${cx}" y="${cy + 200}" font-family="'IBM Plex Mono'" font-size="26" font-weight="700"
        fill="${GREEN}" text-anchor="middle" letter-spacing="2">✓ SAFE · READABLE</text>

  <!-- tagline + url -->
  <g font-family="'IBM Plex Mono'">
    <text x="112" y="806" font-size="30" font-weight="700" fill="${INK}">clarity before conviction.</text>
    <text x="${W - 112}" y="806" font-size="30" font-weight="700" fill="${GREEN}" text-anchor="end">krill.live</text>
  </g>
  <line x1="112" y1="732" x2="${W - 112}" y2="732" stroke="${LINE}" stroke-width="2"/>
</svg>`;

const r = await Resvg.async(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontBuffers: [FONT_REGULAR, FONT_BOLD], defaultFontFamily: 'IBM Plex Mono' },
});
const png = r.render().asPng();

writeFileSync(new URL('../thread-img/tweet-honest.png', import.meta.url), png);
console.log('wrote thread-img/tweet-honest.png', png.length, 'bytes');
