// OpenAPI 3.1 spec for the KRILL API. Served verbatim at GET /api/openapi.json
// so tool-calling agents (and Swagger/Redoc UIs) can auto-import the surface.
// Kept as a plain object literal — no build step, no external file reads.

export const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'KRILL API',
    version: '2.0.0',
    summary: 'Robinhood-chain launch-intelligence safety gate for autonomous agents.',
    description:
      'KRILL reads on-chain + verifiable sources (holder distribution, GoPlus security, ' +
      'contract integrity, deployer history, tax detection) and returns a deterministic ' +
      'safety verdict. It never fabricates a number — if there is no data, it says so and ' +
      'fails closed. Use POST /check for a one-call allow/deny decision.',
    contact: { name: 'KRILL', url: 'https://krill.live', 'x-twitter': '@krillintel' },
    license: { name: 'MIT' },
  },
  servers: [{ url: 'https://krill-api.gedangefek.workers.dev/api', description: 'production' }],
  tags: [
    { name: 'gate', description: 'Agent decision primitives' },
    { name: 'intel', description: 'Token intelligence reads' },
    { name: 'alerts', description: 'Verdict-change webhooks' },
    { name: 'meta', description: 'Status & discovery' },
  ],
  components: {
    securitySchemes: {
      apiKey: {
        type: 'apiKey', in: 'header', name: 'X-API-Key',
        description: 'Optional. Raises the rate limit from 60 to 600 req/min.',
      },
    },
    schemas: {
      CheckRequest: {
        type: 'object', required: ['token'],
        properties: {
          token: { type: 'string', description: 'Contract address (0x…) or $KRILL.', examples: ['0x9D08407b8511249bec898856C506dD7c5972E7BB'] },
          max_risk: { type: 'string', enum: ['low', 'unknown', 'high', 'critical'], default: 'low', description: 'Worst risk level you will tolerate.' },
        },
      },
      CheckResponse: {
        type: 'object',
        properties: {
          allow: { type: 'boolean', description: 'The single field to branch on. True only when risk_level ≤ max_risk and not a scam/STOP.' },
          token: { type: 'string' },
          contract: { type: ['string', 'null'] },
          action: { type: 'string', enum: ['PROCEED', 'CAUTION', 'STOP'] },
          risk_level: { type: 'string', enum: ['low', 'unknown', 'high', 'critical'] },
          is_scam: { type: 'boolean' },
          max_risk: { type: 'string' },
          score: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
          safety: { type: 'string', enum: ['SAFE', 'CAUTION', 'NOT SAFE', 'NO DATA'] },
          reason: { type: 'string' },
          onChain: { type: 'boolean' },
          ts: { type: 'integer' },
        },
      },
      AgentVerdict: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['PROCEED', 'CAUTION', 'STOP'] },
          safe_to_proceed: { type: 'boolean' },
          is_scam: { type: 'boolean' },
          risk_level: { type: 'string', enum: ['low', 'unknown', 'high', 'critical'] },
          reasons: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
      DataSource: {
        type: 'object',
        properties: {
          provider: { type: ['string', 'null'] },
          responded: { type: 'boolean' },
          assessed: { type: 'boolean', description: 'True only when the provider actually evaluated the token. False + responded=true means a shell read → treated as unknown, fails closed.' },
          status: { type: 'string', enum: ['assessed', 'shell', 'unreachable', 'no-contract', 'not-indexed', 'client-side', 'not-connected'] },
        },
      },
      Signal: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          weight: { type: 'integer' },
          available: { type: 'boolean' },
          value: { type: ['integer', 'null'] },
          source: { type: ['string', 'null'] },
          data_source: { $ref: '#/components/schemas/DataSource' },
          note: { type: ['string', 'null'] },
        },
      },
      ScoreResponse: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          name: { type: ['string', 'null'] },
          symbol: { type: ['string', 'null'] },
          score: { type: ['integer', 'null'] },
          label: { type: 'string' },
          decision: { type: 'string' },
          safety: { type: 'string' },
          agent: { $ref: '#/components/schemas/AgentVerdict' },
          signals: { type: ['array', 'null'], items: { $ref: '#/components/schemas/Signal' } },
          verdict: { type: ['string', 'null'] },
          onChain: { type: 'boolean' },
          contract: { type: ['string', 'null'] },
          ts: { type: 'integer' },
        },
      },
      BatchResponse: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          scored: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                token: { type: 'string' },
                contract: { type: ['string', 'null'] },
                score: { type: ['integer', 'null'] },
                label: { type: 'string' },
                safety: { type: 'string' },
                action: { type: ['string', 'null'] },
                safe_to_proceed: { type: ['boolean', 'null'] },
                onChain: { type: 'boolean' },
              },
            },
          },
          ts: { type: 'integer' },
        },
      },
      WatchRequest: {
        type: 'object', required: ['token'],
        properties: { token: { type: 'string', description: 'Contract address (0x…) or $KRILL.' } },
      },
      Error: { type: 'object', properties: { error: { type: 'string' } } },
    },
  },
  paths: {
    '/check': {
      post: {
        tags: ['gate'], operationId: 'checkToken',
        summary: 'Gate a token — one call, one boolean',
        description: 'The recommended primitive for agents. Returns `allow` (boolean) plus the deterministic verdict. Fails closed: a scam or STOP is always denied; no-data reads are `unknown` risk and denied at the default `max_risk: low`.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CheckRequest' } } } },
        responses: {
          200: { description: 'Verdict', content: { 'application/json': { schema: { $ref: '#/components/schemas/CheckResponse' } } } },
          400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          429: { description: 'Rate limit exceeded' },
        },
      },
    },
    '/score': {
      get: {
        tags: ['intel'], operationId: 'scoreToken',
        summary: 'Full clarity read + agent verdict + signal breakdown',
        parameters: [
          { name: 'token', in: 'query', required: true, schema: { type: 'string' }, description: 'Contract address (0x…) or $KRILL.' },
          { name: 'ai', in: 'query', required: false, schema: { type: 'string', enum: ['0', '1'] }, description: 'Pass ai=0 for the fast deterministic verdict (~90ms), skipping the AI narrative (~7s).' },
          { name: 'wallet', in: 'query', required: false, schema: { type: 'string' }, description: 'Optional wallet to resolve access tier.' },
        ],
        responses: {
          200: { description: 'Clarity read', content: { 'application/json': { schema: { $ref: '#/components/schemas/ScoreResponse' } } } },
          304: { description: 'Not modified (If-None-Match matched)' },
          429: { description: 'Rate limit exceeded' },
        },
      },
    },
    '/batch': {
      get: {
        tags: ['intel'], operationId: 'batchScore',
        summary: 'Score up to 10 tokens at once',
        parameters: [{ name: 'tokens', in: 'query', required: true, schema: { type: 'string' }, description: 'Comma-separated tokens (max 10). e.g. KRILL,0x359…' }],
        responses: {
          200: { description: 'Sorted results', content: { 'application/json': { schema: { $ref: '#/components/schemas/BatchResponse' } } } },
          304: { description: 'Not modified' },
          429: { description: 'Rate limit exceeded' },
        },
      },
    },
    '/token': {
      get: { tags: ['intel'], operationId: 'krillToken', summary: 'On-chain facts for $KRILL', responses: { 200: { description: 'Token facts' } } },
    },
    '/watch': {
      post: {
        tags: ['alerts'], operationId: 'watchToken',
        summary: 'Watch a token — fire a webhook when its verdict changes',
        description: 'Adds a token to the verdict-change watchlist. When its action/safety flips (e.g. a honeypot appears post-launch), KRILL POSTs an alert to the configured ALERT_WEBHOOK_URL.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/WatchRequest' } } } },
        responses: { 200: { description: 'Watching' }, 400: { description: 'Bad request' } },
      },
    },
    '/unwatch': {
      post: {
        tags: ['alerts'], operationId: 'unwatchToken',
        summary: 'Stop watching a token (admin)',
        description: 'Removes a token from the verdict-change watchlist and drops its checkpoint row, so a later re-add starts from a clean baseline instead of alerting off a stale verdict. Idempotent — removing an unwatched token reports removed:false and writes nothing. Requires the X-Admin-Key header: the watchlist is global, so an open removal endpoint would let anyone silently stop alerting on a token someone else is monitoring.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/WatchRequest' } } } },
        responses: {
          200: { description: 'Removal result — { ok, removed, watching, contract, ts }' },
          400: { description: 'Bad request' },
          403: { description: 'Missing or wrong X-Admin-Key' },
          503: { description: 'ADMIN_KEY not configured — route unavailable (fails closed)' },
        },
      },
    },
    '/watchlist': {
      get: {
        tags: ['alerts'], operationId: 'watchlist',
        summary: 'Live verdicts for every watched token + drift flags',
        description: 'One call for the whole monitored portfolio. Each entry carries the live verdict plus `last_checked`, the checkpoint the cron recorded, and `drifted: true` when the two disagree — i.e. the verdict moved since the last sweep. Sorted worst-risk first, so the most dangerous token is always the first element. Live fields are null when the chain is briefly unreachable; the checkpoint still shows.',
        responses: {
          200: { description: 'Watchlist — { watching, tokens, alert_webhook, ts }' },
        },
      },
    },
    '/history': {
      get: {
        tags: ['alerts'], operationId: 'tokenHistory',
        summary: 'Verdict timeline for one watched token',
        description: 'The time dimension behind the watchlist. While a token is watched, the cron seeds a baseline snapshot and appends a point on every verdict flip. Returns those points oldest-first with `changed` transition flags, plus `flips`, `first_seen`, `last_change`, and the `current` verdict. A never-watched token returns an empty timeline (points:0), not an error.',
        parameters: [
          { name: 'token', in: 'query', required: true, schema: { type: 'string' }, description: 'Contract address (0x…) or $KRILL.' },
        ],
        responses: {
          200: { description: 'Verdict timeline — { contract, token, watching, points, flips, first_seen, last_change, current, timeline, ts }' },
          400: { description: 'Missing token or token did not resolve to an address' },
        },
      },
    },
    '/deliveries': {
      get: {
        tags: ['alerts'], operationId: 'webhookDeliveries',
        summary: 'Webhook delivery log — did the alerts actually land?',
        description: 'Outcome of the most recent verdict-change webhook POSTs, newest-first. A non-2xx reply counts as a failure. Lets an operator distinguish "no alerts because nothing changed" from "no alerts because the receiver is down". `healthy` is null when no webhook is configured or no attempt has been recorded yet. The receiver URL is never returned.',
        responses: {
          200: { description: 'Delivery log — { alert_webhook, attempts, failed, pending, dead, permanent, recovered, healthy, last_success, last_failure, deliveries, ts }' },
        },
      },
    },
    '/watch/retry': {
      post: {
        tags: ['alerts'], operationId: 'retryDeliveries',
        summary: 'Replay alerts that failed but are still retryable',
        description: 'Forces the replay sweep the cron runs every ~5 minutes. Re-POSTs stored alerts whose delivery failed transiently (5xx, 429, 408, or no reply at all), updating each log row in place rather than creating a new one. Attempts are capped, after which an entry becomes `dead`; a receiver that rejects the request itself (404, 401, 410) is marked `permanent` and never replayed. Admin-gated because it fires outbound POSTs at the configured receiver.',
        responses: {
          200: { description: 'Sweep summary — { ok, retried, delivered, failed, dead, permanent, pending }' },
          401: { description: 'Missing or wrong X-Admin-Key' },
          503: { description: 'ADMIN_KEY not configured — route unavailable (fails closed)' },
        },
      },
    },
    '/about': {
      get: { tags: ['meta'], operationId: 'about', summary: 'Agent identity + self-describing endpoint catalog', responses: { 200: { description: 'About' } } },
    },
    '/status': {
      get: { tags: ['meta'], operationId: 'status', summary: 'Live status + uptime', responses: { 200: { description: 'Status' } } },
    },
  },
  security: [{}, { apiKey: [] }],
};
