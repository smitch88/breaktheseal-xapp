import { after } from "next/server";
import type { Rails } from "./factory.ts";
import { settling } from "./restock.ts";

/** A buy, a mark brought down, an NFT held out: said once, when it happens, to the log and the owner's webhook if one is set. */
export async function notify(lines: readonly string[]) {
  if (!lines.length) return;
  const text = lines.map((l) => `Break the Seal: ${l}`).join("\n");
  console.warn(text);
  const hook = process.env.SEAL_ALERT_WEBHOOK;
  if (hook) await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text }), signal: AbortSignal.timeout(5000) }).catch(() => {});
}

/** How often a follow-up looks, and how many times: a ledger closes every 3 to 5 seconds, and a sale, its pool change and that change's anchor take about three. */
export const FOLLOW_UP_MS = 5000;
export const FOLLOW_UP_TRIES = 6;

/**
 * After a sale or a sweep, keep this function alive a little to finish what changes a pool, so the pack's page shows it in seconds rather than at the next minute's cron.
 * It runs after the answer has gone, so nobody waits on it. It never buys. It stops as soon as nothing is on its way, and outside a request it does nothing.
 */
export function followUpSoon(r: Rails, wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))) {
  if (!settling(r.engine.state)) return;
  try {
    after(async () => {
      for (let i = 0; i < FOLLOW_UP_TRIES && settling(r.engine.state); i++) {
        await wait(FOLLOW_UP_MS);
        const before = r.engine.state.head;
        const { notices } = await r.engine.followUp().catch(() => ({ notices: [] as readonly string[] }));
        await notify(notices);
        // Nothing moved and nothing is in flight: what's left waits on something a few seconds won't fix, like a market that can't be read. The cron has it.
        if (r.engine.state.head === before && !r.engine.state.intents.size) break;
      }
    });
  } catch {
    // Not inside a request, as in a script: the cron and the next visitor's pass get there.
  }
}
