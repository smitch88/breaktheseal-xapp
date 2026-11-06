/** Where the home hero's layers sit, measured when they were baked from the masters. Boxes are [left, top, width, height] in percent of their parent. */
export const HERO_PACK = { key: "hero-pack", w: 620, h: 844, wx: 47.9, wy: 17.59, tear: 36.98, seal: 148.2 } as const;

const A = "/assets/hero";

export const HERO_ART = {
  pack: `${A}/pack.webp`,
  top: `${A}/pack-top.webp`,
  body: `${A}/pack-body.webp`,
  back: `${A}/pack-back.webp`,
  wax: `${A}/wax.webp`,
  seal: `${A}/seal.webp`,
  jaw: `${A}/jaw.webp`,
  rays: `${A}/rays.webp`,
  slab: `${A}/sample-slab.webp`,
  sheen: [0, 1, 2, 3].map((i) => `${A}/sheen-${i}.webp`),
  lid: {
    far: { half: `${A}/lid-far-half.webp`, shut: `${A}/lid-far-shut.webp` },
    near: { half: `${A}/lid-near-half.webp`, shut: `${A}/lid-near-shut.webp` },
  },
  drop: { bead: `${A}/drop-bead.webp`, long: `${A}/drop-long.webp`, tear: `${A}/drop-tear.webp` },
  /** The eye highlights lifted off the sprite, in the lids' boxes: see scripts/bake-stage-idle.mjs. Only the pack-opening screen moves them. */
  eye: {
    far: { clean: `${A}/eye-far-clean.webp`, glint: `${A}/eye-far-glint.webp` },
    near: { clean: `${A}/eye-near-clean.webp`, glint: `${A}/eye-near-glint.webp` },
  },
} as const;

export const HERO_BOX = {
  lidFar: [15.31, 20.86, 14.69, 7.29],
  lidNear: [36.88, 25.43, 17.5, 8.86],
  jaw: [6.25, 50.86, 28.75, 23.14],
  jawPivot: [141.3, 2.47],
  wax: [24.19, 0, 47.58, 39.45],
  waxOrigin: [50.01, 45.32],
} as const;

/** The seal sprite's size, which the boxes above are percent of. */
export const SEAL_PX = { w: 640, h: 700 } as const;

/** How far each eye's highlight can move, in sprite pixels. The bake refuses a limit that would push one off the black of the eye. */
export const GAZE = { far: { x: 6, y: 3 }, near: { x: 6, y: 3 } } as const;

/** The lips that drip, in percent of the seal sprite, with how far a drop falls as a share of the sprite's height. */
export const HERO_DRIPS = [
  { x: 36.3, y: 76.2, fall: 0.2 },
  { x: 32.2, y: 67.4, fall: 0.15 },
  { x: 8.6, y: 61.4, fall: 0.27 },
] as const;

/** Only the bite needs these. They load after the page does, or on the first tap. */
export const HERO_SAMPLE_LAYERS = [HERO_ART.top, HERO_ART.body, HERO_ART.back, HERO_ART.slab, "/assets/rip/star.webp", "/assets/rip/pow.webp", "/assets/rip/seal-clamp.webp", "/assets/rip/shards.webp"] as const;

/** Every file the hero can show. */
export const HERO_FILES: readonly string[] = [HERO_ART.pack, HERO_ART.wax, HERO_ART.seal, HERO_ART.jaw, HERO_ART.rays, ...HERO_ART.sheen, HERO_ART.lid.far.half, HERO_ART.lid.far.shut, HERO_ART.lid.near.half, HERO_ART.lid.near.shut, HERO_ART.drop.bead, HERO_ART.drop.long, HERO_ART.drop.tear, ...HERO_SAMPLE_LAYERS];
