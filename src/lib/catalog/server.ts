import "server-only";
import { cache } from "react";
import snapshot from "../../data/catalog-snapshot.json";
import { parseAllowlist } from "../../config/machines.ts";
import { cachedGet } from "../server-cache.ts";
import { createCatalogSource, type CatalogSnapshot } from "./source.ts";

export const catalogSource = createCatalogSource(cachedGet, snapshot as unknown as CatalogSnapshot, parseAllowlist(process.env.SEAL_MACHINE_CODES));

/** One catalog per render, however many components ask. */
export const getCatalog = cache(() => catalogSource.catalog());
