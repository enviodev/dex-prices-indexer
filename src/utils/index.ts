import { BigDecimal } from "envio";
import { ZERO_BD, ZERO_BI } from "./constants";

export function exponentToBigDecimal(decimals: bigint): BigDecimal {
  let resultString = "1";

  for (let i = 0; i < Number(decimals); i++) {
    resultString += "0";
  }

  return new BigDecimal(resultString);
}

// return 0 if denominator is 0 in division
export function safeDiv(amount0: BigDecimal, amount1: BigDecimal): BigDecimal {
  if (amount1.eq(ZERO_BD)) {
    return ZERO_BD;
  } else {
    return amount0.div(amount1);
  }
}

// Cap BigDecimal precision at 40 decimal places. Postgres btree indexes have a
// hard 2704-byte-per-row limit, so an unbounded BigDecimal (e.g. from a runaway
// derivedETH on a manipulated oracle pool) can fail INSERTs on indexed numeric
// columns. Apply at indexed-column writes and at price-source values that
// propagate downstream (derivedETH, ethPriceUSD).
export function sanitizeBD(value: BigDecimal): BigDecimal {
  return new BigDecimal(value.toFixed(40));
}

export function hexToBigInt(hex: string): bigint {
  if (hex.startsWith("0x")) {
    hex = hex.slice(2);
  }
  return BigInt(`0x${hex}`);
}

export function convertTokenToDecimal(
  tokenAmount: bigint,
  exchangeDecimals: bigint
): BigDecimal {
  if (exchangeDecimals == ZERO_BI) {
    return new BigDecimal(tokenAmount.toString());
  }
  return new BigDecimal(tokenAmount.toString()).div(
    exponentToBigDecimal(exchangeDecimals)
  );
}
