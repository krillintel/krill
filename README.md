<div align="center">

# 🦐 KRILL

**AI-Powered Trading Intelligence on Robinhood Chain**

Launch-intelligence terminal for the Virtuals Protocol ecosystem — scan, score & explain new token launches in real time.

[![Live](https://img.shields.io/badge/live-krill.live-14F195?style=flat-square)](https://krill.live)
[![Chain](https://img.shields.io/badge/chain-Robinhood%204663-8B5CF6?style=flat-square)](https://krill.live)
[![Cloudflare Workers](https://img.shields.io/badge/API-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Tests](https://img.shields.io/badge/tests-31%20passing-3FB950?style=flat-square)](worker/src/index.test.js)

</div>

---

## Stack

- **Frontend** — static landing page + terminal UI (vanilla JS, no framework)
- **API** — Cloudflare Worker (`worker/`), reads on-chain data via EVM `eth_*` RPC
- **Tests** — Vitest (31 unit tests covering all routes)

## Structure

```
index.html          # landing + terminal UI
css/                # landing.css, style.css
js/                 # api.js (client), app.js (terminal logic)
worker/             # Cloudflare Worker API
  src/index.js      #   all routes (status, wallet, scan, hunt, ...)
  src/index.test.js #   Vitest suite
  wrangler.toml     #   Worker config
```

## Develop

Frontend is static — open `index.html` or serve it. The terminal auto-detects `localhost` and points to the local Worker.

```bash
cd worker
npm install
npm run dev      # → http://localhost:8787
npm test         # run the test suite
```

## Deploy

```bash
cd worker
npx wrangler secret put RPC_URL   # Robinhood Chain RPC endpoint
npm run deploy
```

Route `/api/*` on your Pages domain to the `krill-api` Worker. See [worker/README.md](worker/README.md) for the full endpoint reference.

## Chain

- **Network:** Robinhood Chain (EVM)
- **Chain ID:** 4663
- **Token:** $KRILL (Virtuals Protocol)

## License

[MIT](LICENSE) © KRILL
