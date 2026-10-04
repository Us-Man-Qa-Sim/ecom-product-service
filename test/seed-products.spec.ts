import { Mongoose, Types } from 'mongoose';
import type { Model } from 'mongoose';
import { parseEnv, seedProducts, type SeedProductsSummary } from '../src/seed/seed-products';
import { Product, ProductSchema, type ProductDocument } from '../src/schemas/product.schema';
import type { SampleProduct } from '../src/seed/sample-catalog';

// Isolated Mongoose instance so building Product documents here never fights
// with the connections the other suites open. The seed function only touches
// `findOne`, `create` and `updateOne`, so the model stub below is intentionally
// narrower than the one in product.service.spec.ts.
const m = new Mongoose();
const ProductModel = m.model(Product.name, ProductSchema);

interface StoreRow {
  _id: Types.ObjectId;
  name: string;
  description: string;
  category: string;
  priceMinor: number;
  currency: string;
  stock: { available: number; reserved: number };
  attributes: Record<string, string>;
  images: string[];
  isActive: boolean;
}

function hydrate(row: StoreRow): ProductDocument {
  const doc = new ProductModel(row) as ProductDocument;
  doc._id = row._id;
  (doc as unknown as { isNew: boolean }).isNew = false;
  return doc;
}

type SeedModel = Pick<Model<ProductDocument>, 'findOne' | 'create' | 'updateOne'>;

function makeModelStub(initial: StoreRow[] = []): {
  model: SeedModel;
  store: StoreRow[];
  findOne: jest.Mock;
  create: jest.Mock;
  updateOne: jest.Mock;
} {
  const store: StoreRow[] = [...initial];

  const findOne = jest.fn((filter: { name: string; category: string }) => ({
    exec: async () => {
      const row = store.find((r) => r.name === filter.name && r.category === filter.category);
      return row ? hydrate(row) : null;
    },
  }));

  const create = jest.fn(async (data: Partial<StoreRow>) => {
    const row: StoreRow = {
      _id: new Types.ObjectId(),
      name: data.name ?? '',
      description: data.description ?? '',
      category: data.category ?? '',
      priceMinor: data.priceMinor ?? 0,
      currency: data.currency ?? 'USD',
      stock: data.stock ?? { available: 0, reserved: 0 },
      attributes: (data.attributes as Record<string, string>) ?? {},
      images: data.images ?? [],
      isActive: data.isActive ?? true,
    };
    store.push(row);
    return hydrate(row);
  });

  const updateOne = jest.fn(
    (filter: { _id: Types.ObjectId }, update: { $set: Record<string, unknown> }) => ({
      exec: async () => {
        const row = store.find((r) => r._id.equals(filter._id));
        if (!row) return { acknowledged: true, modifiedCount: 0, matchedCount: 0 };
        for (const [key, value] of Object.entries(update.$set)) {
          (row as unknown as Record<string, unknown>)[key] = value;
        }
        return { acknowledged: true, modifiedCount: 1, matchedCount: 1 };
      },
    }),
  );

  return {
    model: { findOne, create, updateOne } as unknown as SeedModel,
    store,
    findOne,
    create,
    updateOne,
  };
}

const sample: SampleProduct = {
  name: 'Sample Keyboard',
  description: 'Original description.',
  category: 'electronics',
  priceMinor: 12900,
  currency: 'USD',
  initialStock: 50,
  attributes: { switch: 'brown' },
  images: ['https://cdn.example.com/kb.jpg'],
  isActive: true,
};

describe('seedProducts', () => {
  it('creates all items in an empty database with initialStock + reserved=0', async () => {
    const { model, store, create, updateOne } = makeModelStub();

    const summary = await seedProducts(model, [sample]);

    expect(summary).toEqual<SeedProductsSummary>({
      created: 1,
      updated: 0,
      unchanged: 0,
      total: 1,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(updateOne).not.toHaveBeenCalled();

    const row = store[0];
    expect(row.name).toBe(sample.name);
    expect(row.category).toBe(sample.category);
    expect(row.priceMinor).toBe(sample.priceMinor);
    expect(row.stock).toEqual({ available: sample.initialStock, reserved: 0 });
    expect(row.attributes).toEqual(sample.attributes);
    expect(row.images).toEqual(sample.images);
  });

  it('re-running against an identical database is a no-op (unchanged counted)', async () => {
    const { model, store, create, updateOne } = makeModelStub();

    await seedProducts(model, [sample]);
    create.mockClear();
    updateOne.mockClear();

    const second = await seedProducts(model, [sample]);

    expect(second).toEqual<SeedProductsSummary>({
      created: 0,
      updated: 0,
      unchanged: 1,
      total: 1,
    });
    expect(create).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(store).toHaveLength(1);
  });

  it('updates drifted fields but preserves live stock counters', async () => {
    const liveStock = { available: 7, reserved: 3 };
    const existing: StoreRow = {
      _id: new Types.ObjectId(),
      name: sample.name,
      description: 'Old description',
      category: sample.category,
      priceMinor: 9900,
      currency: 'USD',
      stock: liveStock,
      attributes: { switch: 'red' },
      images: ['https://cdn.example.com/old.jpg'],
      isActive: false,
    };
    const { model, store, create, updateOne } = makeModelStub([existing]);

    const summary = await seedProducts(model, [sample]);

    expect(summary).toEqual<SeedProductsSummary>({
      created: 0,
      updated: 1,
      unchanged: 0,
      total: 1,
    });
    expect(create).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledTimes(1);

    const [, update] = updateOne.mock.calls[0] as [unknown, { $set: Record<string, unknown> }];
    // Catalog drift goes through.
    expect(update.$set.description).toBe(sample.description);
    expect(update.$set.priceMinor).toBe(sample.priceMinor);
    expect(update.$set.isActive).toBe(true);
    expect(update.$set.attributes).toEqual(sample.attributes);
    expect(update.$set.images).toEqual(sample.images);
    // Stock is never in the update payload — operational data is sacred.
    expect(update.$set).not.toHaveProperty('stock');
    expect(update.$set).not.toHaveProperty('stock.available');
    expect(update.$set).not.toHaveProperty('stock.reserved');
    expect(store[0].stock).toEqual(liveStock);
  });

  it('treats the same name across different categories as separate products', async () => {
    const dup: SampleProduct = { ...sample, category: 'home' };
    const { model, store, create } = makeModelStub();

    const summary = await seedProducts(model, [sample, dup]);

    expect(summary.created).toBe(2);
    expect(summary.total).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(store).toHaveLength(2);
    expect(store.map((r) => r.category).sort()).toEqual(['electronics', 'home']);
  });

  it('tolerates attributes stored as a Map (as hydrated from Mongo) when diffing', async () => {
    // Mimic how Mongoose returns the Map on a real fetched document.
    const existing: StoreRow = {
      _id: new Types.ObjectId(),
      name: sample.name,
      description: sample.description,
      category: sample.category,
      priceMinor: sample.priceMinor,
      currency: sample.currency,
      stock: { available: sample.initialStock, reserved: 0 },
      attributes: sample.attributes,
      images: [...sample.images],
      isActive: sample.isActive,
    };
    const { model, updateOne, create } = makeModelStub([existing]);

    const summary = await seedProducts(model, [sample]);

    expect(summary).toEqual<SeedProductsSummary>({
      created: 0,
      updated: 0,
      unchanged: 1,
      total: 1,
    });
    expect(create).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('updates a drifted single attribute key without touching other fields', async () => {
    const existing: StoreRow = {
      _id: new Types.ObjectId(),
      name: sample.name,
      description: sample.description,
      category: sample.category,
      priceMinor: sample.priceMinor,
      currency: sample.currency,
      stock: { available: 50, reserved: 0 },
      attributes: { switch: 'red' },
      images: [...sample.images],
      isActive: true,
    };
    const { model, updateOne } = makeModelStub([existing]);

    await seedProducts(model, [sample]);

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [, update] = updateOne.mock.calls[0] as [unknown, { $set: Record<string, unknown> }];
    expect(update.$set).toEqual({ attributes: sample.attributes });
  });
});

describe('parseEnv', () => {
  it('returns the connection string and the default sample catalog', () => {
    const result = parseEnv({ MONGO_URI: 'mongodb://localhost:27017/product' });
    expect(result.mongoUri).toBe('mongodb://localhost:27017/product');
    expect(result.catalog.length).toBeGreaterThan(0);
    // Catalog items are catalog-shaped (duck-typed check against the interface).
    const first = result.catalog[0];
    expect(typeof first.name).toBe('string');
    expect(typeof first.category).toBe('string');
    expect(Number.isInteger(first.priceMinor)).toBe(true);
    expect(first.priceMinor).toBeGreaterThanOrEqual(0);
  });

  it('rejects a missing MONGO_URI with a helpful error', () => {
    expect(() => parseEnv({})).toThrow(/MONGO_URI/);
  });
});
