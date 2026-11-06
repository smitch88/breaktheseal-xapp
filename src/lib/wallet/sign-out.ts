/** Sign out: the cookie goes, and a Joey connection with it. Joey's code only loads if this player used Joey. */
export function signOutWallet(wallet: string | null) {
  void fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  if (wallet !== "joey") return;
  void fetch("/api/auth/config")
    .then((r) => r.json() as Promise<{ reownProjectId?: string | null }>)
    .catch(() => ({ reownProjectId: null }))
    .then(async (config) => (await import("./joey-browser.ts")).forgetJoey(config.reownProjectId ?? null))
    .catch(() => {});
}
