// PRD-6: idempotent product-catalog seed.
//
// Bootstraps a small sample catalog so a fresh database is immediately usable
// (gateway list/search, order creation, Kafka demos). Re-runnable from a
// Makefile, CI job, or docker exec — never overwrites operational data.
//
// Idempotency rules — natural key is `(name, category)`:
//   - Missing (name, category) → insert with `initialStock` and `reserved: 0`.
//   - Existing (name, category) → update price, description, currency,
//     attributes (replaced), images (replaced), isActive. Stock counters
//     (`available`, `reserved`) are LEFT ALONE — restocking goes through the
//     real AdjustStock RPC (PRD-5), and reservations are the Kafka phase's job.
//
// What this script deliberately does NOT do:
//   - Emit any Kafka outbox events. The seed is out-of-band bootstrap.
//   - Delete rows the sample catalog no longer contains. A catalog edit is a
//     catalog edit; the seed never destroys data an admin may have curated.
//
// Usage:
//   MONGO_URI=mongodb://product_svc:...@mongo:27017/product?... \
//   npm run seed:products
//
// `npm run seed:products` runs `scripts/seed-products.js`, a cross-platform
// launcher that loads `.env` (Node ≥ 21.7 built-in), registers ts-node, then
// imports `main` from this file. The compiled file also lands in the Docker
// image at `dist/seed/seed-products.js`, reachable via
//   docker exec product-service node dist/seed/seed-products.js
// once MONGO_URI is set on the container.

import mongoose, { Model } from 'mongoose';
import { z } from 'zod';
import { Product, ProductDocument, ProductSchema } from '../schemas/product.schema';
import { SAMPLE_CATALOG, SampleProduct } from './sample-catalog';

const SeedEnvSchema = z.object({
  MONGO_URI: z.string().min(1),
});

export interface SeedProductsInput {
  mongoUri: string;
  catalog: readonly SampleProduct[];
}

export interface SeedProductsSummary {
  created: number;
  updated: number;
  unchanged: number;
  total: number;
}

/**
 * Core seeding routine. Takes a Mongoose model so tests can hand in an
 * in-memory stub without opening a real connection. The runtime bootstrap in
 * `main()` builds a real model and passes it here.
 */
export async function seedProducts(
  productModel: Pick<Model<ProductDocument>, 'findOne' | 'create' | 'updateOne'>,
  catalog: readonly SampleProduct[],
): Promise<SeedProductsSummary> {
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const item of catalog) {
    // `(name, category)` is the natural key — there is no `slug` field on the
    // Product schema, and matching on name alone would collide across
    // categories (e.g. two products named "Classic"). Lookup is sequential on
    // purpose: a tiny sample catalog is not worth parallelising, and the clear
    // per-item log line makes a failed seed easy to triage.
    const existing = await productModel
      .findOne({ name: item.name, category: item.category })
      .exec();

    if (!existing) {
      await productModel.create({
        name: item.name,
        description: item.description,
        category: item.category,
        priceMinor: item.priceMinor,
        currency: item.currency,
        stock: { available: item.initialStock, reserved: 0 },
        attributes: item.attributes,
        images: item.images,
        isActive: item.isActive,
      });
      created += 1;
      continue;
    }

    // Build the update payload only from fields that actually drifted. If
    // nothing changed, skip the write — this keeps re-runs cheap and makes
    // `unchanged` a meaningful signal in the summary log.
    const changes = diffProduct(existing, item);
    if (Object.keys(changes).length === 0) {
      unchanged += 1;
      continue;
    }

    await productModel.updateOne({ _id: existing._id }, { $set: changes }).exec();
    updated += 1;
  }

  return { created, updated, unchanged, total: catalog.length };
}

/**
 * Returns the subset of catalog fields that differ from the stored document.
 * Stock counters are intentionally excluded — operational state owned by the
 * reservation lifecycle, never clobbered by a seed re-run.
 */
function diffProduct(existing: ProductDocument, item: SampleProduct): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (existing.description !== item.description) changes.description = item.description;
  if (existing.priceMinor !== item.priceMinor) changes.priceMinor = item.priceMinor;
  if (existing.currency !== item.currency) changes.currency = item.currency;
  if (existing.isActive !== item.isActive) changes.isActive = item.isActive;

  if (!sameRecord(mapToRecord(existing.attributes), item.attributes)) {
    changes.attributes = item.attributes;
  }
  if (!sameArray(existing.images, item.images)) {
    changes.images = item.images;
  }
  return changes;
}

function mapToRecord(value: unknown): Record<string, string> {
  if (value instanceof Map) {
    const out: Record<string, string> = {};
    for (const [k, v] of value.entries()) out[k] = String(v);
    return out;
  }
  // Plain object fallback — some test stubs skip the Map hydration.
  if (value && typeof value === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = String(v);
    return out;
  }
  return {};
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function parseEnv(raw: NodeJS.ProcessEnv): SeedProductsInput {
  const parsed = SeedEnvSchema.safeParse({ MONGO_URI: raw.MONGO_URI });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n  ');
    throw new Error(`Invalid product seed environment:\n  ${issues}`);
  }
  return { mongoUri: parsed.data.MONGO_URI, catalog: SAMPLE_CATALOG };
}

/**
 * Runtime bootstrap. Short-lived standalone connection — no Nest app, no gRPC
 * listener — mirroring `scripts/sync-indexes.ts`. `autoIndex: false` so a
 * concurrent run cannot kick off a second index build (indexes are owned by
 * `syncIndexes()` which the Docker entrypoint runs first).
 */
export async function main(): Promise<void> {
  const input = parseEnv(process.env);
  const connection = await mongoose
    .createConnection(input.mongoUri, { autoIndex: false })
    .asPromise();

  try {
    // Dropping the explicit type arg mirrors sync-indexes.ts — passing both a
    // generic and a schema confuses the Mongoose 9 inference. We cast at the
    // call boundary because seedProducts only touches `findOne`/`create`/
    // `updateOne`, all present on the loose Model type.
    const model = connection.model(Product.name, ProductSchema);
    const summary = await seedProducts(model as unknown as Model<ProductDocument>, input.catalog);
    console.log(
      `[seed-products] done: created=${summary.created} updated=${summary.updated} ` +
        `unchanged=${summary.unchanged} total=${summary.total}`,
    );
  } finally {
    await connection.close();
  }
}

// Compiled entrypoint (`node dist/seed/seed-products.js` inside the container,
// where ts-node and scripts/ are pruned). The JS launcher calls `main()`
// directly, so `require.main` is the launcher module and this branch is
// skipped under `npm run seed:products` — main runs exactly once either way.
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[seed-products] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
