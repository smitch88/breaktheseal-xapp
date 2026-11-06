/**
 * A strict parser for the TOML subset an xrp-ledger.toml needs: full-line comments, [TABLE], [[ARRAY OF TABLES]],
 * key = "basic string" and key = offset date-time. Anything else, or a duplicate key or table, throws, so a file that
 * parses here is valid TOML with exactly the structure read.
 */
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cur: Record<string, unknown> = root;
  String(text).split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    let m: RegExpExecArray | null;
    if ((m = /^\[\[([A-Za-z0-9_-]+)\]\]$/.exec(line))) {
      const k = m[1];
      if (root[k] !== undefined && !Array.isArray(root[k])) throw new Error(`line ${i + 1}: ${k} is already a table`);
      cur = {};
      ((root[k] ??= []) as unknown[]).push(cur);
      return;
    }
    if ((m = /^\[([A-Za-z0-9_-]+)\]$/.exec(line))) {
      if (m[1] in root) throw new Error(`line ${i + 1}: table ${m[1]} defined twice`);
      cur = root[m[1]] = {};
      return;
    }
    if ((m = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line))) {
      const [, key, value] = m;
      if (key in cur) throw new Error(`line ${i + 1}: key ${key} defined twice`);
      const s = /^"((?:[^"\\\x00-\x1f\x7f]|\\["\\btnfr])*)"$/.exec(value);
      if (s) {
        cur[key] = JSON.parse(`"${s[1]}"`);
        return;
      }
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value))) {
        cur[key] = new Date(value);
        return;
      }
      throw new Error(`line ${i + 1}: unsupported value ${value}`);
    }
    throw new Error(`line ${i + 1}: not TOML this parser accepts: ${raw}`);
  });
  return root;
}
