import { describe, it, expect } from "vitest";
import {
  POOL_INTERVALS,
  TOKEN_INTERVALS,
  bucketStart,
  poolCandleSpecs,
  tokenCandleSpecs,
} from "../src/candles";

// 2026-10-07T13:37:42Z
const TS = 1791466662n;

describe("bucketStart", () => {
  it("floors to the interval", () => {
    expect(bucketStart(TS, 60n)).toBe(1791466620n);
    expect(bucketStart(TS, 300n)).toBe(1791466500n);
    expect(bucketStart(TS, 3600n)).toBe(1791465600n);
    expect(bucketStart(TS, 86400n)).toBe(1791417600n);
  });

  it("is idempotent on a boundary", () => {
    const h = bucketStart(TS, 3600n);
    expect(bucketStart(h, 3600n)).toBe(h);
  });

  it("puts the last second of a bucket in that bucket, not the next", () => {
    const h = bucketStart(TS, 3600n);
    expect(bucketStart(h + 3599n, 3600n)).toBe(h);
    expect(bucketStart(h + 3600n, 3600n)).toBe(h + 3600n);
  });
});

describe("candle specs", () => {
  it("covers every token interval, once each", () => {
    const specs = tokenCandleSpecs("1_0xabc", TS);
    expect(specs).toHaveLength(TOKEN_INTERVALS.length);
    expect(specs.map((s) => s.interval)).toEqual(["1m", "5m", "1h", "1d"]);
    expect(new Set(specs.map((s) => s.id)).size).toBe(specs.length);
  });

  it("covers only 1h and 1d for pools", () => {
    const specs = poolCandleSpecs("1_0xdef", TS);
    expect(specs).toHaveLength(POOL_INTERVALS.length);
    expect(specs.map((s) => s.interval)).toEqual(["1h", "1d"]);
  });

  it("builds ids from the subject id, interval and bucket", () => {
    const specs = tokenCandleSpecs("1_0xabc", TS);
    expect(specs[0]!.id).toBe("1_0xabc_1m_1791466620");
    expect(specs[3]!.id).toBe("1_0xabc_1d_1791417600");
  });

  it("gives two swaps in the same minute the same 1m id", () => {
    const a = tokenCandleSpecs("1_0xabc", TS);
    const b = tokenCandleSpecs("1_0xabc", TS + 17n);
    expect(b[0]!.id).toBe(a[0]!.id);
  });

  it("gives two swaps across a minute boundary different 1m ids but the same 1h id", () => {
    const a = tokenCandleSpecs("1_0xabc", TS);
    const b = tokenCandleSpecs("1_0xabc", TS + 60n);
    expect(b[0]!.id).not.toBe(a[0]!.id);
    expect(b[2]!.id).toBe(a[2]!.id);
  });
});
