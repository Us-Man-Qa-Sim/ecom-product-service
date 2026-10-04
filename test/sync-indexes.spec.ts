import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Mongoose, Schema } from 'mongoose';
import { MODELS } from '../src/scripts/sync-indexes';

// `src/scripts/sync-indexes.ts` is a short-lived standalone script that opens
// its own connection, iterates the model list, and calls `syncIndexes()` on
// each. The lifecycle (connect/close) is not worth testing without a live
// Mongo, but we can lock in the thing that would silently rot: every
// collection-backed @Schema in `src/schemas/` must be in the script's MODELS
// table. If someone adds a schema and forgets to register it there, production
// indexes (autoIndex is off) never get built.
//
// The script only self-invokes as the program entry point, so importing MODELS
// here does not open a connection.

// Discover top-level schemas by scanning the folder rather than listing them by
// hand — a hand-written list would rot exactly like the MODELS table could.
// Embedded sub-schemas (`ProductStock`, `StockReservationItem`) declare no
// `collection`, which is how they are told apart from collection-backed ones.
function collectionSchemasInFolder(): Set<Schema> {
  const dir = join(__dirname, '..', 'src', 'schemas');
  const found = new Set<Schema>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.schema.ts'))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exports = require(join(dir, file)) as Record<string, unknown>;
    for (const value of Object.values(exports)) {
      if (value instanceof Schema && value.get('collection')) found.add(value);
    }
  }
  return found;
}

describe('sync-indexes model list', () => {
  it('registers every collection-backed @Schema exported from src/schemas/', () => {
    const expected = collectionSchemasInFolder();
    expect(expected.size).toBeGreaterThan(0);
    expect(new Set(MODELS.map((m) => m.schema))).toEqual(expected);
  });

  it('registers each model under a unique PascalCase name', () => {
    const names = MODELS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z]/);
  });
});

describe('sync-indexes runtime shape', () => {
  // Build the models on an isolated Mongoose instance (no DB) so we can
  // confirm `syncIndexes` is wired on each, without an implicit index build.
  const mongoose = new Mongoose();

  it('each registered schema builds a model that exposes syncIndexes', () => {
    for (const { name, schema } of MODELS) {
      const model = mongoose.model(name, schema);
      expect(typeof model.syncIndexes).toBe('function');
    }
  });
});
