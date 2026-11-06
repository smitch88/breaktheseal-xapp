import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { buildRails } from "../src/lib/rip/factory.ts";
import { MAINNET_CONFIRMATION, railsConfig } from "../src/lib/rip/mode.ts";

const FULL = {
  SEAL_TREASURY_ADDRESS: "rA",
  SEAL_TREASURY_SEED: "s",
  SEAL_VAULT_ADDRESS: "rB",
  SEAL_VAULT_SEED: "s",
  SEAL_DRAW_SECRET: "x".repeat(32),
  DATABASE_URL: "postgres://x",
  SEAL_XRPL_RPC: "https://rpc.example",
};

test("real rails are off unless every part of the switch is set", () => {
  assert.equal(railsConfig({}).mode, "demo");
  assert.equal(buildRails({}), null);
  fc.assert(
    fc.property(fc.string(), (m) => {
      if (m === "testnet" || m === "mainnet") return true;
      return railsConfig({ ...FULL, SEAL_RAILS_MODE: m, SEAL_REAL_MONEY_CONFIRM: MAINNET_CONFIRMATION }).mode === "demo";
    }),
  );
});

test("mainnet needs the exact sentence, a database, its own RPC, and no shortcut", () => {
  const on = { ...FULL, SEAL_RAILS_MODE: "mainnet", SEAL_REAL_MONEY_CONFIRM: MAINNET_CONFIRMATION };
  assert.equal(railsConfig(on).mode, "mainnet");
  assert.equal(railsConfig(on).networkId, 0);
  assert.equal(railsConfig({ ...on, SEAL_REAL_MONEY_CONFIRM: "yes" }).mode, "demo");
  assert.equal(railsConfig({ ...on, DATABASE_URL: "" }).mode, "demo");
  assert.equal(railsConfig({ ...on, SEAL_XRPL_RPC: "" }).mode, "demo");
  assert.equal(railsConfig({ ...on, SEAL_LOCAL_LOG: "/tmp/x" }).mode, "demo");
  assert.equal(railsConfig({ ...on, SEAL_CARD_RAILS: "simulated" }).mode, "demo", "a real XRP payment can't buy a pretend card");
  assert.equal(railsConfig({ ...on, SEAL_DRAW_SECRET: "short" }).mode, "demo");
});

test("testnet mode points at testnet and expects its network id", () => {
  const c = railsConfig({ ...FULL, SEAL_RAILS_MODE: "testnet", SEAL_XRPL_RPC: "" });
  assert.equal(c.mode, "testnet");
  assert.equal(c.networkId, 1);
  assert.ok(c.rpcUrl?.includes("altnet"));
});

test("the card source can't cross networks: real USDC never answers faucet XRP, and a pretend card never answers real XRP", () => {
  const seeds = { SEAL_TREASURY_ADDRESS: "rA", SEAL_MIRROR_ISSUER: "rI", SEAL_MIRROR_MINTER_ADDRESS: "rM", SEAL_MIRROR_MINTER_SEED: "s", SEAL_PUBLIC_ORIGIN: "https://x.test" };
  const t = { ...FULL, ...seeds, SEAL_RAILS_MODE: "testnet", SEAL_CARD_RAILS: "collector-crypt" };
  assert.throws(() => buildRails(t), /Invalid|seed|only on mainnet/i);
});

test("house wallets: the treasury, vault, minter and issuer are refused, and no other address or blank setting ever is", async () => {
  const { isHouseWallet } = await import("../src/lib/rip/mode.ts");
  const env = { SEAL_TREASURY_ADDRESS: " rTreasury ", SEAL_VAULT_ADDRESS: "rVault", SEAL_MIRROR_MINTER_ADDRESS: "rMinter", SEAL_MIRROR_ISSUER: "rIssuer" };
  for (const a of ["rTreasury", "rVault", "rMinter", "rIssuer"]) assert.equal(isHouseWallet(env, a), true, a);
  fc.assert(
    fc.property(fc.string(), (a) => {
      if (["rTreasury", "rVault", "rMinter", "rIssuer"].includes(a)) return true;
      assert.equal(isHouseWallet(env, a), false);
      assert.equal(isHouseWallet({ SEAL_TREASURY_ADDRESS: "", SEAL_VAULT_ADDRESS: "  " }, a), false);
    }),
  );
});

test("treasury bounds: unset keeps the defaults; a floor is 1 to 1000 XRP to the drop; cover places are 1 to 20; anything else is ignored", async () => {
  const { treasuryBounds } = await import("../src/lib/rip/mode.ts");
  assert.deepEqual(treasuryBounds({}), {});
  assert.deepEqual(treasuryBounds({ SEAL_TREASURY_FLOOR_XRP: "2", SEAL_XRP_COVER_PLACES: "1" }), { treasuryFloorDrops: 2_000_000n, xrpCoverPlacesMax: 1 });
  assert.deepEqual(treasuryBounds({ SEAL_TREASURY_FLOOR_XRP: "1.5" }), { treasuryFloorDrops: 1_500_000n });
  for (const bad of ["0", "0.5", "-2", "abc", "1001", "2.1234567", " "]) assert.equal(treasuryBounds({ SEAL_TREASURY_FLOOR_XRP: bad }).treasuryFloorDrops, undefined, bad);
  for (const bad of ["0", "21", "1.5", "x", "-1"]) assert.equal(treasuryBounds({ SEAL_XRP_COVER_PLACES: bad }).xrpCoverPlacesMax, undefined, bad);
  fc.assert(
    fc.property(fc.string(), fc.string(), (a, b) => {
      const out = treasuryBounds({ SEAL_TREASURY_FLOOR_XRP: a, SEAL_XRP_COVER_PLACES: b });
      if (out.treasuryFloorDrops !== undefined) assert.ok(out.treasuryFloorDrops >= 1_000_000n && out.treasuryFloorDrops <= 1_000_000_000n);
      if (out.xrpCoverPlacesMax !== undefined) assert.ok(Number.isInteger(out.xrpCoverPlacesMax) && out.xrpCoverPlacesMax >= 1 && out.xrpCoverPlacesMax <= 20);
    }),
  );
});
