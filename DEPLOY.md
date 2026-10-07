# Deploying to Envio Cloud

Status: **not yet deployed, and the build has not been verified locally.** Work
through section 1 first.

## 1. Verify the build (blocking)

Nothing below matters until this passes. The cloud build generates code in a
Dagger job, so a type error here is a failed deployment there, not a local
inconvenience.

```bash
cp .env.example .env     # set ENVIO_API_TOKEN at minimum
pnpm i
pnpm build               # tsc --noEmit
pnpm test -u             # -u records the empty indexer.test.ts snapshot
```

There is no separate codegen step: envio >= 3.14 runs codegen as part of
`envio start` and `envio dev`. The `pnpm codegen` script is still there if you
want to regenerate types without starting the indexer — for instance before
`pnpm build` on a fresh checkout, since `tsc` reads the generated types and
nothing has produced them yet.

Then **read** the recorded snapshot rather than accepting it. It is the only
end-to-end check that the reworked handlers write what they should, and it was
deliberately emptied because the upstream recording was for a schema with
`Tick`, `ModifyLiquidity`, `PoolManager` and `Position` entities.

Then a bounded live run, which is what actually proves the candles:

```bash
pnpm envio dev
```

Check, against one chain and a few thousand blocks:

- `TokenCandle` rows appear at all four intervals, and two swaps in the same
  minute land in one `1m` row with `swapCount: 2` and a preserved `open`.
- `PoolCandle.close` for a known pool matches `Pool.token1Price`, i.e. one
  token0 priced in token1. If the chart looks inverted, the `prices[1]`
  choice in `swap-handler.ts` is the thing to check.
- `Token.priceUSD` for WETH is plausible, and `isPriceable` is false for a
  token with no whitelisted route.
- `Token.lastUpdatedTimestamp` advances on swaps but **not** on liquidity
  events, which is deliberate: it is the price's `asOf`.

Record the measured row count per entity for that range. The footprint
reasoning in `envio-apis` `plans/2026-10-07-dex-prices-indexer-fork.md` §10 is
an argument until that number exists.

## 2. Decide the chain set

`config.yaml` has **18 chains, all from block 0**. That is the upstream
dashboard's scope, not necessarily this API's. The reference point: the
upstream production deployment measured **1437 GiB of Postgres** for that
scope with no price history (`envio-apis` decision 0010, from the wiki
incident). Candles add to it.

Which chains the hosted DEX Prices API serves at launch is still open
(decision 0005). Launching with fewer and adding later is cheap; the reverse
is not. Nothing in this repo needs to change to cut the set — remove chain
entries from `config.yaml`.

## 3. Warm the token metadata cache

`getTokenMetadata` resolves name, symbol and decimals over **RPC**, not
HyperSync. A cold cache means refetching every token on every chain: 15.1
million rows at the last count.

The cache is not in git (too large). See `.envio/cache/linkToLatestCache.txt`
for the Drive archive and the **per-chain** layout — a flat
`getTokenMetadata.tsv` is silently ignored under
`disable_default_cross_chain: true`, and the dead 86 MB flat file inherited
from upstream has been deleted from this repository for that reason.

For the cloud, this is the `ENVIO_*_RPC_URL` question in section 4, plus Envio
Cloud's own deployment cache save/restore.

## 4. Set environment variables

Keys must carry the `ENVIO_` prefix, and changes apply on the **next**
deployment.

```bash
envio-cloud indexer env set <indexer> ENVIO_MAINNET_RPC_URL=https://...
# or, from a local file:
envio-cloud indexer env import <indexer> --file .env
```

Every chain falls back to a public `drpc.org` endpoint if unset
(`src/utils/tokenMetadata.ts`). Those fallbacks will rate-limit against a cold
metadata cache across 18 chains, which shows up as a slow sync rather than an
error. Set real endpoints for whichever chains section 2 keeps. All 18 keys are
listed in `.env.example`.

`ENVIO_API_TOKEN` is needed to run the indexer and for the HyperSync replay
test. It is **optional in CI**: `src/indexer.test.ts` skips itself when the
token is absent, so the workflow is green on a repository with no secret and
still runs the pure unit tests. Add the secret only if you want the
end-to-end test to run on every push.

## 5. Create the indexer and deploy

```bash
npx envio-cloud login
npx envio-cloud config set-org enviodev
npx envio-cloud indexer add \
  --name dex-prices-indexer \
  --repo enviodev/dex-prices-indexer \
  --branch main --dry-run      # drop --dry-run when the output looks right
npx envio-cloud indexer settings get dex-prices-indexer
```

Then deploy and watch:

```bash
npx envio-cloud deployment status dex-prices-indexer <commit> --watch-till-synced
npx envio-cloud deployment logs dex-prices-indexer <commit> --build
npx envio-cloud deployment logs dex-prices-indexer <commit> --level error,warn --follow
npx envio-cloud deployment endpoint dex-prices-indexer <commit>
```

Promote only after the endpoint answers the queries in section 6:

```bash
npx envio-cloud deployment promote dex-prices-indexer <commit> --yes
```

A deploy also triggers on push to the configured branch if auto-deploy is on
(`indexer settings`). The reworked code currently sits on
`feat/dex-prices-schema`, **not** `main`, because section 1 is unverified.
Merging it to `main` with auto-deploy on will deploy it.

## 6. Smoke queries against the deployed endpoint

```graphql
{
  Token(where: {symbol: {_eq: "WETH"}, chainId: {_eq: 1}}) {
    priceUSD isPriceable lastUpdatedTimestamp lastUpdatedBlock
  }
  TokenCandle(
    where: {interval: {_eq: "1h"}}
    order_by: {bucketStart: desc}
    limit: 5
  ) { bucketStart open high low close volumeUSD swapCount }
  Pool(order_by: {volumeUSD: desc}, limit: 5) {
    id dex feeTier lastSwapFee hooks volumeUSD totalValueLockedUSD
  }
}
```

What to look for: `high >= open,close >= low` on every candle;
`feeTier != lastSwapFee` only on dynamic-fee pools; `priceUSD` non-zero
wherever `isPriceable` is true.

## 7. Known gaps at deploy time

- **24-hour volume cannot be a sort key.** `PoolCandle` at `1h` gives 24-hour
  volume for *one* pool as a sum of 24 rows, but a pool *list* sorted by
  24-hour volume cannot be served that way. `/pools?sort=volume` sorts on
  lifetime `volumeUSD` until the endpoint design (`envio-apis` P1-11) decides
  otherwise. The API docs and landing page must say so.
- **`poolsToSkip`** in `src/utils/chains.ts` is a hand-maintained per-chain
  denylist inherited from upstream. For a paid API it is a maintenance surface
  with no owner yet.
- **The pricing logic is a copy.** A fix to `findNativePerToken` or
  `MAX_PRICING_POOL_VALUE_IMBALANCE` in `enviodev/uniswap-v4-indexer` has to be
  pulled across by hand via the `upstream` remote. No process enforces it.
- **An 86 MB blob remains in git history** from upstream's flat metadata cache.
  Removed from the tree, not from history; GitHub warns on push.
