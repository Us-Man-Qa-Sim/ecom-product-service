import 'reflect-metadata';
import mongoose from 'mongoose';
import { validateEnv } from '../config/env.validation';
import { Outbox, OutboxSchema } from '../schemas/outbox.schema';
import { ProcessedEvent, ProcessedEventSchema } from '../schemas/processed-event.schema';
import { Product, ProductSchema } from '../schemas/product.schema';
import { StockReservation, StockReservationSchema } from '../schemas/stock-reservation.schema';

/**
 * Index migration (PRD-3).
 *
 * Production runs with `autoIndex: false` (see database.module.ts), so
 * schema-declared indexes never build on their own. This script drives them
 * explicitly: for each model `syncIndexes()` creates every index declared on the
 * schema and drops any index on the collection that the schema no longer
 * declares. It is idempotent — a database whose indexes already match is a
 * no-op — so the Docker entrypoint runs it on every start before the service
 * boots (and it can equally be run by hand as a one-off migration).
 *
 * It uses a short-lived standalone connection rather than booting the full Nest
 * app: no gRPC server, no HTTP listener, just connect → sync → disconnect.
 */

const MODELS = [
  { name: Product.name, schema: ProductSchema },
  { name: Outbox.name, schema: OutboxSchema },
  { name: ProcessedEvent.name, schema: ProcessedEventSchema },
  { name: StockReservation.name, schema: StockReservationSchema },
] as const;

async function main(): Promise<void> {
  const env = validateEnv(process.env);

  // autoIndex is irrelevant here — syncIndexes() builds indexes explicitly
  // regardless — but we disable it so creating the models never kicks off a
  // second, implicit build in parallel.
  const connection = await mongoose.createConnection(env.MONGO_URI, { autoIndex: false }).asPromise();

  try {
    for (const { name, schema } of MODELS) {
      const model = connection.model(name, schema);
      const dropped = await model.syncIndexes();
      const note = dropped.length ? `dropped stale ${JSON.stringify(dropped)}` : 'up to date';
      console.log(`[sync-indexes] ${name}: ${note}`);
    }
    console.log('[sync-indexes] done');
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error('[sync-indexes] failed', err);
  process.exit(1);
});
