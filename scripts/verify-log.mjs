#!/usr/bin/env node
/**
 * Check a SEAL Rips public log without trusting us: replay every pull, then check the log against the ledger.
 *   node --experimental-strip-types --no-warnings scripts/verify-log.mjs https://site [xrpl-rpc]
 * It only reads. Without an RPC it picks the network the log says it belongs to.
 */
import { TESTNET_RPC, rpcChain } from "../src/lib/rip/chain.ts";
import { replayLog, verifyAgainstChain } from "../src/lib/rip/verify.ts";

const site = process.argv[2];
if (!site) throw new Error("usage: verify-log.mjs <site> [xrpl-rpc]");
const log = await fetch(new URL("/api/rip/log", site)).then((r) => r.json());
const replay = replayLog(log.events);
console.log("replay:", replay.ok ? `ok, ${replay.pulls} pulls` : `FAILED at ${replay.at}: ${replay.why}`);
if (!replay.ok) process.exit(1);
const rpc = process.argv[3] ?? (log.network === "testnet" ? TESTNET_RPC : process.env.SEAL_XRPL_RPC?.trim() || "https://xrplcluster.com/");
const from = log.events.find((e) => e.type === "scan_cursor")?.data.ledger ?? 1;
const chain = await verifyAgainstChain(log.events, rpcChain(rpc), log.treasury, from);
console.log("ledger:", chain.ok ? `ok, ${chain.payments} payments, ${chain.anchors} anchors` : `FAILED: ${chain.why}`);
process.exit(chain.ok ? 0 : 1);
