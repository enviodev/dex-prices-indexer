/*
 * Swap events for Uniswap v4 pools.
 *
 * The pricing core this calls (findNativePerToken, getTrackedAmountUSD,
 * sqrtPriceX96ToTokenPrices and the imbalance guard) is carried over from
 * enviodev/uniswap-v4-indexer unchanged. It was calibrated against production
 * data and should not be adjusted here without the same evidence.
 */
import { indexer, BigDecimal, type Swap } from "envio";
import { getChainConfig } from "../utils/chains";
import { convertTokenToDecimal } from "../utils";
import { getTrackedAmountUSD, getNativePriceInUSD } from "../utils/pricing";
import { safeDiv, sanitizeBD } from "../utils/index";
import { findNativePerToken } from "../utils/pricing";
import { sqrtPriceX96ToTokenPrices } from "../utils/pricing";
import { DEX_UNISWAP_V4, ZERO_BD } from "../utils/constants";
import {
  loadPoolCandles,
  loadTokenCandles,
  poolCandleSpecs,
  tokenCandleSpecs,
  writePoolCandles,
  writeTokenCandles,
} from "../candles";

indexer.onEvent({ contract: "PoolManager", event: "Swap" }, async ({ event, context }) => {
  const chainConfig = getChainConfig(event.chainId);

  let [pool, bundle, ethPriceUSD] = await Promise.all([
    context.Pool.get(`${event.chainId}_${event.params.id}`),
    context.Bundle.get(event.chainId.toString()),
    getNativePriceInUSD(
      context,
      event.chainId.toString(),
      chainConfig.stablecoinWrappedNativePoolId,
      chainConfig.stablecoinIsToken0
    ),
  ]);

  if (!pool) {
    return;
  }

  let token0;
  let token1;
  let poolHookStats;

  const isHookedPool =
    pool.hooks !== "0x0000000000000000000000000000000000000000";

  [token0, token1, poolHookStats] = await Promise.all([
    context.Token.get(pool.token0),
    context.Token.get(pool.token1),
    isHookedPool
      ? context.HookStats.get(`${event.chainId}_${pool.hooks}`)
      : undefined,
    ,
  ]);

  if (!token0 || !token1) {
    return;
  }

  // Check if this pool should be skipped
  // NOTE: Subgraph only has this check in Initialize handler since skipped pools
  // are never created, but we keep it here for safety in case we switch to
  // getOrThrow APIs in the future and don't want exceptions thrown
  if (chainConfig.poolsToSkip.includes(event.params.id)) {
    return;
  }

  bundle = bundle || {
    id: event.chainId.toString(),
    ethPriceUSD: new BigDecimal("0"),
  };

  // Update tokens' derivedETH values first
  const [token0DerivedETH, token1DerivedETH] = await Promise.all([
    findNativePerToken(
      context,
      token0,
      chainConfig.wrappedNativeAddress,
      chainConfig.stablecoinAddresses,
      chainConfig.minimumNativeLocked
    ),
    findNativePerToken(
      context,
      token1,
      chainConfig.wrappedNativeAddress,
      chainConfig.stablecoinAddresses,
      chainConfig.minimumNativeLocked
    ),
  ]);
  token0 = { ...token0, derivedETH: sanitizeBD(token0DerivedETH) };
  token1 = { ...token1, derivedETH: sanitizeBD(token1DerivedETH) };

  // Candle ids depend only on the timestamp and the subject id, so they are
  // known here and the reads batch with everything else in the preload pass.
  const timestamp = BigInt(event.block.timestamp);
  const poolId = `${event.chainId}_${event.params.id}`;
  const token0CandleSpecs = tokenCandleSpecs(token0.id, timestamp);
  const token1CandleSpecs = tokenCandleSpecs(token1.id, timestamp);
  const poolSpecs = poolCandleSpecs(poolId, timestamp);
  const [token0Candles, token1Candles, poolCandles] = await Promise.all([
    loadTokenCandles(context, token0CandleSpecs),
    loadTokenCandles(context, token1CandleSpecs),
    loadPoolCandles(context, poolSpecs),
  ]);

  if (context.isPreload) {
    return;
  }

  const prices = sqrtPriceX96ToTokenPrices(
    event.params.sqrtPriceX96,
    token0,
    token1,
    chainConfig.nativeTokenDetails
  );
  // Convert amounts using proper decimal handling
  // Unlike V3, a negative amount represents that amount is being sent to the pool and vice versa, so invert the sign
  const amount0 = convertTokenToDecimal(
    event.params.amount0,
    token0.decimals
  ).times(new BigDecimal("-1"));
  const amount1 = convertTokenToDecimal(
    event.params.amount1,
    token1.decimals
  ).times(new BigDecimal("-1"));
  // Get absolute amounts for volume
  const amount0Abs = amount0.lt(new BigDecimal("0"))
    ? amount0.times(new BigDecimal("-1"))
    : amount0;
  const amount1Abs = amount1.lt(new BigDecimal("0"))
    ? amount1.times(new BigDecimal("-1"))
    : amount1;
  const amount0ETH = amount0Abs.times(token0.derivedETH);
  const amount1ETH = amount1Abs.times(token1.derivedETH);
  const amount0USD = amount0ETH.times(bundle.ethPriceUSD);
  const amount1USD = amount1ETH.times(bundle.ethPriceUSD);
  // Get tracked amount USD
  const trackedAmountUSD = await getTrackedAmountUSD(
    context,
    amount0Abs,
    token0,
    amount1Abs,
    token1,
    event.chainId.toString(),
    chainConfig.whitelistTokens
  );
  const amountTotalUSDTracked = trackedAmountUSD.div(new BigDecimal("2"));
  const amountTotalETHTracked = safeDiv(
    amountTotalUSDTracked,
    bundle.ethPriceUSD
  );
  const amountTotalUSDUntracked = amount0USD
    .plus(amount1USD)
    .div(new BigDecimal("2"));
  // Calculate fees
  // The fee actually paid, which is what upstream computed too — it assigned
  // event.params.fee to pool.feeTier before using it. Here feeTier keeps the
  // configured fee, so the swap fee is read from the event directly.
  const swapFee = new BigDecimal(event.params.fee.toString());
  const feesETH = amountTotalETHTracked
    .times(swapFee)
    .div(new BigDecimal("1000000"));
  const feesUSD = amountTotalUSDTracked
    .times(swapFee)
    .div(new BigDecimal("1000000"));
  // Store current pool TVL values for later calculations
  const currentPoolTvlUSD = pool.totalValueLockedUSD;
  pool = {
    ...pool,
    // feeTier is the configured fee and is never rewritten; the per-swap
    // effective fee goes to lastSwapFee and onto the Swap row.
    lastSwapFee: BigInt(event.params.fee),
    txCount: pool.txCount + 1n,
    lastUpdatedTimestamp: timestamp,
    lastUpdatedBlock: BigInt(event.block.number),
    sqrtPrice: event.params.sqrtPriceX96,
    tick: event.params.tick,
    token0Price: prices[0],
    token1Price: prices[1],
    totalValueLockedToken0: pool.totalValueLockedToken0.plus(amount0),
    totalValueLockedToken1: pool.totalValueLockedToken1.plus(amount1),
    liquidity: event.params.liquidity,
    volumeToken0: pool.volumeToken0.plus(amount0Abs),
    volumeToken1: pool.volumeToken1.plus(amount1Abs),
    volumeUSD: sanitizeBD(pool.volumeUSD.plus(amountTotalUSDTracked)),
    untrackedVolumeUSD: pool.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
    feesUSD: pool.feesUSD.plus(feesUSD),
  };
  pool = {
    ...pool,
    totalValueLockedETH: pool.totalValueLockedToken0
      .times(token0.derivedETH)
      .plus(pool.totalValueLockedToken1.times(token1.derivedETH)),
  };
  pool = {
    ...pool,
    totalValueLockedUSD: sanitizeBD(
      pool.totalValueLockedETH.times(bundle.ethPriceUSD)
    ),
  };
  // Price in USD, written here so the price endpoint is one read. Uses the
  // same bundle.ethPriceUSD as every other USD figure on this swap: the
  // freshly read ethPriceUSD is written to Bundle at the end, so using it
  // here would make Token.priceUSD disagree with Swap.amountUSD on the same
  // swap. Upstream had the same one-swap lag.
  const priceUSD0 = sanitizeBD(token0.derivedETH.times(bundle.ethPriceUSD));
  const priceUSD1 = sanitizeBD(token1.derivedETH.times(bundle.ethPriceUSD));

  token0 = {
    ...token0,
    priceUSD: priceUSD0,
    isPriceable: token0.derivedETH.gt(ZERO_BD),
    lastUpdatedTimestamp: timestamp,
    lastUpdatedBlock: BigInt(event.block.number),
    volume: token0.volume.plus(amount0Abs),
    totalValueLocked: token0.totalValueLocked.plus(amount0),
    volumeUSD: token0.volumeUSD.plus(amountTotalUSDTracked),
    feesUSD: token0.feesUSD.plus(feesUSD),
    txCount: token0.txCount + 1n,
  };
  token1 = {
    ...token1,
    priceUSD: priceUSD1,
    isPriceable: token1.derivedETH.gt(ZERO_BD),
    lastUpdatedTimestamp: timestamp,
    lastUpdatedBlock: BigInt(event.block.number),
    volume: token1.volume.plus(amount1Abs),
    totalValueLocked: token1.totalValueLocked.plus(amount1),
    volumeUSD: token1.volumeUSD.plus(amountTotalUSDTracked),
    feesUSD: token1.feesUSD.plus(feesUSD),
    txCount: token1.txCount + 1n,
  };
  token0 = {
    ...token0,
    totalValueLockedUSD: token0.totalValueLocked.times(priceUSD0),
  };
  token1 = {
    ...token1,
    totalValueLockedUSD: token1.totalValueLocked.times(priceUSD1),
  };
  // Use for USD swap amount
  const finalAmountUSD = amountTotalUSDTracked.gt(new BigDecimal("0"))
    ? amountTotalUSDTracked
    : amountTotalUSDUntracked;

  const entity: Swap = {
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    dex: DEX_UNISWAP_V4,
    transaction: event.transaction.hash,
    blockNumber: BigInt(event.block.number),
    timestamp: timestamp,
    pool: poolId,
    token0_id: token0.id,
    token1_id: token1.id,
    sender: event.params.sender,
    origin: event.transaction.from || "NONE",
    amount0: amount0,
    amount1: amount1,
    amountUSD: sanitizeBD(finalAmountUSD),
    priceUSD0: priceUSD0,
    priceUSD1: priceUSD1,
    sqrtPriceX96: event.params.sqrtPriceX96,
    tick: event.params.tick,
    logIndex: BigInt(event.logIndex),
    fee: BigInt(event.params.fee),
  };
  context.Bundle.set({
    ...bundle,
    ethPriceUSD: sanitizeBD(ethPriceUSD),
  });
  context.Pool.set(pool);
  context.Swap.set(entity);
  context.Token.set(token0);
  context.Token.set(token1);

  // OHLCV. Each side of the pool gets its own USD series; the pool gets one
  // series of one token0 priced in token1 (prices[1] — see writePoolCandles).
  writeTokenCandles(context, {
    specs: token0CandleSpecs,
    existing: token0Candles,
    tokenId: token0.id,
    priceUSD: priceUSD0,
    volumeToken: amount0Abs,
    volumeUSD: sanitizeBD(finalAmountUSD),
    timestamp,
  });
  writeTokenCandles(context, {
    specs: token1CandleSpecs,
    existing: token1Candles,
    tokenId: token1.id,
    priceUSD: priceUSD1,
    volumeToken: amount1Abs,
    volumeUSD: sanitizeBD(finalAmountUSD),
    timestamp,
  });
  writePoolCandles(context, {
    specs: poolSpecs,
    existing: poolCandles,
    poolId,
    dex: DEX_UNISWAP_V4,
    price: prices[1],
    volumeToken0: amount0Abs,
    volumeToken1: amount1Abs,
    volumeUSD: sanitizeBD(finalAmountUSD),
    timestamp,
  });

  // After processing the swap, update HookStats if it's a hooked pool
  if (poolHookStats) {
    // Calculate volume and fees, using untracked volume as fallback
    const volumeToAdd = amountTotalUSDTracked.gt(new BigDecimal("0"))
      ? amountTotalUSDTracked
      : amountTotalUSDUntracked;

    // Calculate fees based on the volume we're using (use the same calculation as earlier in the code)
    const feesToAdd = amountTotalUSDTracked.gt(new BigDecimal("0"))
      ? feesUSD
      : amountTotalUSDUntracked.times(
          swapFee.div(new BigDecimal("1000000"))
        );

    context.HookStats.set({
      ...poolHookStats,
      numberOfSwaps: poolHookStats.numberOfSwaps + 1n,
      totalVolumeUSD: poolHookStats.totalVolumeUSD.plus(volumeToAdd), // right now this is includes untracked volume
      untrackedVolumeUSD: poolHookStats.untrackedVolumeUSD.plus(
        amountTotalUSDUntracked
      ),
      totalFeesUSD: poolHookStats.totalFeesUSD.plus(feesToAdd),
      totalValueLockedUSD: poolHookStats.totalValueLockedUSD
        .minus(currentPoolTvlUSD) // Remove old TVL
        .plus(pool.totalValueLockedUSD), // Add new TVL
    });
  }
});
