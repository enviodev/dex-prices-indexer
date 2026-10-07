/*
 * OHLCV candle maintenance.
 *
 * A candle row exists only for a bucket that had a swap, so the row count is
 * bounded by swaps rather than by (subjects x buckets): a token with three
 * swaps in a day produces three 1m rows, not 1,440.
 *
 * The cost is write amplification — an open candle is rewritten by every swap
 * in its bucket, and each rewrite is an entity-history row. That is why the
 * candle entities are Postgres-only (`@storage(clickhouse: false)`): Postgres
 * entity history is pruned back to each chain's safe checkpoint, while
 * ClickHouse keeps every version forever. An open candle in ClickHouse is the
 * shape that caused the September 2026 history-bloat incident.
 */
// `envio` exports the context type as EvmOnEventContext; there is no
// `EvmOnEventContext` export (src/utils/pricing.ts aliases it locally).
import type { BigDecimal, EvmOnEventContext } from "envio";
import { ZERO_BD } from "./utils/constants";

export type Interval = { label: string; seconds: bigint };

/** Token USD price candles. */
export const TOKEN_INTERVALS: Interval[] = [
  { label: "1m", seconds: 60n },
  { label: "5m", seconds: 300n },
  { label: "1h", seconds: 3600n },
  { label: "1d", seconds: 86400n },
];

/**
 * Pool candles. 1h and 1d only: no endpoint reads pool-level fine
 * granularity, and 24-hour pool volume is a sum of 24 of the 1h rows.
 */
export const POOL_INTERVALS: Interval[] = [
  { label: "1h", seconds: 3600n },
  { label: "1d", seconds: 86400n },
];

export function bucketStart(timestamp: bigint, seconds: bigint): bigint {
  return timestamp - (timestamp % seconds);
}

export type CandleSpec = {
  id: string;
  interval: string;
  bucketStart: bigint;
};

/**
 * `tokenId` and `poolId` are the chain-namespaced entity ids. The chainId is
 * stripped back out for the candle id so it is not repeated twice.
 */
export function tokenCandleSpecs(
  tokenId: string,
  timestamp: bigint
): CandleSpec[] {
  return TOKEN_INTERVALS.map(({ label, seconds }) => {
    const start = bucketStart(timestamp, seconds);
    return {
      id: `${tokenId}_${label}_${start}`,
      interval: label,
      bucketStart: start,
    };
  });
}

export function poolCandleSpecs(
  poolId: string,
  timestamp: bigint
): CandleSpec[] {
  return POOL_INTERVALS.map(({ label, seconds }) => {
    const start = bucketStart(timestamp, seconds);
    return {
      id: `${poolId}_${label}_${start}`,
      interval: label,
      bucketStart: start,
    };
  });
}

/**
 * Loaded ahead of the `context.isPreload` bail so HyperIndex batches the
 * reads. Candle ids depend only on the timestamp and the subject id, both
 * known before any pricing work, so there is nothing to wait for.
 */
export function loadTokenCandles(
  context: EvmOnEventContext,
  specs: CandleSpec[]
) {
  return Promise.all(specs.map((s) => context.TokenCandle.get(s.id)));
}

export function loadPoolCandles(context: EvmOnEventContext, specs: CandleSpec[]) {
  return Promise.all(specs.map((s) => context.PoolCandle.get(s.id)));
}

type TokenCandleRow = Awaited<ReturnType<typeof loadTokenCandles>>[number];
type PoolCandleRow = Awaited<ReturnType<typeof loadPoolCandles>>[number];

/**
 * Writes one token's candles for this swap.
 *
 * Skipped entirely when the token has no USD price: a zero `priceUSD` means
 * no whitelisted pricing route reached it, not that it is worthless, and
 * writing zeroes would make the series lie.
 */
export function writeTokenCandles(
  context: EvmOnEventContext,
  args: {
    specs: CandleSpec[];
    existing: TokenCandleRow[];
    tokenId: string;
    priceUSD: BigDecimal;
    volumeToken: BigDecimal;
    volumeUSD: BigDecimal;
    timestamp: bigint;
  }
): void {
  const { specs, existing, tokenId, priceUSD, volumeToken, volumeUSD, timestamp } =
    args;
  if (!priceUSD.gt(ZERO_BD)) return;

  specs.forEach((spec, i) => {
    const prev = existing[i];
    context.TokenCandle.set({
      id: spec.id,
      token_id: tokenId,
      interval: spec.interval,
      bucketStart: spec.bucketStart,
      open: prev ? prev.open : priceUSD,
      high: prev && prev.high.gt(priceUSD) ? prev.high : priceUSD,
      low: prev && prev.low.lt(priceUSD) ? prev.low : priceUSD,
      close: priceUSD,
      volumeToken: prev ? prev.volumeToken.plus(volumeToken) : volumeToken,
      volumeUSD: prev ? prev.volumeUSD.plus(volumeUSD) : volumeUSD,
      swapCount: prev ? prev.swapCount + 1n : 1n,
      lastUpdatedTimestamp: timestamp,
    });
  });
}

/**
 * Writes a pool's candles for this swap.
 *
 * `price` is one token0 priced in token1 — i.e. `Pool.token1Price`, which is
 * `sqrtPriceX96ToTokenPrices()[1]`. Note the inherited Uniswap naming is the
 * reverse of how it reads: `token0Price` is token0 *per* token1. Passing
 * `[0]` here would publish every pool chart inverted.
 *
 * Not a USD price, deliberately: a pool's own series should not depend on
 * whether either side happens to be priceable.
 */
export function writePoolCandles(
  context: EvmOnEventContext,
  args: {
    specs: CandleSpec[];
    existing: PoolCandleRow[];
    poolId: string;
    dex: string;
    price: BigDecimal;
    volumeToken0: BigDecimal;
    volumeToken1: BigDecimal;
    volumeUSD: BigDecimal;
    timestamp: bigint;
  }
): void {
  const {
    specs,
    existing,
    poolId,
    dex,
    price,
    volumeToken0,
    volumeToken1,
    volumeUSD,
    timestamp,
  } = args;

  specs.forEach((spec, i) => {
    const prev = existing[i];
    context.PoolCandle.set({
      id: spec.id,
      pool: poolId,
      dex,
      interval: spec.interval,
      bucketStart: spec.bucketStart,
      open: prev ? prev.open : price,
      high: prev && prev.high.gt(price) ? prev.high : price,
      low: prev && prev.low.lt(price) ? prev.low : price,
      close: price,
      volumeToken0: prev ? prev.volumeToken0.plus(volumeToken0) : volumeToken0,
      volumeToken1: prev ? prev.volumeToken1.plus(volumeToken1) : volumeToken1,
      volumeUSD: prev ? prev.volumeUSD.plus(volumeUSD) : volumeUSD,
      swapCount: prev ? prev.swapCount + 1n : 1n,
      lastUpdatedTimestamp: timestamp,
    });
  });
}
