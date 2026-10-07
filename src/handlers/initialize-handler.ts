/*
 * Pool creation for Uniswap v4.
 */

import { indexer, BigDecimal, type EvmOnEventContext } from "envio";
import { getChainConfig } from "../utils/chains";
import { sqrtPriceX96ToTokenPrices } from "../utils/pricing";
import { getTokenMetadata } from "../utils/tokenMetadata";
import { findNativePerToken } from "../utils/pricing";
import { sanitizeBD } from "../utils";
import { ADDRESS_ZERO, DEX_UNISWAP_V4, ZERO_BD } from "../utils/constants";

/** Appends a pool to a token's pricing whitelist (TokenWhitelistPools). */
async function addWhitelistPool(
  context: EvmOnEventContext,
  tokenId: string,
  poolId: string
): Promise<void> {
  const existing = await context.TokenWhitelistPools.get(tokenId);
  context.TokenWhitelistPools.set({
    id: tokenId,
    pools: [...(existing?.pools ?? []), poolId],
  });
}

indexer.onEvent(
  { contract: "PoolManager", event: "Initialize" },
  async ({ event, context }) => {
    const chainConfig = getChainConfig(event.chainId);

    if (chainConfig.poolsToSkip.includes(event.params.id)) {
      return;
    }

    const isHookedPool = event.params.hooks !== ADDRESS_ZERO;
    const timestamp = BigInt(event.block.timestamp);
    const blockNumber = BigInt(event.block.number);

    // The chain's native-price row. Upstream created this as a side effect of
    // creating the PoolManager entity, which this schema does not have, so it
    // is created here instead.
    const bundle = await context.Bundle.get(event.chainId.toString());
    if (!bundle) {
      context.Bundle.set({
        id: event.chainId.toString(),
        ethPriceUSD: ZERO_BD,
      });
    }

    if (isHookedPool) {
      const hookStatsId = `${event.chainId}_${event.params.hooks}`;
      let hookStats = await context.HookStats.get(hookStatsId);

      if (!hookStats) {
        hookStats = {
          id: hookStatsId,
          numberOfPools: 0n,
          numberOfSwaps: 0n,
          firstPoolCreatedAt: timestamp,
          totalValueLockedUSD: ZERO_BD,
          totalVolumeUSD: ZERO_BD,
          untrackedVolumeUSD: ZERO_BD,
          totalFeesUSD: ZERO_BD,
        };
      }

      context.HookStats.set({
        ...hookStats,
        numberOfPools: hookStats.numberOfPools + 1n,
      });
    }

    const token0Id = `${event.chainId}_${event.params.currency0.toLowerCase()}`;
    let token0 = await context.Token.get(token0Id);
    if (!token0) {
      const metadata = await context.effect(getTokenMetadata, {
        address: event.params.currency0,
        chainId: event.chainId,
      });
      token0 = {
        id: token0Id,
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: BigInt(metadata.decimals),
        totalSupply: 0n,
        derivedETH: ZERO_BD,
        priceUSD: ZERO_BD,
        isPriceable: false,
        lastUpdatedTimestamp: timestamp,
        lastUpdatedBlock: blockNumber,
        volume: ZERO_BD,
        volumeUSD: ZERO_BD,
        feesUSD: ZERO_BD,
        txCount: 0n,
        poolCount: 1n,
        totalValueLocked: ZERO_BD,
        totalValueLockedUSD: ZERO_BD,
      };
    } else {
      token0 = {
        ...token0,
        poolCount: token0.poolCount + 1n,
      };
    }

    const token1Id = `${event.chainId}_${event.params.currency1.toLowerCase()}`;
    let token1 = await context.Token.get(token1Id);
    if (!token1) {
      const metadata = await context.effect(getTokenMetadata, {
        address: event.params.currency1,
        chainId: event.chainId,
      });
      token1 = {
        id: token1Id,
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: BigInt(metadata.decimals),
        totalSupply: 0n,
        derivedETH: ZERO_BD,
        priceUSD: ZERO_BD,
        isPriceable: false,
        lastUpdatedTimestamp: timestamp,
        lastUpdatedBlock: blockNumber,
        volume: ZERO_BD,
        volumeUSD: ZERO_BD,
        feesUSD: ZERO_BD,
        txCount: 0n,
        poolCount: 1n,
        totalValueLocked: ZERO_BD,
        totalValueLockedUSD: ZERO_BD,
      };
    } else {
      token1 = {
        ...token1,
        poolCount: token1.poolCount + 1n,
      };
    }

    const poolId = `${event.chainId}_${event.params.id}`;

    // A pool is a pricing route for the token on the other side of a
    // whitelisted token.
    if (
      chainConfig.whitelistTokens.includes(event.params.currency0.toLowerCase())
    ) {
      await addWhitelistPool(context, token1Id, poolId);
    }

    if (
      chainConfig.whitelistTokens.includes(event.params.currency1.toLowerCase())
    ) {
      await addWhitelistPool(context, token0Id, poolId);
    }

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

    if (context.isPreload) {
      return;
    }

    const ethPriceUSD = bundle?.ethPriceUSD ?? ZERO_BD;
    token0 = {
      ...token0,
      priceUSD: sanitizeBD(token0.derivedETH.times(ethPriceUSD)),
      isPriceable: token0.derivedETH.gt(ZERO_BD),
      lastUpdatedTimestamp: timestamp,
      lastUpdatedBlock: blockNumber,
    };
    token1 = {
      ...token1,
      priceUSD: sanitizeBD(token1.derivedETH.times(ethPriceUSD)),
      isPriceable: token1.derivedETH.gt(ZERO_BD),
      lastUpdatedTimestamp: timestamp,
      lastUpdatedBlock: blockNumber,
    };

    const prices = sqrtPriceX96ToTokenPrices(
      event.params.sqrtPriceX96,
      token0,
      token1,
      chainConfig.nativeTokenDetails
    );

    context.Pool.set({
      id: poolId,
      dex: DEX_UNISWAP_V4,
      createdAtTimestamp: timestamp,
      createdAtBlockNumber: blockNumber,
      lastUpdatedTimestamp: timestamp,
      lastUpdatedBlock: blockNumber,
      token0: token0Id,
      token1: token1Id,
      // The configured fee. Never rewritten; the per-swap effective fee of a
      // dynamic-fee pool lands on lastSwapFee and on each Swap row.
      feeTier: BigInt(event.params.fee),
      lastSwapFee: BigInt(event.params.fee),
      liquidity: 0n,
      sqrtPrice: event.params.sqrtPriceX96,
      tick: event.params.tick,
      tickSpacing: BigInt(event.params.tickSpacing),
      hooks: event.params.hooks,
      token0Price: prices[0],
      token1Price: prices[1],
      volumeToken0: ZERO_BD,
      volumeToken1: ZERO_BD,
      volumeUSD: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      feesUSD: ZERO_BD,
      txCount: 0n,
      totalValueLockedToken0: ZERO_BD,
      totalValueLockedToken1: ZERO_BD,
      totalValueLockedETH: ZERO_BD,
      totalValueLockedUSD: ZERO_BD,
    });
    context.Token.set(token0);
    context.Token.set(token1);
  }
);
