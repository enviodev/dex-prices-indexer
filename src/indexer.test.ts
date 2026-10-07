/**
 * E2E integration tests. Uses HyperIndex's createTestIndexer() to replay real
 * chain events through the handlers and snapshot the resulting entity changes.
 *
 * The inline snapshot below is deliberately empty: the upstream recording was
 * for a schema with Tick, ModifyLiquidity, PoolManager and Position entities,
 * none of which exist here. Running `pnpm test -u` records it. Read what it
 * records rather than accepting it — that is the point of the test.
 */

import { describe, it } from "vitest";
import { createTestIndexer } from "envio";

describe("dex-prices-indexer", () => {
  it("Processes ModifyLiquidity on an unknown pool without writing entities", async (t) => {
    const indexer = createTestIndexer();

    t.expect(
      await indexer.process({
        chains: {
          1: { startBlock: 24240005, endBlock: 24240005 },
        },
      }),
      "A ModifyLiquidity event whose pool has no prior Initialize must write nothing. The PositionManager mint in the same block is no longer indexed."
    ).toMatchInlineSnapshot();
  });
});
