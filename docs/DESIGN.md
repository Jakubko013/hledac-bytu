# hledač bytu – design (approved 2026-11-08)

Autonomous daily crawler of Czech real-estate portals + private ranked dashboard. Hosted on Netlify (Personal plan). Users: 2 (owner + partner), **all state shared** (criteria, favorites, hidden, notes) – no per-user data.

## Stack
- Astro 7 (was 5; `@astrojs/netlify@8` requires `astro@^7`, latest at scaffold time), SSR, `@astrojs/netlify`; minimal islands (criteria form). TypeScript strict.
- Netlify Database (managed Postgres) + Drizzle (`@netlify/database`, `drizzle-orm@beta`, `drizzle-kit@beta`, `drizzle-orm/netlify-db`). Migrations in `netlify/database/migrations/`, env `NETLIFY_DB_URL`. Fallback if unavailable on plan: Neon via `DATABASE_URL` (keep DB access behind `db/index.ts` so swapping is one file).
- TypeScript 6 (not 7: `@astrojs/check` peer is ^5 || ^6). DB client: `createDb()` in `db/index.ts` uses `drizzle({ client: getDatabase({ connectionString }), schema })` from `drizzle-orm/netlify-db` + `@netlify/database`; connection string `NETLIFY_DB_URL ?? DATABASE_URL`. Netlify Database is available on Credit-based plans (Free/Personal/Pro), compute+bandwidth consume credits (Personal: 1,000/month), storage free until 2026-07-01 per docs.
- Zod (validation), cheerio (HTML). Vitest. No other runtime deps without approval.

## Crawler runtime
- Crawler core is plain Node/TS in `src/crawler/` with NO Netlify-specific imports; entry `runPortal(portal, ctx)` and `runAll(ctx)`.
- Primary: Netlify `netlify/functions/crawl-dispatch.mts` (scheduled `0 4 * * *` UTC) → POST `/.netlify/functions/crawl-portal-background` per portal with `x-crawl-secret`; background fn runs one portal (15 min limit).
- Fallback (user-preferred over paid proxy if portals block Netlify IPs): `.github/workflows/crawl.yml` (cron + workflow_dispatch) runs `scripts/crawl.ts` → `runAll`, writing to the same DB via secret DB URL. Both entry points share the core.
- Polite: 1–2 s delay, realistic UA, page cap per run, retries with backoff, idempotent upsert on `(portal, external_id)`.

## Portals
MVP: Sreality (JSON `https://www.sreality.cz/api/v1/estates/search?...`; v2 is dead/404), Bezrealitky (`__NEXT_DATA__` from search page; bare GraphQL POST → 403), iDNES Reality (HTML/cheerio). Later: UlovDomov, Reality.cz, Realitymix.
Contract: `interface PortalAdapter { id: Portal; fetch(q: CrawlQuery, ctx: CrawlCtx): AsyncIterable<NormalizedListing> }`. Zod-validate every payload; parse failure → run `partial`/`failed`.

## Data model (`db/schema.ts`)
- `listing`: id, portal, external_id (unique w/ portal), url, title, offer_type (rent|sale), price_czk, fees_czk, area_m2, layout ("2+kk"), floor, condition (`new_build|renovated|good|needs_renovation|unknown`), has_balcony, has_parking, has_elevator, lat, lng, locality_text, city, district, images jsonb, raw jsonb, fingerprint, first_seen_at, last_seen_at, removed_at.
- `price_history`: listing_id, price_czk, observed_at (insert only on change).
- `criteria` (shared): id, name, active, offer_type, city, localities text[], price_min/max, layouts text[], area_min/max, must jsonb, weights jsonb, anchor_lat/lng (defaults to city centre), max_distance_km, created_at, updated_at.
- `match`: criteria_id, listing_id, score, breakdown jsonb, computed_at.
- `listing_state` (shared): listing_id PK, status (new|seen|favorite|hidden), note, updated_at.
- `crawl_run`: id, portal, runner (netlify|github|manual), started_at, finished_at, status (running|ok|partial|failed), pages, fetched, new_count, updated_count, error.
- `login_attempt` for rate limiting.
- Dedup: `fingerprint = hash(offer_type, layout, round(area), round(lat,3), round(lng,3))`; dashboard groups by fingerprint, shows the best-scored copy (ties → cheapest), "také na: …".

## Scoring (`src/scoring/`, pure functions)
Hard filters (SQL): offer_type, city/localities, price range, layouts, area range, `must` extras; exclude hidden/removed.
Soft score `100 · Σ wᵢ·sᵢ / Σ wᵢ`, sᵢ ∈ [0,1]. **Primary factors chosen by user (highest default weights): price/m², distance to centre, condition, area.**
- price_per_m2: `clamp(0.5 + (median − x)/median)`, median over current candidates of the criteria.
- distance_to_centre: haversine to anchor (city centre preset, e.g. Brno 49.1951,16.6068; Praha 50.0875,14.4213; editable), `clamp(1 − d/max_distance_km)`; missing coords → 0.5.
- area: `clamp((a − area_min)/(area_max − area_min))`; if a bound is missing use p10/p90 of current candidates' area.
- condition: new_build 1.0, renovated 0.9, good 0.5, unknown 0.4, needs_renovation 0.1.
Secondary (low default weight, editable): freshness `exp(−ageDays/7)`, extras 0/1, price_drop 0/1.
Defaults: price_per_m2 3, distance 3, condition 3, area 3, freshness 1, extras 0.5, price_drop 0.5. Breakdown stored and shown in UI.
Condition extraction: from portal fields (Sreality "Stav objektu"/building condition, Bezrealitky condition/"novostavba", iDNES params) + keyword fallback on title/description ("novostavba", "po rekonstrukci", "k rekonstrukci").

## Auth
Netlify Identity deprecated → env `APP_USERS` (`user:scryptHash,user2:scryptHash`), `SESSION_SECRET` HMAC-signed cookie (HttpOnly, Secure, SameSite=Lax, 30 d). `src/middleware.ts` guards everything except `/login` and crawl endpoints (those require `CRAWL_SECRET`). Login rate-limited via DB.

## Env
`APP_USERS`, `SESSION_SECRET`, `CRAWL_SECRET`, `NETLIFY_DB_URL` (injected) / `DATABASE_URL` (GitHub Actions + fallback).

## Structure
```
astro.config.mjs netlify.toml drizzle.config.ts .env.example package.json tsconfig.json
db/schema.ts db/index.ts
netlify/database/migrations/
netlify/functions/crawl-dispatch.mts crawl-portal-background.mts
scripts/crawl.ts  scripts/hash-password.ts
.github/workflows/ci.yml crawl.yml
src/crawler/types.ts http.ts upsert.ts fingerprint.ts condition.ts run.ts portals/{sreality,bezrealitky,idnes}.ts
src/scoring/score.ts rescore.ts
src/lib/auth.ts src/middleware.ts
src/pages/index.astro criteria/index.astro criteria/[id].astro listing/[id].astro health.astro login.astro api/*.ts
tests/ (vitest, fixtures in tests/fixtures/)
```

## Risks
Portal ToS (personal use, 1×/day, low rate, no republishing) – accepted by user. Datacenter IP blocking → GitHub Actions fallback. Endpoint changes → Zod + health page + fixture tests. Netlify DB availability/cost on Personal plan → verify, fallback Neon.
