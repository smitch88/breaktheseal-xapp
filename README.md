# Break the Seal

Source of [breaktheseal.rip](https://breaktheseal.rip) and its Xaman xApp, published for Xaman's xApp review.

- One Next.js app is both the front end and the backend (its API routes under `src/app/api`), hosted on Vercel, with
  a Postgres database. It works on the XRP Ledger mainnet.
- Break the Seal is built by the BEARISH team. It is not affiliated with, endorsed by or sponsored by XRPL Labs or Xaman.
- This repository is a snapshot of `e542c0d68` (2026-11-06). It changes only when we publish a new snapshot.
- Not included: internal audit reports and the owner's operations scripts, which hold no part of the app. No keys,
  seeds or secrets are in this repository: configuration comes from the environment (see `.env.example`).
- Anyone can check the published draws with `scripts/verify-log.mjs` (`npm run verify`).
- Support, Privacy Policy and Terms: https://breaktheseal.rip

All rights reserved. The source is published for review and transparency.
