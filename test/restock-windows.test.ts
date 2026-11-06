import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { BUY_ALLOW, NEVER_BUY, RESTOCK_STAGES } from "../src/config/restock.ts";
import { FLOOR_MARK_BPS, bandOfMark, configRules, relistDecision } from "../src/lib/rip/restock.ts";

/**
 * The $5 pack as the owner's rebuy of 2026-11-03 leaves it: what was in the pool, the $10 pack's four moved over, and the new picks at their marks.
 * Every one of them, sold back, has to come home at its own mark under the real config, like any other NFT: the windows decide relists too, not only buys.
 * `band` is the one its value fits in season 5-6's value tiers at 4 XRP (0.5x, 1.2x, 2.2x, 5x, 20x); null under half the pack, which no band takes.
 */
const SHELF: readonly { band: number | null; nftId: string; markXrp: number; slug: string }[] = [
  // In the pool before the rebuy.
  { band: 0, nftId: "00080FA04FCD4698F840FDD8480ADBEF2688636D233D4A15A82B8FBC05B5081E", markXrp: 3, slug: "rituals-r3gxhxz" },
  { band: 0, nftId: "0008138843B6C87E1B3BEA3E2BC2B69C46E1B509154E36094D2BA28605E7BDEB", markXrp: 3.382914, slug: "digital-minds" },
  { band: 0, nftId: "0008170207397A8AA414511E6E0649C9980E185E1C19D7401FC19A5805E4798B", markXrp: 2.86481, slug: "fuzzycubs" },
  { band: 0, nftId: "0008177087D408DB95FAF41FF9AA29BB53EBCE2BFF08242C6DC00E0D00001FA3", markXrp: 3.555615, slug: "doodlepunkx" },
  { band: null, nftId: "00083A98A79D12EF0431D0F5BAE8503287BFF5F4C4297EB40A8FEFF5000010DC", markXrp: 1.75, slug: "zpunks" },
  { band: 0, nftId: "00181F40EB467BD9E06C744DD0BB103B109BFD2699310F8A0AB759C106304A26", markXrp: 2.732744, slug: "round-tripprx-beyond" },
  { band: 2, nftId: "00081388070BD6653EE9A4855CC69D8AFCEE750690B118247078D89E06668B04", markXrp: 9.14301, slug: "xcainz-universe" },
  { band: 2, nftId: "000813889162C7FDCF752841C2A6F9270FF1159B177941EC0FBD5E74058F5ADA", markXrp: 10, slug: "wbc-smile" },
  { band: 2, nftId: "00081388A5753AFA2D401872105C78DC9D9B93ECABBBA2A209E7A34A05F3BAAF", markXrp: 14.22246, slug: "shitty-panther-club" },
  { band: 1, nftId: "00081388CEBA8F5BD8F7434D18DBF016E0466EB3C330BAAF723F543505B727B3", markXrp: 5.07945, slug: "king" },
  { band: 2, nftId: "0018271083C7EEA26CA6F03D38153D17E10866C269B9F1DF7DD35486063D6FEB", markXrp: 12, slug: "dropchan" },
  { band: 3, nftId: "00181388208AE9E5739668CEE25874F9BBE7EB2452EC4B8D84F8A6EE06370954", markXrp: 56.788251, slug: "animal-fam" },
  { band: 4, nftId: "00081B58B1EB46DF0FF2C07C1407C0DA3C897B1ECB21F92995489703057B7667", markXrp: 85.233171, slug: "xrp-army-og-collection" },
  // Re-marked from 143 to what the vault paid, 198.09855, before 5-5 opens.
  { band: 4, nftId: "001813887D829B8285E64A3B355CD5E563C4F4AC9D7069424D788BD206173D35", markXrp: 198.09855, slug: "seal-cto-scrolls" },
  // Moved from the $10 pack, at the marks they had there.
  { band: 1, nftId: "00080BB8C9F057673FC8D5A78215B8BA9FD5A2A9B7F8540E75D8FA09059BF36D", markXrp: 5, slug: "ouroboros" },
  { band: 2, nftId: "00081388A5753AFA2D401872105C78DC9D9B93ECABBBA2A2134F7EAD05F3C312", markXrp: 14, slug: "shitty-panther-club" },
  { band: 2, nftId: "001813880C7C14716237C4A8AC7FDA9B4AF1D6642B556AE14B85789C0617FC03", markXrp: 14, slug: "sexy-betzy" },
  // The owner's picks, at min(all-in, 110% of the floor) as 07 registers them.
  { band: 0, nftId: "0008271005ECDB63C36C15BAAF49634CA2D7C65D9ADDD1DD0936F1C605A2E731", markXrp: 2.03178, slug: "blackmarketdawgs" },
  { band: 0, nftId: "0008170207397A8AA414511E6E0649C9980E185E1C19D7404004E51405E478CF", markXrp: 3.352437, slug: "fuzzycubs" },
  { band: 2, nftId: "00081388EF7C422EF52CEB969960BEF4144D7BC3F862C4673319040A059EB971", markXrp: 16.152651, slug: "luckypunch" },
  { band: 2, nftId: "00081388EF7C422EF52CEB969960BEF4144D7BC3F862C46764D80C34059EBB97", markXrp: 16.25424, slug: "luckypunch" },
  { band: 2, nftId: "00181B582531081A737B46B80556D4904EE401652D2DEC1BC28A83FB0666EB5F", markXrp: 17.259972, slug: "maxonxrpl" },
  { band: 2, nftId: "00181B582531081A737B46B80556D4904EE401652D2DEC1B1D1E52360666EC9C", markXrp: 17.27013, slug: "maxonxrpl" },
  { band: 2, nftId: "000813889162C7FDCF752841C2A6F9270FF1159B177941EC2C444385058F5EEB", markXrp: 10.1589, slug: "wbc-bang" },
  { band: 2, nftId: "001813880C7C14716237C4A8AC7FDA9B4AF1D6642B556AE183E90A9906180100", markXrp: 14.22246, slug: "sexy-betzy" },
  { band: 2, nftId: "001813880C7C14716237C4A8AC7FDA9B4AF1D6642B556AE1D91A9170061800D7", markXrp: 15.136761, slug: "sexy-betzy" },
  { band: 3, nftId: "00081388C182B4F213B82CCFA4C6F59AD76F0AFCFBDF04D57889816B00000490", markXrp: 23.36547, slug: "xshrooms" },
  { band: 4, nftId: "0008271068A0E6F504732B8741A31D6A7965EED1A1F659110B20E2CC05CBD831", markXrp: 81.2712, slug: "teddybg" },
];
const drops = (xrp: number) => String(Math.round(xrp * 1e6));

test("every NFT on the $5 shelf after the rebuy fits the 5-6 band its value says, or none under 2 XRP, and a sale back never marks it down or holds it out for being registered high", () => {
  for (const n of SHELF) {
    assert.equal(bandOfMark(5, BigInt(drops(n.markXrp))), n.band, `${n.slug} ${n.markXrp}`);
    // No floor read: it goes back as it was, never capped.
    assert.deepEqual(relistDecision({ markDrops: drops(n.markXrp), market: undefined }), { kind: "add", markDrops: drops(n.markXrp), note: "kept" });
  }
});

test("with any floor that backs its mark, each of them goes back at exactly that mark, the same rule as every other NFT", () => {
  fc.assert(fc.property(fc.constantFrom(...SHELF), fc.double({ min: 1, max: 3, noNaN: true }), (n, over) => {
    const mark = BigInt(drops(n.markXrp));
    // A floor at or above mark / 110% backs the mark as it stands.
    const floor = Math.ceil((Number(mark) * 10_000 * over) / Number(FLOOR_MARK_BPS));
    const out = relistDecision({ markDrops: drops(n.markXrp), market: { floorDrops: floor, medianSaleDrops: floor, notBuyable: null } });
    assert.equal(out.kind, "add");
    assert.equal((out as { markDrops: string }).markDrops, drops(n.markXrp));
  }));
});

test("every collection on that shelf is pinned, so a sold-back one gets the same floor check as the rest", () => {
  const rules = configRules();
  for (const n of SHELF) assert.equal(rules.slugOf(n.nftId), n.slug, n.nftId);
});

test("the owner's new collections are on the $5 lists, FREN never is, and the targets are the 2026-11-05 shelf in its value bands", () => {
  const five = BUY_ALLOW[5]!;
  // Season 5-6's value tiers: Black Market Dawgs at about 2 XRP is Common, xShrooms at 23 is Epic.
  assert.ok(five[0].includes("blackmarketdawgs"));
  for (const s of ["luckypunch", "maxonxrpl", "wbc-bang", "sexy-betzy"]) assert.ok(five[2].includes(s), s);
  assert.ok(five[3].includes("xshrooms"));
  assert.ok(five[4].includes("teddybg"));
  assert.ok(NEVER_BUY.includes("xrpfrensclub"));
  for (const band of five) assert.ok(!band.includes("xrpfrensclub"));
  assert.deepEqual([...RESTOCK_STAGES.launch[5]], [15, 2, 22, 5, 4]);
});
