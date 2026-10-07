/*
 * Liquidity events for Uniswap v4 pools.
 *
 * The ModifyLiquidity event entity and the Tick entities are not written here
 * — no DEX Prices endpoint reads them. The handler is kept because pool and
 * token TVL are what the pricing model gates on: findNativePerToken picks a
 * token's pricing route by ETH locked, and minimumNativeLocked and the
 * imbalance guard both compare against it. Dropping this handler would
 * silently degrade every price.
 */
import { indexer } from "envio";
import {
  getAmount0,
  getAmount1,
} from "../utils/liquidityMath/liquidityAmounts";
import { convertTokenToDecimal, sanitizeBD } from "../utils";
import { getChainConfig } from "../utils/chains";

indexer.onEvent(
  { contract: "PoolManager", event: "ModifyLiquidity" },
  async ({ event, context }) => {
    const chainConfig = getChainConfig(event.chainId);

    if (chainConfig.poolsToSkip.includes(event.params.id)) {
      return;
    }

    const poolId = `${event.chainId}_${event.params.id}`;

    const existingPool = await context.Pool.get(poolId);
    if (!existingPool) return;

    const isHookedPool =
      existingPool.hooks !== "0x0000000000000000000000000000000000000000";
    const hookStatsId = isHookedPool
      ? `${event.chainId}_${existingPool.hooks}`
      : undefined;

    const [existingToken0, existingToken1, bundle, existingHookStats] =
      await Promise.all([
        context.Token.get(existingPool.token0),
        context.Token.get(existingPool.token1),
        context.Bundle.get(event.chainId.toString()),
        hookStatsId ? context.HookStats.get(hookStatsId) : undefined,
      ]);
    if (!existingToken0 || !existingToken1 || !bundle) return;

    if (context.isPreload) {
      return;
    }

    const currTick = existingPool.tick ?? 0n;
    const currSqrtPriceX96 = existingPool.sqrtPrice ?? 0n;
    // Token amounts implied by the liquidity change
    const amount0Raw = getAmount0(
      event.params.tickLower,
      event.params.tickUpper,
      currTick,
      event.params.liquidityDelta,
      currSqrtPriceX96
    );
    const amount1Raw = getAmount1(
      event.params.tickLower,
      event.params.tickUpper,
      currTick,
      event.params.liquidityDelta,
      currSqrtPriceX96
    );
    const amount0 = convertTokenToDecimal(amount0Raw, existingToken0.decimals);
    const amount1 = convertTokenToDecimal(amount1Raw, existingToken1.decimals);

    let pool = {
      ...existingPool,
      txCount: existingPool.txCount + 1n,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
      lastUpdatedBlock: BigInt(event.block.number),
      totalValueLockedToken0: existingPool.totalValueLockedToken0.plus(amount0),
      totalValueLockedToken1: existingPool.totalValueLockedToken1.plus(amount1),
    };
    // Liquidity only moves if the position straddles the current tick
    if (
      pool.tick !== null &&
      pool.tick !== undefined &&
      event.params.tickLower <= pool.tick &&
      event.params.tickUpper > pool.tick
    ) {
      pool = {
        ...pool,
        liquidity: pool.liquidity + event.params.liquidityDelta,
      };
    }

    // Token.lastUpdated* is deliberately NOT stamped here. It is what the API
    // reports as a price's `asOf`, and this handler does not recompute
    // derivedETH or priceUSD — moving it forward would claim a freshness the
    // price does not have. Pool.lastUpdated* is stamped, because pool state
    // really did change.
    let token0 = {
      ...existingToken0,
      txCount: existingToken0.txCount + 1n,
      totalValueLocked: existingToken0.totalValueLocked.plus(amount0),
    };
    let token1 = {
      ...existingToken1,
      txCount: existingToken1.txCount + 1n,
      totalValueLocked: existingToken1.totalValueLocked.plus(amount1),
    };

    const currentPoolTvlUSD = pool.totalValueLockedUSD;
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
    token0 = {
      ...token0,
      totalValueLockedUSD: token0.totalValueLocked.times(
        token0.derivedETH.times(bundle.ethPriceUSD)
      ),
    };
    token1 = {
      ...token1,
      totalValueLockedUSD: token1.totalValueLocked.times(
        token1.derivedETH.times(bundle.ethPriceUSD)
      ),
    };

    if (isHookedPool && existingHookStats) {
      context.HookStats.set({
        ...existingHookStats,
        totalValueLockedUSD: existingHookStats.totalValueLockedUSD
          .minus(currentPoolTvlUSD)
          .plus(pool.totalValueLockedUSD),
      });
    }

    context.Pool.set(pool);
    context.Token.set(token0);
    context.Token.set(token1);
  }
);
