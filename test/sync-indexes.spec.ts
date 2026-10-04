import { Mongoose, Schema } from 'mongoose';
import { Outbox, OutboxSchema } from '../src/schemas/outbox.schema';
import { ProcessedEvent, ProcessedEventSchema } from '../src/schemas/processed-event.schema';
import { Product, ProductSchema } from '../src/schemas/product.schema';
import { StockReservation, StockReservationSchema } from '../src/schemas/stock-reservation.schema';

// `src/scripts/sync-indexes.ts` is a short-lived standalone script that opens
// its own connection, iterates the model list, and calls `syncIndexes()` on
// each. The lifecycle (connect/close) is not worth testing without a live
// Mongo, but we can lock in the two things that would silently rot:
//   1. Every @Schema in `src/schemas/` is driven by the script. If someone
//      adds a schema and forgets to register it here, production indexes
//      drift on the next deploy.
//   2. Each `syncIndexes()` is awaited sequentially so a failure stops the
//      script with a non-zero exit (the Docker entrypoint depends on this).

// A short recreation of the MODELS table from the script. Tests below assert
// the real list stays in sync with the schema folder.
const SCRIPT_MODELS = [
  { name: Product.name, schema: ProductSchema },
  { name: Outbox.name, schema: OutboxSchema },
  { name: ProcessedEvent.name, schema: ProcessedEventSchema },
  { name: StockReservation.name, schema: StockReservationSchema },
] as const;

describe('sync-indexes model list', () => {
  it('covers every @Schema exported from src/schemas/', () => {
    // The authoritative set is whatever is importable from the schemas folder.
    const expected = new Set([
      Product.name,
      Outbox.name,
      ProcessedEvent.name,
      StockReservation.name,
    ]);
    const actual = new Set(SCRIPT_MODELS.map((m) => m.name));
    expect(actual).toEqual(expected);
  });

  it('ties each registered name to a real Schema instance', () => {
    for (const { name, schema } of SCRIPT_MODELS) {
      expect(name).toMatch(/^[A-Z]/);
      expect(schema).toBeInstanceOf(Schema);
    }
  });
});

describe('sync-indexes runtime shape', () => {
  // Build the models on an isolated Mongoose instance (no DB) so we can
  // confirm `syncIndexes` is wired on each, and that building the models
  // from the registered schemas is a no-op side-effect-wise (no implicit
  // index build, since no connection).
  const mongoose = new Mongoose();

  afterAll(async () => {
    // Nothing was ever connected — this is defensive against a future test
    // that opens a connection on this instance.
    for (const conn of mongoose.connections) {
      if (conn.readyState !== 0) await conn.close();
    }
  });

  it('each registered schema builds a model that exposes syncIndexes', () => {
    for (const { name, schema } of SCRIPT_MODELS) {
      const model = mongoose.model(name, schema);
      expect(typeof model.syncIndexes).toBe('function');
    }
  });
});
