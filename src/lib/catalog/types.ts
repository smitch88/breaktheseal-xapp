export const CARD_TIERS = ["common", "uncommon", "rare", "epic"] as const;
export type CardRarity = (typeof CARD_TIERS)[number];

/** One real collectible returned by the pack API. */
export interface Item {
  readonly id: string;
  readonly name: string;
  readonly rarity: CardRarity;
  /** Insured value in USD. */
  readonly ins: number;
  readonly grade: string;
  readonly img: string;
  readonly code: string;
  /** The rest of Collector Crypt's row, for the details view. A saved copy from before these existed has none of them. */
  readonly back?: string;
  readonly grader?: string;
  readonly gradeName?: string;
  readonly cert?: string;
  readonly category?: string;
  readonly year?: string;
  readonly parallel?: string;
  readonly population?: number;
  readonly vault?: string;
}

export type BandCounts = Readonly<Record<CardRarity, number>>;

/** One page of a machine's real list. The source has no total and no way to jump: a page leads only to the next. */
export interface ItemsPage {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

export interface Machine {
  readonly code: string;
  /** Plain display name (see names.ts). */
  readonly name: string;
  readonly cat: string;
  readonly price: number;
  /** Instant sell-back, percent of insured value, before the sell fee. */
  readonly bb: number;
  /** Rarity rates as percents: common, uncommon, rare, epic. */
  readonly rates: readonly [number, number, number, number];
  readonly stock: number;
  /** Stock per band, from the same read as `stock`. A saved copy from before this existed doesn't have it. */
  readonly bands?: BandCounts;
  /** Up to three real items for the fanned slabs. */
  readonly fan: readonly Item[];
}

export interface CatalogView {
  readonly machines: readonly Machine[];
  /** True when the live source failed and this is the last copy we hold. */
  readonly stale: boolean;
  /** When this copy was taken, only meaningful when stale. */
  readonly asOf: string;
}

export interface ItemsView {
  readonly items: readonly Item[];
  readonly stale: boolean;
}
