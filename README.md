# dex-prices-indexer

The open-source indexer behind the Envio **DEX Prices API**: token prices,
OHLCV candles, pools and swaps computed from onchain DEX trades.

Uniswap V4 today. The name, the schema and the handler layout are built so a
second DEX is an added contract and handler rather than a second repository —
see [Adding a DEX](#adding-a-dex).

Licensed under the [MIT License](./LICENSE).

## Relationship to `uniswap-v4-indexer`

This is a detached copy of
[`enviodev/uniswap-v4-indexer`](https://github.com/enviodev/uniswap-v4-indexer),
seeded with its full history at `91fed44`, not a GitHub fork. The upstream
repository powers [v4.xyz](https://v4.xyz) and keeps the liquidity, tick and
position views that a dashboard needs; this one drops them and adds the price
history an API needs. The two diverge on purpose.

Upstream is configured as a second remote, so pricing fixes can be pulled in
by hand:

```bash
git remote add upstream git@github.com:enviodev/uniswap-v4-indexer.git
git fetch upstream
```

**The pricing core is carried over unchanged** — `findNativePerToken`,
`getTrackedAmountUSD`, `sqrtPriceX96ToTokenPrices` and the
`MAX_PRICING_POOL_VALUE_IMBALANCE` manipulation guard in
`src/utils/pricing.ts`. That guard's 1000x bound was calibrated against a
measurement of 2,584 production pools; do not adjust it without comparable
evidence.

## What it indexes

Three Uniswap V4 `PoolManager` events, on 18 chains: `Initialize`,
`Swap`, `ModifyLiquidity`. Nothing else is declared, because an event with no
handler is never fetched.

| Entity | What it holds |
|---|---|
| `Token` | Current price in native and USD, `isPriceable`, volume, TVL, and `lastUpdated*` so an API can answer "as of" |
| `Pool` | Pool state, configured `feeTier` and `lastSwapFee`, volume, TVL, `hooks` |
| `Swap` | Every trade, with each token's USD price **at that swap** (`priceUSD0`, `priceUSD1`) and a real `blockNumber` column |
| `TokenCandle` | OHLCV of a token's USD price at `1m`, `5m`, `1h`, `1d` |
| `PoolCandle` | OHLCV of a pool's token0-in-token1 price at `1h`, `1d`, and the pool's volume per bucket |
| `TokenWhitelistPools` | The pricing routes a token can be priced through |
| `Bundle` | The chain's native token price in USD, one row per chain |
| `HookStats` | Uniswap V4 hook adoption: pools, swaps, TVL, volume, fees |

### What was dropped from upstream, and why

| Dropped | Why |
|---|---|
| `PoolManager` | No endpoint reads it, and it was the most history-expensive entity in the project: one row per chain, rewritten twice per swap, so it produced as many entity-history rows as `Swap` itself |
| `Tick` | One row per pool per tick boundary, written on every `ModifyLiquidity`. Nothing here reads tick-level liquidity |
| `ModifyLiquidity` (the entity) | The liquidity event log. The **handler** stays — pool and token TVL are what the pricing model gates on, so dropping it would silently degrade every price |
| `Position`, `Transfer`, `Subscribe`, `Unsubscribe` | PositionManager NFT views, along with the whole `PositionManager` contract |
| 12 of the 15 declared `PoolManager` events | An event with no handler is never fetched, so they cost nothing — but they misdescribed the indexer |
| 7 `Pool` fields, the `untracked*` duplicates on `Token` | `collectedFees*`, `liquidityProviderCount`, `observationIndex`, `feesUSDUntracked`, `name`, and the untracked TVL mirrors. Nothing serves them |

### Why `Swap.priceUSD0` / `priceUSD1` exist

A swap's `sqrtPriceX96` gives the pool's token *ratio*, not a USD price.
Converting it to USD later is impossible, because that needs the counter
token's `derivedETH` and the chain's `ethPriceUSD` as they were at that swap,
and neither is historised. So the USD price is written onto the swap row when
it is processed. It is the only honest per-swap USD price, and it is what the
candles are built from.

## Candles

A candle row exists only for a bucket that had a swap, so the row count is
bounded by the number of swaps rather than by `tokens x buckets`: a token with
three swaps in a day produces three `1m` rows, not 1,440.

The cost is write amplification rather than storage: an open candle is
rewritten by every swap in its bucket, and each rewrite is an entity-history
row. Postgres prunes that history back to each chain's safe checkpoint, which
is what makes all four intervals affordable. This project is Postgres-only
(`storage` in `config.yaml`) — if ClickHouse is ever enabled, the candle
entities have to be excluded from it, because it keeps every version forever.

A token with no USD price gets no candle at all. A zero `priceUSD` means no
whitelisted pricing route reached that token, not that it is worthless, and
writing zeroes would make the series lie.

## Adding a DEX

- `Pool.dex` and `Swap.dex` carry the DEX slug; `DEX_UNISWAP_V4` is in
  `src/utils/constants.ts`.
- Pool ids are opaque strings (`{chainId}_{id}`), so a V4 bytes32 pool id and a
  V2/V3 pool address both fit without a schema change.
- `src/utils/chains.ts` holds the per-chain pricing config
  (`stablecoinAddresses`, `whitelistTokens`, `minimumNativeLocked`,
  `wrappedNativeAddress`). It is DEX-independent and shared.
- A new DEX's handler only has to maintain `Pool.token0Price` /
  `token1Price`, TVL and `Token.derivedETH` to join the same price graph. **A
  second DEX widens pricing coverage for every token, not just for its own
  pools** — that is the point of the shared graph.

Not solved: `hooks` and `tickSpacing` are V4 fields a V2 pool has no answer
for, and `Pool.feeTier` assumes one fee per pool.

## Prerequisites

- [Node.js](https://nodejs.org/en/download/current) v24 or newer
- [pnpm](https://pnpm.io/installation) v8 or newer
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

## Quick start

```bash
pnpm i
cp .env.example .env   # then set ENVIO_API_TOKEN
pnpm envio dev         # indexer + GraphQL at http://localhost:8080
```

`envio dev` regenerates types from `config.yaml` and `schema.graphql` on every
start, so there is no separate codegen step. `pnpm codegen` still exists for
regenerating types without starting the indexer.

A warm token-metadata cache matters: see `.envio/cache/linkToLatestCache.txt`.

## Deploying

See [DEPLOY.md](./DEPLOY.md).

## Built with

- [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview)
- [HyperSync](https://docs.envio.dev/docs/HyperSync/overview)
- Pricing and core entity logic derived from the
  [Uniswap V4 Subgraph](https://github.com/Uniswap/v4-subgraph) by way of
  `enviodev/uniswap-v4-indexer`

## Support

- [Discord community](https://discord.com/invite/envio)
- [Envio Docs](https://docs.envio.dev)
