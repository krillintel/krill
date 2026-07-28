(function () {
  'use strict';

  // ── DOM ──
  const $ = id => document.getElementById(id);
  const out = $('output');
  const cmd = $('cmd');

  // ── State ──
  const hist = [];
  let hIdx = -1;
  const state = { mode: 'SIGNAL' };
  let watcher = null;
  let stopPolling = null;
  const BOX_W = 48;

  /* ── background canvas (subtle grid) ── */
  (function initBg() {
    const c = $('bg');
    if (!c) return;
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    function resize() {
      c.width = window.innerWidth * dpr;
      c.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }
    function draw() {
      const W = window.innerWidth, H = window.innerHeight;
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.015)';
      ctx.lineWidth = 0.5;
      for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    }
    resize();
    window.addEventListener('resize', resize);
  })();

  /* ── output helpers ── */
  function p(html) {
    const d = document.createElement('div');
    d.className = 'l';
    d.innerHTML = html || '';
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
    out.appendChild(d);
    if (atBottom) out.scrollTop = out.scrollHeight;
  }

  function blank() { p(''); }

  function typeLines(lines, speed, cb) {
    let i = 0;
    (function next() {
      if (i < lines.length) { p(lines[i]); i++; setTimeout(next, speed); }
      else if (cb) cb();
    })();
  }

  /* ── format helpers ── */
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function pad(s, n) { return String(s).padEnd(n); }
  function rpad(s, n) { return String(s).padStart(n); }
  function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  function fmtNum(v, digits = 4, fallback = 0) { return num(v, fallback).toFixed(digits); }
  function fmtToken(v) { return num(v).toLocaleString(); }

  function bar(value, max, width, color) {
    const filled = Math.max(0, Math.round((value / max) * width));
    return `<span style="color:${color}">${'█'.repeat(filled)}</span><span class="dd">${'░'.repeat(Math.max(0, width - filled))}</span>`;
  }

  /* ── render helpers ── */
  function boxTop(title) {
    const inner = `─ ${title} `;
    return `  <span class="d">╭${inner}${'─'.repeat(BOX_W - 2 - inner.length)}╮</span>`;
  }
  function boxBottom() { return `  <span class="d">╰${'─'.repeat(BOX_W - 2)}╯</span>`; }
  function row(content) { return `  <span class="d">│</span>  ${content}`; }
  function blankRow() { return `  <span class="d">│</span>`; }
  function div() { return `  <span class="d">│</span>  <span class="dd">${'─'.repeat(BOX_W - 6)}</span>  <span class="d">│</span>`; }

  /* ── state mgmt ── */
  function stopWatcher() {
    if (watcher) {
      watcher.stop();
      watcher = null;
      p(`  <span class="d">╰${'─'.repeat(BOX_W - 2)}╯</span>`);
      blank();
    }
  }

  function setMode(mode) {
    state.mode = mode;
    if (window.KrillAPI && KrillAPI.state) KrillAPI.state.mode = mode;
    const item = $('sb-mode');
    const text = $('sb-mode-text');
    if (!item || !text) return;
    if (mode === 'PAUSE') {
      item.classList.add('state-pause');
      text.textContent = 'PAUSED';
    } else {
      item.classList.remove('state-pause');
      text.textContent = 'SIGNAL';
    }
  }

  /* ══════════ BOOT ══════════ */

  const BOOT = [
    `<span class="dd">  ·    ✦        ·      ✦      ·        ✦    ·</span>`,
    `<span class="dd">     ✦      ·    ✦      ·    ✦      ·</span>`,
    '',
    `<span class="gg">  ██╗  ██╗██████╗ ██╗██╗     ██╗     </span>`,
    `<span class="gg">  ██║ ██╔╝██╔══██╗██║██║     ██║     </span>`,
    `<span class="gg">  █████╔╝ ██████╔╝██║██║     ██║     </span>`,
    `<span class="gg">  ██╔═██╗ ██╔══██╗██║██║     ██║     </span>`,
    `<span class="gg">  ██║  ██╗██║  ██║██║███████╗███████╗</span>`,
    `<span class="gg">  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝</span>`,
    '',
    `<span class="dim">  launch intelligence · virtuals · robinhood-ready</span>`,
    '',
    `<span class="d">  ─────────────────────────────────────────────────</span>`,
    '',
  ];

  const BOOT_SEQ = [
    { text: `<span class="d">  [boot]</span> <span class="ww">initializing krill runtime...</span>`, delay: 100 },
    { text: `<span class="d">  [boot]</span> <span class="ww">loading robinhood launch radar</span> <span class="g">✓</span>`, delay: 200 },
    { text: `<span class="d">  [boot]</span> <span class="ww">loading virtuals agent runtime</span> <span class="g">✓</span>`, delay: 150 },
    { text: `<span class="d">  [boot]</span> <span class="ww">profile: virtuals prelaunch</span> <span class="g">✓</span>`, delay: 100 },
    { text: `<span class="d">  [boot]</span> <span class="ww">launch signal watcher</span> <span class="g">✓</span>`, delay: 180 },
    { text: `<span class="d">  [boot]</span> <span class="ww">scoring engine</span> <span class="g">✓</span>`, delay: 120 },
    { text: `<span class="d">  [boot]</span> <span class="ww">risk lens module</span> <span class="g">✓</span>`, delay: 140 },
    { text: `<span class="d">  [boot]</span> <span class="ww">public terminal tracker</span> <span class="g">✓</span>`, delay: 100 },
    { text: `<span class="d">  [boot]</span> <span class="ww">social signal integration</span> <span class="g">✓</span>`, delay: 130 },
    { text: '', delay: 50 },
    { text: `<span class="d">  [boot]</span> <span class="g bold">all systems online</span> <span class="dim">· 9/9 modules loaded</span>`, delay: 200 },
    { text: '', delay: 50 },
    { text: `  <span class="dim">type</span> <span class="w bold">help</span> <span class="dim">to see available commands · </span><span class="dim">↑↓</span> <span class="dim">history · </span><span class="dim">tab</span> <span class="dim">autocomplete</span>`, delay: 0 },
    { text: '', delay: 0 },
  ];

  function boot(cb) {
    typeLines(BOOT, 40, () => {
      let i = 0;
      (function next() {
        if (i < BOOT_SEQ.length) {
          p(BOOT_SEQ[i].text);
          i++;
          setTimeout(next, BOOT_SEQ[i - 1].delay);
        } else if (cb) cb();
      })();
    });
  }

  /* ══════════ COMMANDS ══════════ */

  const COMMANDS = {

    help: () => [
      `  <span class="d">╭─ commands ─────────────────────────────────────╮</span>`,
      `  <span class="d">│</span>                                                <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">status</span>      <span class="dim">agent status & mode</span>              <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">scan</span>        <span class="dim">scan statistics</span>                  <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">targets</span>     <span class="dim">launch watchlist</span>                 <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">portfolio</span>   <span class="dim">tracked launch briefs</span>            <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">hunt</span>        <span class="dim">latest intelligence log</span>          <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">profit</span>      <span class="dim">clarity trend breakdown</span>         <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">wallet</span>      <span class="dim">wallet info</span>                      <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">pools</span>       <span class="dim">launch signal lanes</span>              <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">history</span>     <span class="dim">recent signal history</span>             <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">config</span>      <span class="dim">agent configuration</span>              <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">twitter</span>     <span class="dim">recent mentions & posts</span>          <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">deploy</span>      <span class="dim">deployment status</span>                 <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">pause</span>       <span class="dim">pause signal mode</span>                 <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">resume</span>      <span class="dim">resume signal mode</span>                <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">watch</span>       <span class="dim">live watch a clarity score</span>        <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">log</span>         <span class="dim">event log</span>                         <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">gas</span>         <span class="dim">launch-track fee estimate</span>         <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">bid</span>         <span class="dim">publish manual note</span>               <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">sell</span>        <span class="dim">archive a watched launch</span>          <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">token</span>       <span class="dim">$KRILL token stats</span>               <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">leaderboard</span> <span class="dim">top signal agents</span>               <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">score</span>       <span class="dim">score any token</span>                  <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">share</span>       <span class="dim">shareable clarity card + tweet</span>    <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">about</span>       <span class="dim">about krill</span>                      <span class="d">│</span>`,
      `  <span class="d">│</span>  <span class="w bold">clear</span>       <span class="dim">clear terminal</span>                   <span class="d">│</span>`,
      `  <span class="d">│</span>                                                <span class="d">│</span>`,
      `  <span class="d">╰────────────────────────────────────────────────╯</span>`,
      '',
    ],

    status: async () => {
      const d = await KrillAPI.fetchAPI('/status');
      if (d.mode !== state.mode) setMode(d.mode);
      const modeColor = d.mode === 'PAUSE' ? 'y' : 'g';
      const modeText = d.mode === 'PAUSE' ? '⏸ PAUSE' : '● SIGNAL';
      return [
        boxTop('agent status'),
        blankRow(),
        row(`<span class="g bold glow">KRILL</span>  <span class="dim">· launch intelligence agent · v2.0.0</span>`),
        blankRow(),
        row(`<span class="dim">${pad('mode', 11)}</span><span class="${modeColor} bold">${modeText}</span>`),
        row(`<span class="dim">${pad('chain', 11)}</span><span class="c">${d.chain}</span> <span class="dim">(${d.chainId})</span>`),
        row(`<span class="dim">${pad('uptime', 11)}</span><span class="w">${d.uptime}</span>`),
        row(`<span class="dim">${pad('wallet', 11)}</span><span class="dim">${d.wallet}</span>`),
        row(`<span class="dim">${pad('balance', 11)}</span><span class="w">${fmtNum(d.sol)} RH</span> <span class="dim">·</span> <span class="w">${fmtToken(d.krill)} KRILL</span>`),
        row(`<span class="dim">${pad('template', 11)}</span><span class="dim">${d.template}</span>`),
        row(`<span class="dim">${pad('deployed', 11)}</span><span class="dim">${d.deployed}</span>`),
        blankRow(),
        boxBottom(),
        '',
      ];
    },

    scan: async () => {
      const d = await KrillAPI.fetchAPI('/scan');
      return [
        boxTop('scan statistics'),
        blankRow(),
        row(`<span class="w bold" style="font-size:28px;line-height:1.2">${d.total.toLocaleString()}</span>`),
        row(`<span class="dim">total scans</span>`),
        blankRow(),
        row(`<span class="dim">${pad('avg scan time', 15)}</span><span class="w">${rpad(d.avgScanMs + 'ms', 7)}</span>      ${bar(d.avgScanMs, 50, 20, '#4ade80')}`),
        row(`<span class="dim">${pad('targets found', 15)}</span><span class="w">${rpad(d.targets + '', 7)}</span>      ${bar(d.targets, 50, 20, '#60a5fa')}`),
        row(`<span class="dim">${pad('captured', 15)}</span><span class="g bold">${rpad(d.captured + '', 7)}</span>      ${bar(d.captured, 50, 20, '#4ade80')}`),
        row(`<span class="dim">${pad('missed', 15)}</span><span class="r">${rpad(d.missed + '', 7)}</span>      ${bar(d.missed, 50, 20, '#fb7185')}`),
        row(`<span class="dim">${pad('hit rate', 15)}</span><span class="g bold">${rpad(d.hitRate + '%', 7)}</span>      ${bar(d.hitRate, 100, 20, '#4ade80')}`),
        row(`<span class="dim">${pad('last scan', 15)}</span><span class="dim">${d.lastScanSec}s ago</span>`),
        blankRow(),
        boxBottom(),
        '',
      ];
    },

    targets: async () => {
      const d = await KrillAPI.fetchAPI('/targets');
      const lines = [
        boxTop('active targets'),
        blankRow(),
        row(`<span class="d">${pad('score', 6)} ${pad('token', 9)} ${pad('liquidity', 12)} ${pad('holders', 8)} status</span>`),
        div(),
      ];
      const scoreClass = s => s >= 80 ? 'g bold' : s >= 60 ? 'y' : 'dim';
      const statusBadge = s => s === 'SIGNAL' ? '<span class="g bold">● SIGNAL</span>' : s === 'SCAN' ? '<span class="y">◌ SCAN</span>' : '<span class="dim">○ WAIT</span>';
      for (const t of d.targets) {
        const dim = t.status === 'WAIT';
        lines.push(row(
          `<span class="${scoreClass(t.score)}">${rpad(t.score + '', 4)}</span>   ` +
          `<span class="${dim ? 'dim' : 'w bold'}">${pad(t.token, 9)}</span>` +
          `<span class="${dim ? 'dim' : 'w'}">${pad(fmtNum(t.liquidity, 1) + ' RH', 12)}</span>` +
          `<span class="${dim ? 'dim' : 'w'}">${rpad(t.holders.toLocaleString(), 7)}</span>  ` +
          statusBadge(t.status)
        ));
      }
      lines.push(
        blankRow(),
        row(`<span class="dim">24h signal volume: ${d.volume24h} RH · new launches: ${d.newPools}</span>`),
        blankRow(),
        boxBottom(),
        '',
      );
      return lines;
    },

    portfolio: async () => {
      const d = await KrillAPI.fetchAPI('/portfolio');
      const lines = [boxTop('portfolio'), blankRow()];
      for (const h of d.holdings) {
        const posColor = h.pct >= 0 ? (h.pct >= 100 ? 'g bold' : 'g') : 'r';
        const tokColor = (h.status === 'WATCH' || h.status === 'STOP') ? 'ww' : 'w bold';
        const statColor = h.status === 'PUBLIC' ? 'g bold' : h.status === 'REVIEW' ? 'y' : h.status === 'WATCH' ? 'dim' : 'r bold';
        const filled = '█'.repeat(h.filled);
        const empty = '░'.repeat(28 - h.filled);
        const barC = h.pct >= 0 ? 'g' : 'r';
        lines.push(row(
          `<span class="${tokColor}">${pad(h.token, 7)}</span> ` +
          `<span class="${posColor}">${pad((h.pct >= 0 ? '+' : '') + h.pct + '%', 7)}</span>  ` +
          `<span class="${barC}">${filled}</span><span class="dd">${empty}</span>  ` +
          `<span class="${statColor}">${h.status}</span>`
        ));
      }
      lines.push(
        blankRow(),
        div(),
        row(`<span class="dim">${pad('total', 8)}</span> <span class="g bold glow" style="font-size:16px">${d.total} clarity</span>  <span class="dim">(${d.totalPeriod})</span>`),
        row(`<span class="dim">${pad('win rate', 8)}</span> <span class="g bold">${d.winRate}%</span>  <span class="dim">·</span>  <span class="dim">trades</span> <span class="w">${d.trades}</span>  <span class="dim">·</span>  <span class="dim">avg hold</span> <span class="w">${d.avgHoldHours}h</span>`),
        blankRow(),
        boxBottom(),
        '',
      );
      return lines;
    },

    hunt: async () => {
      const d = await KrillAPI.fetchAPI('/hunt');
      const lines = [boxTop('latest signal'), blankRow()];
      for (const e of d.events) {
        if (e.kind === 'success') {
          lines.push(row(`<span class="dd">${e.ts}</span>  <span class="g bold glow">${e.text}</span>`));
        } else {
          lines.push(row(`<span class="dd">${e.ts}</span>  <span class="ww">${e.text}</span>`));
        }
      }
      lines.push(blankRow(), boxBottom(), '');
      return lines;
    },

    profit: async () => {
      const d = await KrillAPI.fetchAPI('/profit');
      const lines = [
        boxTop('clarity trend'),
        blankRow(),
        row(`<span class="dim">${pad('period', 12)} ${pad('signals', 8)} clarity</span>`),
        div(),
      ];
      for (const x of d.periods) {
        const isAT = x.period === 'all-time';
        const c = isAT ? 'g bold glow' : 'g';
        const pc = isAT ? 'w' : 'ww';
        lines.push(row(
          `<span class="${pc}">${pad(x.period, 12)}</span>` +
          `<span class="w">${rpad(x.trades + '', 8)}</span>` +
          `<span class="${c}">${x.pnl} clarity</span>`
        ));
      }
      lines.push(
        blankRow(),
        row(`<span class="dim">${pad('best signal', 13)}</span><span class="g bold">${d.bestTrade.pct} clarity</span>  <span class="dim">${d.bestTrade.token}</span>`),
        row(`<span class="dim">${pad('weak signal', 13)}</span><span class="y bold">${d.worstTrade.pct} clarity</span>   <span class="dim">${d.worstTrade.token}</span>`),
        row(`<span class="dim">${pad('avg risk', 13)}</span><span class="w">${d.avgEntry}</span>`),
        row(`<span class="dim">${pad('avg clarity', 13)}</span><span class="w">${d.avgExit}</span>`),
        row(`<span class="dim">${pad('confidence', 13)}</span><span class="g">${d.sharpe}</span>`),
        blankRow(),
        boxBottom(),
        '',
      );
      return lines;
    },

    wallet: async () => {
      const d = await KrillAPI.fetchAPI('/wallet');
      return [
        boxTop('wallet'),
        blankRow(),
        row(`<span class="dim">${pad('address', 10)}</span><span class="ww">${d.address}</span>`),
        row(`<span class="dim">${pad('RH', 10)}</span><span class="w bold">${fmtNum(d.sol)}</span>`),
        row(`<span class="dim">${pad('KRILL', 10)}</span><span class="w bold">${fmtToken(d.krill)}</span>`),
        row(`<span class="dim">${pad('sKRILL', 10)}</span><span class="w">${fmtToken(d.stakedKrill)}</span> <span class="dim">(${d.stakedNote || 'reserved for agent compute'})</span>`),
        row(`<span class="dim">${pad('chain', 10)}</span><span class="c">${d.chain} (${d.chainId})</span>`),
        blankRow(),
        row(`<span class="dim">${d.explorer}</span>`),
        blankRow(),
        boxBottom(),
        '',
      ];
    },

    pools: async () => {
      const d = await KrillAPI.fetchAPI('/pools');
      const lines = [
        boxTop('signal lanes'),
        blankRow(),
        row(`<span class="dim">${pad('id', 12)} ${pad('pair', 12)} ${pad('range', 15)} value</span>`),
        div(),
      ];
      for (const p of d.positions) {
        lines.push(row(
          `<span class="ww">${pad(p.id, 12)}</span>` +
          `<span class="w">${pad(p.pair, 12)}</span>` +
          `<span class="dim">${pad(p.range, 15)}</span>` +
          `<span class="w">${p.value} RH</span>`
        ));
      }
      lines.push(
        blankRow(),
        row(`<span class="dim">${pad('pool', 11)}</span><span class="c">${d.pool}</span>`),
        row(`<span class="dim">${pad('apr', 11)}</span><span class="g bold">${d.apr}%</span>`),
        row(`<span class="dim">${pad('total', 11)}</span><span class="w bold">${d.total} RH</span>`),
        blankRow(),
        boxBottom(),
        '',
      );
      return lines;
    },

    history: async () => {
      const d = await KrillAPI.fetchAPI('/history');
      const lines = [boxTop('recent signals'), blankRow()];
      for (const t of d.trades) {
        const sideC = t.side === 'NOTE' || t.side === 'SCAN' ? 'g bold' : t.side === 'WARN' ? 'y bold' : 'r bold';
        const pctC = t.pct >= 70 ? 'g' : t.pct >= 45 ? 'y' : 'r';
        lines.push(row(
          `<span class="dd">${pad(t.ts, 6)}</span>  ` +
          `<span class="${sideC}">${pad(t.side, 5)}</span>  ` +
          `<span class="w">${pad(t.token, 7)}</span>  ` +
          `<span class="w">${pad(fmtNum(t.amount, 3) + ' RH', 10)}</span>  ` +
          `<span class="${pctC}">${t.pct >= 0 ? '+' : ''}${t.pct}%</span>`
        ));
      }
      lines.push(blankRow(), boxBottom(), '');
      return lines;
    },

    log: async () => {
      const d = await KrillAPI.fetchAPI('/log');
      const lines = [boxTop('event log (last 20)'), blankRow()];
      for (const e of d.events) {
        const k = e.kind === 'g' ? 'g' : e.kind === 'r' ? 'r' : e.kind === 'y' ? 'y' : 'd';
        lines.push(row(
          `<span class="dd">${e.ts}</span>  ` +
          `<span class="${k}">${pad(e.type, 5)}</span>  ` +
          `<span class="w">${pad(e.token, 7)}</span>  ` +
          `<span class="${k}">${e.result}</span>`
        ));
      }
      lines.push(blankRow(), row(`<span class="d">... ${d.events.length} of ${d.events.length} shown</span>`), blankRow(), boxBottom(), '');
      return lines;
    },

    config: async () => {
      const d = await KrillAPI.fetchAPI('/config');
      return [
        boxTop('configuration'),
        blankRow(),
        row(`<span class="dim">${pad('min_score', 14)}</span><span class="w">${d.minScore}</span>`),
        row(`<span class="dim">${pad('max_note', 14)}</span><span class="w">${d.maxBid} RH</span>`),
        row(`<span class="dim">${pad('max_rounds', 14)}</span><span class="w">${d.maxRounds}</span>`),
        row(`<span class="dim">${pad('stop_loss', 14)}</span><span class="w">${d.stopLoss}%</span>`),
        row(`<span class="dim">${pad('take_profit', 14)}</span><span class="w">+${d.takeProfit}%</span>`),
        row(`<span class="dim">${pad('auto_sell', 14)}</span><span class="g">${d.autoSell ? 'enabled' : 'disabled'}</span>`),
        row(`<span class="dim">${pad('reinvest', 14)}</span><span class="g">${d.reinvest ? 'enabled' : 'disabled'}</span>`),
        row(`<span class="dim">${pad('model', 14)}</span><span class="w">${d.model}</span>`),
        blankRow(),
        boxBottom(),
        '',
      ];
    },

    twitter: async () => {
      const d = await KrillAPI.fetchAPI('/twitter');
      const lines = [boxTop('twitter'), blankRow()];
      for (const post of d.posts) {
        lines.push(row(`<span class="c">${post.handle}</span>  <span class="dim">· ${post.ago} ago</span>`));
        lines.push(row(`<span class="ww">${post.text}</span>`));
        lines.push(row(`<span class="d">▲ ${post.up}   ↺ ${post.rt}   ♥ ${post.like}</span>`));
        lines.push(blankRow());
      }
      lines.push(boxBottom(), '');
      return lines;
    },

    gas: async () => {
      const d = await KrillAPI.fetchAPI('/gas');
      return [
        boxTop('gas tracker'),
        blankRow(),
        row(`<span class="c">${d.chain} (${d.chainId})</span>`),
        div(),
        row(`<span class="dim">${pad('slow', 12)}</span><span class="w">${d.slow} ${d.unit || 'RH'}</span>`),
        row(`<span class="dim">${pad('avg', 12)}</span><span class="w">${d.avg} ${d.unit || 'RH'}</span>`),
        row(`<span class="dim">${pad('fast', 12)}</span><span class="w">${d.fast} ${d.unit || 'RH'}</span>`),
        div(),
        row(`<span class="dim">${pad('last tx', 12)}</span><span class="w">${d.lastTx} ${d.unit || 'RH'}</span>`),
        row(`<span class="dim">${pad('est. note', 12)}</span><span class="g">$${d.estSnipeUsd}</span>`),
        blankRow(),
        boxBottom(),
        '',
      ];
    },

    deploy: async () => {
      const d = await KrillAPI.fetchAPI('/deploy');
      return [
        boxTop('deployment'),
        blankRow(),
        row(`<span class="dim">${pad('template', 13)}</span><span class="c">${d.template}</span>`),
        row(`<span class="dim">${pad('status', 13)}</span><span class="g bold">● ${d.status}</span>`),
        row(`<span class="dim">${pad('container', 13)}</span><span class="ww">${d.container}</span>`),
        row(`<span class="dim">${pad('region', 13)}</span><span class="dim">${d.region}</span>`),
        row(`<span class="dim">${pad('rpc', 13)}</span><span class="c">${d.rpc}</span>`),
        row(`<span class="dim">${pad('uptime', 13)}</span><span class="w">${d.uptime}</span>`),
        blankRow(),
        boxBottom(),
        '',
      ];
    },

    about: async () => {
      const d = await KrillAPI.fetchAPI('/about');
      const lines = [
        boxTop('about'),
        blankRow(),
        row(`<span class="g bold glow">${d.name}</span>  <span class="dim">· ${d.tagline}</span>`),
        blankRow(),
      ];
      for (const desc of d.description) lines.push(row(`<span class="ww">${desc}</span>`));
      lines.push(
        blankRow(),
        row(`<span class="dim">${pad('template', 12)}</span><span class="c">${d.template}</span>`),
        row(`<span class="dim">${pad('protocol', 12)}</span><span class="c">${d.protocol}</span>`),
        row(`<span class="dim">${pad('chain', 12)}</span><span class="c">${d.chain}</span>`),
        row(`<span class="dim">${pad('sdk', 12)}</span><span class="c">${d.sdk}</span>`),
        row(`<span class="dim">${pad('repo', 12)}</span><span class="c">${d.repo}</span>`),
        row(`<span class="dim">${pad('x/twitter', 12)}</span><span class="c">${d.x}</span>`),
        blankRow(),
        boxBottom(),
        '',
      );
      return lines;
    },

    pause: async () => {
      try { await KrillAPI.postAPI('/mode', { mode: 'PAUSE' }); } catch (e) {}
      setMode('PAUSE');
      return [
        `  <span class="y bold">⏸  HUNTING PAUSED</span>`,
        '',
        `  <span class="dim">agent is now in PAUSE mode</span>`,
        `  <span class="dim">· no new launch notes will be published</span>`,
        `  <span class="dim">· existing watchlist stays visible</span>`,
        `  <span class="dim">· launch signal scanning suspended</span>`,
        '',
        `  <span class="dim">type</span> <span class="w bold">resume</span> <span class="dim">to continue publishing signals</span>`,
        '',
      ];
    },

    resume: async () => {
      try { await KrillAPI.postAPI('/mode', { mode: 'SIGNAL' }); } catch (e) {}
      setMode('SIGNAL');
      return [
        `  <span class="g bold">▶  SIGNAL MODE RESUMED</span>`,
        '',
        `  <span class="d">[resume]</span> <span class="ww">scanning launch feed</span> <span class="g">✓</span>`,
        `  <span class="d">[resume]</span> <span class="ww">risk lens reactivated</span> <span class="g">✓</span>`,
        `  <span class="d">[resume]</span> <span class="ww">scoring engine online</span> <span class="g">✓</span>`,
        '',
      ];
    },

    watch: (args) => {
      const token = (args || '').split(/\s+/)[0] || '$KRILL';
      stopWatcher();
      const title = `─ watching ${token} `;
      const head = `╭${title}${'─'.repeat(BOX_W - 2 - title.length)}╮`;
      p(`  <span class="d">${head}</span>`);
      p(`  <span class="d">│</span>  <span class="dim">streaming clarity score ticks · type any command to stop</span>`);
      watcher = KrillAPI.startWatchStream(token, (tick) => {
        const c = tick.change >= 0 ? 'g' : 'r';
        const s = tick.change >= 0 ? '+' : '';
        const a = tick.change >= 0 ? '▲' : '▼';
        const t = new Date(tick.ts).toLocaleTimeString('en-GB');
        p(`  <span class="d">│</span>  <span class="dd">${t}</span>  <span class="${c}">${a} ${s}${tick.change.toFixed(2)}</span>  <span class="dim">→</span>  <span class="ww">${tick.price.toFixed(2)} clarity</span>`);
      });
      return [];
    },

    bid: async (args) => {
      const parts = (args || '').split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        return [
          `  <span class="r">usage:</span> <span class="w">bid &lt;token&gt; &lt;weight&gt;</span>`,
          `  <span class="dim">example:</span> <span class="c">bid $KRILL 1</span>`,
        ];
      }
      const [token, amount] = parts;
      const res = await KrillAPI.postAPI('/bid', { token, amount: parseFloat(amount) });
      return [
        `  <span class="d">[note]</span> token  <span class="w bold">${esc(token)}</span>`,
        `  <span class="d">[note]</span> weight <span class="w bold">${esc(amount)} RH</span>`,
        `  <span class="d">[note]</span> round  <span class="w">${res.round || 1}/${res.maxRounds || 1}</span>`,
        `  <span class="d">[note]</span> ref    <span class="dim">${res.tx}...8b2e</span>`,
        `  <span class="g bold glow">✓ ${res.status}</span>  <span class="dim">— launch note published</span>`,
      ];
    },

    sell: async (args) => {
      const token = (args || '').split(/\s+/).filter(Boolean)[0];
      if (!token) {
        return [
          `  <span class="r">usage:</span> <span class="w">sell &lt;token&gt;</span>`,
          `  <span class="dim">example:</span> <span class="c">sell $KRILL</span>`,
        ];
      }
      const res = await KrillAPI.postAPI('/sell', { token });
      return [
        `  <span class="d">[archive]</span> token <span class="w bold">${esc(token)}</span>`,
        `  <span class="d">[archive]</span> ref   <span class="dim">${res.tx}...c4f1</span>`,
        `  <span class="g bold">✓ ${res.status}</span>  <span class="dim">— launch moved off active watchlist</span>`,
      ];
    },

    clear: () => { out.innerHTML = ''; return []; },

    leaderboard: async () => {
      const d = await KrillAPI.fetchAPI('/leaderboard');
      const lines = [
        boxTop('leaderboard'),
        blankRow(),
        row(`<span class="dim">${pad('#', 4)} ${pad('agent', 14)} ${pad('signals', 8)} ${pad('clear%', 7)} ${pad('score', 14)} streak</span>`),
        div(),
      ];
      for (const h of d.hunters) {
        const rankC = h.rank <= 3 ? 'g bold' : 'w';
        const you = h.name === 'krill' ? ' <span class="g bold">← you</span>' : '';
        lines.push(row(
          `<span class="${rankC}">${rpad(h.rank + '', 3)}</span>  ` +
          `<span class="${h.name === 'krill' ? 'g bold glow' : 'ww'}">${pad(h.name, 14)}</span>` +
          `<span class="w">${rpad(h.trades + '', 6)}</span>  ` +
          `<span class="${h.winRate >= 60 ? 'g' : 'y'}">${rpad(h.winRate + '%', 5)}</span> ` +
          `<span class="g">${pad(h.pnl, 14)}</span>` +
          `<span class="${h.streak >= 5 ? 'g bold' : 'dim'}">${'🔥'.repeat(Math.min(h.streak, 5))}</span>${you}`
        ));
      }
      lines.push(
        blankRow(),
        div(),
        row(`<span class="dim">${pad('total agents', 16)}</span><span class="w bold">${d.totalHunters.toLocaleString()}</span>`),
        row(`<span class="dim">${pad('avg clarity', 16)}</span><span class="g">${d.avgWinRate}%</span>`),
        row(`<span class="dim">${pad('network note', 16)}</span><span class="g bold">${d.totalPnl}</span>`),
        blankRow(),
        boxBottom(),
        '',
      );
      return lines;
    },

    token: async () => {
      const d = await KrillAPI.fetchAPI('/token');
      return [
        boxTop('$KRILL token'),
        blankRow(),
        row(`<span class="g bold glow" style="font-size:20px;line-height:1.2">${d.symbol}</span>  <span class="dim">${d.name} · ${d.chain}</span>`),
        blankRow(),
        row(`<span class="dim">${pad('price', 13)}</span><span class="w bold">${d.price} RH</span>  <span class="dim">($${d.priceUsd})</span>`),
        row(`<span class="dim">${pad('market cap', 13)}</span><span class="g bold">${d.marketCapFmt}</span>`),
        row(`<span class="dim">${pad('supply', 13)}</span><span class="w">${d.supply}</span>`),
        row(`<span class="dim">${pad('holders', 13)}</span><span class="w bold">${d.holders.toLocaleString()}</span>  <span class="g">${d.holdersDelta24h} (24h)</span>`),
        row(`<span class="dim">${pad('24h volume', 13)}</span><span class="w">${d.volume24h}</span>`),
        row(`<span class="dim">${pad('liquidity', 13)}</span><span class="w">${d.liquidity}</span>`),
        row(`<span class="dim">${pad('LP locked', 13)}</span><span class="g bold">${d.lpLockedPct}%</span>  <span class="g">✓</span>`),
        blankRow(),
        row(`<span class="dim">${pad('CA', 13)}</span><span class="dd">${d.ca}</span>`),
        blankRow(),
        row(`<span class="c">${d.explorer}</span>`),
        row(`<span class="c">${d.virtuals || 'Virtuals launch profile pending'}</span>`),
        blankRow(),
        boxBottom(),
        '',
      ];
    },

    score: async (args) => {
      const token = (args || '').split(/\s+/).filter(Boolean)[0];
      if (!token) {
        return [
          `  <span class="r">usage:</span> <span class="w">score &lt;token&gt;</span>`,
          `  <span class="dim">example:</span> <span class="c">score $KRILL</span>`,
        ];
      }
      const d = await KrillAPI.fetchAPI('/score?token=' + encodeURIComponent(token));
      const decC = d.decision === 'SIGNAL' ? 'g bold' : d.decision === 'SCAN' ? 'y' : 'r';
      const lines = [
        boxTop(`score: ${esc(token)}`),
        blankRow(),
        row(`<span class="w bold" style="font-size:32px;line-height:1">${d.score}</span>  <span class="dim">/100</span>  <span class="${decC}">→ ${d.decision}</span>`),
        blankRow(),
        div(),
      ];
      for (const s of d.signals) {
        const c = s.value >= 70 ? 'g' : s.value >= 50 ? 'y' : 'r';
        lines.push(row(
          `<span class="dim">${pad(s.name, 14)}</span>` +
          `<span class="${c}">${rpad(s.value + '', 4)}</span>  ` +
          `${bar(s.value, 100, 16, c === 'g' ? '#4ade80' : c === 'y' ? '#facc15' : '#fb7185')}  ` +
          `<span class="dd">${s.weight}%</span>`
        ));
      }
      lines.push(
        blankRow(),
        boxBottom(),
        '',
      );
      return lines;
    },

    share: async (args) => {
      const token = (args || '').split(/\s+/).filter(Boolean)[0];
      if (!token) {
        return [
          `  <span class="r">usage:</span> <span class="w">share &lt;token&gt;</span>`,
          `  <span class="dim">example:</span> <span class="c">share $KRILL</span>`,
          `  <span class="dim">generates a shareable clarity card + tweet link</span>`,
        ];
      }
      const d = await KrillAPI.fetchAPI('/score?token=' + encodeURIComponent(token));
      const clean = String(token).replace(/^\$+/, '').toUpperCase();
      const base = KrillAPI.API_BASE.replace(/\/api$/, '');
      const cardUrl = `${base}/api/card?token=${encodeURIComponent(clean)}`;
      const embedUrl = `${base}/api/embed?token=${encodeURIComponent(clean)}`;
      const tweetText = `$${clean} — clarity ${d.score}/100 · ${d.safety}\n\n${d.verdict}\n\nscanned free on 🦐 krill.live`;
      const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent(embedUrl)}`;

      // copy the unfurl link to clipboard (best-effort)
      let copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(embedUrl);
          copied = true;
        }
      } catch { /* clipboard blocked — link is still shown below */ }

      const decC = d.decision === 'SIGNAL' ? 'g bold' : d.decision === 'SCAN' ? 'y' : 'r';
      return [
        boxTop(`share: $${esc(clean)}`),
        blankRow(),
        row(`<span class="w bold" style="font-size:28px;line-height:1">${d.score}</span> <span class="dim">/100</span>  <span class="${decC}">${esc(d.safety)}</span>`),
        row(`<span class="dim">${esc(d.verdict)}</span>`),
        blankRow(),
        div(),
        row(`<span class="dim">clarity card</span>`),
        row(`<a href="${cardUrl}" target="_blank" rel="noopener" class="c">${cardUrl}</a>`),
        blankRow(),
        row(`<span class="dim">share link ${copied ? '<span class="g">(copied ✓)</span>' : ''}</span>`),
        row(`<a href="${embedUrl}" target="_blank" rel="noopener" class="c">${embedUrl}</a>`),
        blankRow(),
        row(`<a href="${tweetUrl}" target="_blank" rel="noopener" class="g bold">→ post to X ↗</a>`),
        blankRow(),
        boxBottom(),
        '',
      ];
    },

  };

  const ALIASES = { h: 'help', s: 'status', t: 'targets', p: 'portfolio', w: 'wallet', c: 'clear', d: 'deploy', g: 'gas', l: 'log', lb: 'leaderboard', tk: 'token', sc: 'score', sh: 'share' };
  const ALL = [...Object.keys(COMMANDS), ...Object.keys(ALIASES)];

  async function exec(input) {
    const raw = input.trim();
    if (!raw) return;
    stopWatcher();
    p(`<span class="g">krill</span><span class="dd">@</span><span class="c">robinhood</span> <span class="d">›</span> <span class="w">${esc(raw)}</span>`);

    const [cmdName, ...rest] = raw.split(/\s+/);
    const resolved = ALIASES[cmdName] || cmdName;
    const fn = COMMANDS[resolved];
    if (!fn) {
      p(`<span class="r">command not found:</span> <span class="ww">${esc(raw)}</span>`);
      p(`<span class="dim">type </span><span class="w bold">help</span><span class="dim"> for available commands</span>`);
      blank();
      return;
    }
    try {
      const lines = await fn(rest.join(' '));
      if (lines && lines.length) typeLines(lines, 25);
    } catch (e) {
      p(`  <span class="r">error:</span> <span class="dim">${esc(e.message)}</span>`);
    }
  }

  /* ── input ── */
  cmd.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const v = cmd.value;
      if (v.trim()) hist.push(v);
      hIdx = -1;
      cmd.value = '';
      exec(v);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hist.length && hIdx < hist.length - 1) { hIdx++; cmd.value = hist[hist.length - 1 - hIdx]; }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (hIdx > 0) { hIdx--; cmd.value = hist[hist.length - 1 - hIdx]; }
      else { hIdx = -1; cmd.value = ''; }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const partial = cmd.value.trim();
      if (partial) {
        const match = ALL.find(c => c.startsWith(partial));
        if (match) cmd.value = match;
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      out.innerHTML = '';
    }
  });

  document.addEventListener('click', () => cmd.focus());

  /* ── status bar tickers ── */
  let uptimeSec = 47 * 86400 + 14 * 3600 + 23 * 60;
  let scanSec = 0;

  setInterval(() => {
    uptimeSec++;
    scanSec++;
    const d = Math.floor(uptimeSec / 86400);
    const h = Math.floor((uptimeSec % 86400) / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    $('sb-uptime').textContent = `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
    $('sb-scan').textContent = `last scan: ${scanSec}s ago`;
    if (scanSec > 30) scanSec = 0;
  }, 1000);

  /* ── API polling: keep status bar in sync with backend ── */
  function startStatusPolling() {
    if (!window.KrillAPI) return;
    stopPolling = KrillAPI.startPolling(['/status', '/gas'], 30_000, (path, data) => {
      if (path === '/status') {
        if (data.mode !== state.mode) setMode(data.mode);
        if (data.uptime) $('sb-uptime').textContent = data.uptime;
      }
    });
  }

  /* ── boot ── */
  boot(() => {
    cmd.focus();
    startStatusPolling();
  });

})();
