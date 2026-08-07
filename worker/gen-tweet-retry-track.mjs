// Tweet card (alt concept): retry as a TRACK diagram, not a table. Two lanes
// diverging from the same event — a transient failure that gets replayed until it
// lands, and a permanent rejection whose track just ends. 1600×900 dark.
//
// Deliberately a different visual concept from gen-tweet-retry.mjs (which is a
// state table): the point of this feature is the divergence, and a journey reads
// that in one glance where rows don't.
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
const R = 34;             // node radius
const ORIGIN_X = 152;     // the flip event marker

// A station on the track: circle with an HTTP code, caption underneath.
const node = (x, y, label, col, caption, filled = false) => `
  <circle cx="${x}" cy="${y}" r="${R}" fill="${filled ? col : BG2}" stroke="${col}" stroke-width="2" ${filled ? 'fill-opacity="0.18"' : ''}/>
  <text x="${x}" y="${y + 8}" font-size="21" font-weight="700" fill="${col}" text-anchor="middle">${label}</text>
  <text x="${x}" y="${y + 66}" font-size="16" fill="${DIM}" text-anchor="middle">${caption}</text>`;

// Connector with a labelled pill in the gap — a railway hop, not an arrow.
const hop = (x1, x2, y, label, col) => {
  const mid = (x1 + x2) / 2;
  const pw = 152, ph = 34;
  return `
  <line x1="${x1 + R}" y1="${y}" x2="${mid - pw / 2 - 12}" y2="${y}" stroke="${col}" stroke-width="2" stroke-opacity="0.45"/>
  <rect x="${mid - pw / 2}" y="${y - ph / 2}" width="${pw}" height="${ph}" rx="17" fill="${BG2}" stroke="${col}" stroke-width="1" stroke-opacity="0.5"/>
  <text x="${mid}" y="${y + 6}" font-size="16" font-weight="700" fill="${col}" text-anchor="middle" letter-spacing="1">${label}</text>
  <line x1="${mid + pw / 2 + 12}" y1="${y}" x2="${x2 - R}" y2="${y}" stroke="${col}" stroke-width="2" stroke-opacity="0.45"/>`;
};

// The event both lanes start from. Caption sits on the same baseline as the node
// captions (y + 66) so the row of labels reads as one line.
const originMark = (y) => `
  <rect x="${ORIGIN_X - 15}" y="${y - 15}" width="30" height="30" rx="4" fill="${INK}" fill-opacity="0.9"/>
  <text x="${ORIGIN_X}" y="${y + 66}" font-size="16" fill="${DIM}" text-anchor="middle">flip</text>`;

// ── Lane 1: transient failure, replayed until it lands ──
const y1 = 452;
const a1 = 372, a2 = 700, a3 = 1028;
const lane1 = `
  ${originMark(y1)}
  <line x1="${ORIGIN_X + 15}" y1="${y1}" x2="${a1 - R}" y2="${y1}" stroke="${GREEN}" stroke-width="2" stroke-opacity="0.45"/>
  ${node(a1, y1, '503', GREEN, 't+0')}
  ${hop(a1, a2, y1, 'REPLAY', GREEN)}
  ${node(a2, y1, '503', GREEN, 't+5m')}
  ${hop(a2, a3, y1, 'REPLAY', GREEN)}
  ${node(a3, y1, '200', GREEN, 't+10m', true)}
  <line x1="${a3 + R}" y1="${y1}" x2="1140" y2="${y1}" stroke="${GREEN}" stroke-width="2" stroke-opacity="0.45"/>
  <text x="1164" y="${y1 - 4}" font-size="30" font-weight="700" fill="${GREEN}">DELIVERED</text>
  <text x="1164" y="${y1 + 28}" font-size="19" fill="${MUTE}">alert survived</text>`;

// ── Lane 2: permanent rejection, the track simply ends ──
const y2 = 682;
const stopX = 596;
const lane2 = `
  ${originMark(y2)}
  <line x1="${ORIGIN_X + 15}" y1="${y2}" x2="${a1 - R}" y2="${y2}" stroke="${RED}" stroke-width="2" stroke-opacity="0.45"/>
  ${node(a1, y2, '404', RED, 't+0')}
  <line x1="${a1 + R}" y1="${y2}" x2="${stopX - 14}" y2="${y2}" stroke="${RED}" stroke-width="2" stroke-opacity="0.35" stroke-dasharray="7 9"/>
  <!-- buffer stop: the line terminates, nothing continues past it -->
  <line x1="${stopX}" y1="${y2 - 30}" x2="${stopX}" y2="${y2 + 30}" stroke="${RED}" stroke-width="6"/>
  <text x="${stopX + 34}" y="${y2 - 4}" font-size="30" font-weight="700" fill="${RED}">NO REPLAY</text>
  <text x="${stopX + 34}" y="${y2 + 28}" font-size="19" fill="${MUTE}">the request is the problem — a retry changes nothing</text>`;

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="-5%" r="72%">
      <stop offset="0%" stop-color="rgba(74,222,128,0.12)"/>
      <stop offset="58%" stop-color="rgba(74,222,128,0)"/>
    </radialGradient>
    <radialGradient id="glowRed" cx="18%" cy="88%" r="34%">
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
    <text x="140" y="148" font-size="17" fill="${DIM}" letter-spacing="3">LAUNCH INTELLIGENCE · ALERT RETRY</text>
  </g>

  <!-- hook -->
  <g font-family="'IBM Plex Mono'">
    <text x="112" y="248" font-size="52" font-weight="700" fill="${INK}">Two failures.</text>
    <text x="112" y="308" font-size="52" font-weight="700" fill="${INK}">Only one deserves <tspan fill="${GREEN}">a retry.</tspan></text>
  </g>

  <!-- lane 1 -->
  <g font-family="'IBM Plex Mono'">
    <text x="112" y="372" font-size="17" fill="${GREEN}" letter-spacing="3" font-weight="700">TRANSIENT</text>
    <text x="268" y="372" font-size="17" fill="${DIM}" letter-spacing="2">5xx · 429 · 408 · no reply at all</text>
    ${lane1}
  </g>

  <!-- divider -->
  <line x1="112" y1="576" x2="1488" y2="576" stroke="${LINE}" stroke-width="2"/>

  <!-- lane 2 -->
  <g font-family="'IBM Plex Mono'">
    <text x="112" y="606" font-size="17" fill="${RED}" letter-spacing="3" font-weight="700">PERMANENT</text>
    <text x="268" y="606" font-size="17" fill="${DIM}" letter-spacing="2">404 · 401 · 410</text>
    ${lane2}
  </g>

  <!-- footer -->
  <g font-family="'IBM Plex Mono'">
    <line x1="112" y1="800" x2="1488" y2="800" stroke="${LINE}" stroke-width="2"/>
    <text x="112" y="846" font-size="21" fill="${MUTE}">Retries cap out. A receiver that stays down goes dead-letter, not hammered forever.</text>
    <text x="1488" y="846" font-size="24" font-weight="700" fill="${GREEN}" text-anchor="end">krill.live</text>
  </g>
</svg>`;

const r = await Resvg.async(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontBuffers: [FONT_REGULAR, FONT_BOLD], defaultFontFamily: 'IBM Plex Mono' },
});
const png = r.render().asPng();
writeFileSync(new URL('../thread-img/tweet-retry-track.png', import.meta.url), png);
console.log('wrote thread-img/tweet-retry-track.png', png.length, 'bytes');
