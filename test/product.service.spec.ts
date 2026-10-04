import { Mongoose, Types } from 'mongoose';
import type { Model } from 'mongoose';
import { Product, ProductSchema, type ProductDocument } from '../src/schemas/product.schema';
import { ProductService } from '../src/product/product.service';
import {
  FailedPreconditionError,
  NotFoundError,
  ValidationError,
} from '../src/common/errors/domain-errors';

// A single isolated Mongoose instance is enough to build Product documents
// locally. The service only needs the Model surface we mock below (no live
// connection) — we hand it a fake Model.
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
  createdAt: Date;
  updatedAt: Date;
}

type UnknownFilter = Record<string, unknown>;

function hydrate(row: StoreRow): ProductDocument {
  // Build a real Mongoose document to feed the real mapper. `attributes` is a
  // Map on the document; the row keeps a plain object for easier assertions.
  const doc = new ProductModel(row) as ProductDocument;
  doc._id = row._id;
  doc.set('createdAt', row.createdAt);
  doc.set('updatedAt', row.updatedAt);
  // `isNew: false` so the document behaves like one fetched from Mongo.
  (doc as unknown as { isNew: boolean }).isNew = false;
  return doc;
}

function matchesFilter(row: StoreRow, filter: UnknownFilter): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$text') {
      const needle = String((value as { $search: string }).$search).toLowerCase();
      if (
        !row.name.toLowerCase().includes(needle) &&
        !row.description.toLowerCase().includes(needle)
      )
        return false;
      continue;
    }
    if (key === '_id') {
      const id = row._id.toString();
      if ((value as { $in?: string[] }).$in) {
        if (!(value as { $in: string[] }).$in.includes(id)) return false;
      } else if (id !== String(value)) {
        return false;
      }
      continue;
    }
    if (key === 'priceMinor' && typeof value === 'object' && value !== null) {
      const range = value as { $gte?: number; $lte?: number };
      if (range.$gte !== undefined && row.priceMinor < range.$gte) return false;
      if (range.$lte !== undefined && row.priceMinor > range.$lte) return false;
      continue;
    }
    if (key === 'stock.available' && typeof value === 'object' && value !== null) {
      const range = value as { $gte?: number; $lte?: number };
      if (range.$gte !== undefined && row.stock.available < range.$gte) return false;
      if (range.$lte !== undefined && row.stock.available > range.$lte) return false;
      continue;
    }
    const rowValue = (row as unknown as Record<string, unknown>)[key];
    if (rowValue !== value) return false;
  }
  return true;
}

interface ChainableFind {
  sort(spec: Record<string, unknown>): ChainableFind;
  skip(n: number): ChainableFind;
  limit(n: number): ChainableFind;
  exec(): Promise<ProductDocument[]>;
}

function makeModelStub(initial: StoreRow[] = []): {
  model: Model<ProductDocument>;
  store: StoreRow[];
  calls: {
    find: Array<{ filter: UnknownFilter; projection?: Record<string, unknown> }>;
    count: UnknownFilter[];
  };
} {
  const store: StoreRow[] = [...initial];
  const calls = {
    find: [] as Array<{ filter: UnknownFilter; projection?: Record<string, unknown> }>,
    count: [] as UnknownFilter[],
  };

  const findChain = (
    filter: UnknownFilter,
    projection?: Record<string, unknown>,
  ): ChainableFind => {
    calls.find.push({ filter, projection });
    const state = {
      sort: { createdAt: -1 } as Record<string, unknown>,
      skip: 0,
      limit: Infinity,
    };
    const chain: ChainableFind = {
      sort(spec) {
        state.sort = spec;
        return chain;
      },
      skip(n) {
        state.skip = n;
        return chain;
      },
      limit(n) {
        state.limit = n;
        return chain;
      },
      async exec() {
        const matched = store.filter((row) => matchesFilter(row, filter));
        const sortedRows = [...matched];
        const keys = Object.keys(state.sort);
        sortedRows.sort((a, b) => {
          for (const key of keys) {
            const dir = state.sort[key] as number | { $meta: string };
            if (typeof dir === 'object') continue;
            const av = (a as unknown as Record<string, unknown>)[key] as number | Date;
            const bv = (b as unknown as Record<string, unknown>)[key] as number | Date;
            if (av === bv) continue;
            const cmp = av > bv ? 1 : -1;
            return dir === -1 ? -cmp : cmp;
          }
          return 0;
        });
        return sortedRows.slice(state.skip, state.skip + state.limit).map(hydrate);
      },
    };
    return chain;
  };

  const model = {
    find: jest.fn((filter: UnknownFilter, projection?: Record<string, unknown>) =>
      findChain(filter ?? {}, projection),
    ),
    countDocuments: jest.fn((filter: UnknownFilter) => {
      calls.count.push(filter ?? {});
      return {
        exec: async () => store.filter((row) => matchesFilter(row, filter ?? {})).length,
      };
    }),
    findById: jest.fn((id: string) => ({
      exec: async () => {
        const row = store.find((r) => r._id.toString() === id);
        return row ? hydrate(row) : null;
      },
    })),
    findByIdAndUpdate: jest.fn((id: string, update: { $set: Record<string, unknown> }) => ({
      exec: async () => {
        const row = store.find((r) => r._id.toString() === id);
        if (!row) return null;
        Object.assign(row, update.$set);
        row.updatedAt = new Date();
        return hydrate(row);
      },
    })),
    findByIdAndDelete: jest.fn((id: string) => ({
      exec: async () => {
        const idx = store.findIndex((r) => r._id.toString() === id);
        if (idx === -1) return null;
        const [removed] = store.splice(idx, 1);
        return hydrate(removed);
      },
    })),
    findOneAndUpdate: jest.fn(
      (filter: UnknownFilter, update: { $inc?: Record<string, number> }) => ({
        exec: async () => {
          const row = store.find((r) => matchesFilter(r, filter));
          if (!row) return null;
          if (update.$inc) {
            for (const [key, delta] of Object.entries(update.$inc)) {
              if (key === 'stock.available') {
                row.stock.available += delta;
              } else if (key === 'stock.reserved') {
                row.stock.reserved += delta;
              } else {
                const r = row as unknown as Record<string, number>;
                r[key] = (r[key] ?? 0) + delta;
              }
            }
          }
          row.updatedAt = new Date();
          return hydrate(row);
        },
      }),
    ),
  };

  // The service calls `new this.productModel(data)` + `.save()`. Model is used
  // as both a value and a constructor, so wrap it in a function that returns a
  // thenable save() returning a hydrated document.
  const ModelCtor = function (this: unknown, data: Partial<StoreRow>) {
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
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (this as { save: () => Promise<ProductDocument>; row: StoreRow }).row = row;
    (this as { save: () => Promise<ProductDocument> }).save = async () => {
      store.push(row);
      return hydrate(row);
    };
  } as unknown as new (data: Partial<StoreRow>) => { save(): Promise<ProductDocument> };

  // Merge the Model's methods onto the constructor so `productModel.find(...)`
  // and `new productModel(...)` both work.
  Object.assign(ModelCtor, model);

  return {
    model: ModelCtor as unknown as Model<ProductDocument>,
    store,
    calls,
  };
}

function row(overrides: Partial<StoreRow> = {}): StoreRow {
  return {
    _id: new Types.ObjectId(),
    name: 'Widget',
    description: 'Default description',
    category: 'tools',
    priceMinor: 1000,
    currency: 'USD',
    stock: { available: 5, reserved: 0 },
    attributes: {},
    images: [],
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('ProductService.create', () => {
  it('creates a product with the given fields and default stock reserved=0', async () => {
    const stub = makeModelStub();
    const svc = new ProductService(stub.model);
    const doc = await svc.create({
      name: 'Thing',
      description: 'An item',
      category: 'tools',
      price: { amountMinor: 999, currency: 'usd' },
      initialStock: 7,
      attributes: { color: 'red' },
      images: ['https://img/a.png'],
    });
    expect(stub.store).toHaveLength(1);
    expect(doc.name).toBe('Thing');
    expect(doc.priceMinor).toBe(999);
    expect(doc.currency).toBe('USD');
    expect(doc.stock.available).toBe(7);
    expect(doc.stock.reserved).toBe(0);
  });

  it('rejects an invalid payload with ValidationError', async () => {
    const stub = makeModelStub();
    const svc = new ProductService(stub.model);
    await expect(
      svc.create({
        name: '',
        category: 'tools',
        price: { amountMinor: 100, currency: 'USD' },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(stub.store).toHaveLength(0);
  });

  it('rejects a non-ISO currency', async () => {
    const stub = makeModelStub();
    const svc = new ProductService(stub.model);
    await expect(
      svc.create({
        name: 'Thing',
        category: 'tools',
        price: { amountMinor: 100, currency: 'DOLLARS' },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a negative price', async () => {
    const stub = makeModelStub();
    const svc = new ProductService(stub.model);
    await expect(
      svc.create({
        name: 'Thing',
        category: 'tools',
        price: { amountMinor: -1, currency: 'USD' },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('ProductService.update', () => {
  it('applies partial changes and returns the updated document', async () => {
    const r = row();
    const stub = makeModelStub([r]);
    const svc = new ProductService(stub.model);
    const updated = await svc.update({
      productId: r._id.toString(),
      name: 'Renamed',
      price: { amountMinor: 2500, currency: 'eur' },
    });
    expect(updated.name).toBe('Renamed');
    expect(stub.store[0].name).toBe('Renamed');
    expect(stub.store[0].priceMinor).toBe(2500);
    expect(stub.store[0].currency).toBe('EUR');
  });

  it('replaces images and attributes when the wrapper is set', async () => {
    const r = row({ images: ['https://old/1.png'], attributes: { color: 'red' } });
    const stub = makeModelStub([r]);
    const svc = new ProductService(stub.model);
    await svc.update({
      productId: r._id.toString(),
      images: { urls: ['https://new/1.png'] },
      attributes: { values: {} },
    });
    expect(stub.store[0].images).toEqual(['https://new/1.png']);
    expect(stub.store[0].attributes).toEqual({});
  });

  it('throws NotFoundError for an unknown id', async () => {
    const stub = makeModelStub();
    const svc = new ProductService(stub.model);
    await expect(
      svc.update({ productId: new Types.ObjectId().toString(), name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects an empty update', async () => {
    const stub = makeModelStub([row()]);
    const svc = new ProductService(stub.model);
    await expect(svc.update({ productId: stub.store[0]._id.toString() })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects a malformed id with ValidationError (not a Mongo cast error)', async () => {
    const stub = makeModelStub();
    const svc = new ProductService(stub.model);
    await expect(svc.update({ productId: 'not-an-id', name: 'x' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('ProductService.remove', () => {
  it('deletes an existing product', async () => {
    const r = row();
    const stub = makeModelStub([r]);
    const svc = new ProductService(stub.model);
    await svc.remove({ productId: r._id.toString() });
    expect(stub.store).toHaveLength(0);
  });

  it('throws NotFoundError for an unknown id', async () => {
    const stub = makeModelStub();
    const svc = new ProductService(stub.model);
    await expect(svc.remove({ productId: new Types.ObjectId().toString() })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('rejects a malformed id with ValidationError', async () => {
    const stub = makeModelStub();
    const svc = new ProductService(stub.model);
    await expect(svc.remove({ productId: 'nope' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('ProductService.get', () => {
  it('returns the matching document', async () => {
    const r = row({ name: 'Found me' });
    const stub = makeModelStub([r]);
    const svc = new ProductService(stub.model);
    const doc = await svc.get({ productId: r._id.toString() });
    expect(doc.name).toBe('Found me');
  });

  it('throws NotFoundError when no product matches', async () => {
    const stub = makeModelStub();
    const svc = new ProductService(stub.model);
    await expect(svc.get({ productId: new Types.ObjectId().toString() })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('ProductService.list', () => {
  function seed(): StoreRow[] {
    return [
      row({
        name: 'Alpha',
        category: 'tools',
        priceMinor: 500,
        isActive: true,
        createdAt: new Date('2026-01-01'),
      }),
      row({
        name: 'Beta',
        category: 'tools',
        priceMinor: 1500,
        isActive: true,
        createdAt: new Date('2026-01-02'),
      }),
      row({
        name: 'Gamma',
        category: 'books',
        priceMinor: 2500,
        isActive: false,
        createdAt: new Date('2026-01-03'),
      }),
      row({
        name: 'Delta',
        category: 'books',
        description: 'a special widget',
        priceMinor: 3500,
        isActive: true,
        createdAt: new Date('2026-01-04'),
      }),
    ];
  }

  it('applies defaults when no pagination is provided', async () => {
    const stub = makeModelStub(seed());
    const svc = new ProductService(stub.model);
    const result = await svc.list({});
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.total).toBe(4);
    expect(result.totalPages).toBe(1);
    expect(result.products).toHaveLength(4);
  });

  it('filters by category', async () => {
    const stub = makeModelStub(seed());
    const svc = new ProductService(stub.model);
    const result = await svc.list({ category: 'books' });
    expect(result.total).toBe(2);
    expect(result.products.map((p) => p.name).sort()).toEqual(['Delta', 'Gamma']);
  });

  it('filters by isActive', async () => {
    const stub = makeModelStub(seed());
    const svc = new ProductService(stub.model);
    const result = await svc.list({ isActive: false });
    expect(result.total).toBe(1);
    expect(result.products[0].name).toBe('Gamma');
  });

  it('filters by price range', async () => {
    const stub = makeModelStub(seed());
    const svc = new ProductService(stub.model);
    const result = await svc.list({ minPriceMinor: 1000, maxPriceMinor: 3000 });
    expect(result.total).toBe(2);
    expect(result.products.map((p) => p.name).sort()).toEqual(['Beta', 'Gamma']);
  });

  it('rejects an inverted price range', async () => {
    const stub = makeModelStub(seed());
    const svc = new ProductService(stub.model);
    await expect(svc.list({ minPriceMinor: 5000, maxPriceMinor: 100 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('paginates with correct totals', async () => {
    const stub = makeModelStub(seed());
    const svc = new ProductService(stub.model);
    const page1 = await svc.list({ pagination: { page: 1, pageSize: 2 } });
    expect(page1.total).toBe(4);
    expect(page1.totalPages).toBe(2);
    expect(page1.products).toHaveLength(2);
    const page2 = await svc.list({ pagination: { page: 2, pageSize: 2 } });
    expect(page2.products).toHaveLength(2);
    // page 1 and page 2 should not overlap
    const names1 = page1.products.map((p) => p.name);
    const names2 = page2.products.map((p) => p.name);
    expect(names1.some((n) => names2.includes(n))).toBe(false);
  });

  it('passes a $text clause and textScore projection when search is set', async () => {
    const stub = makeModelStub(seed());
    const svc = new ProductService(stub.model);
    const result = await svc.list({ search: 'widget' });
    expect(result.products.map((p) => p.name)).toContain('Delta');
    const lastFind = stub.calls.find[stub.calls.find.length - 1];
    expect(lastFind.filter.$text).toEqual({ $search: 'widget' });
    expect(lastFind.projection).toEqual({ score: { $meta: 'textScore' } });
  });

  it('shares the same filter for count and find', async () => {
    const stub = makeModelStub(seed());
    const svc = new ProductService(stub.model);
    await svc.list({ category: 'tools', isActive: true });
    const lastCount = stub.calls.count[stub.calls.count.length - 1];
    const lastFind = stub.calls.find[stub.calls.find.length - 1];
    expect(lastCount).toEqual(lastFind.filter);
  });

  it('rejects a pageSize above 100', async () => {
    const stub = makeModelStub(seed());
    const svc = new ProductService(stub.model);
    await expect(svc.list({ pagination: { page: 1, pageSize: 101 } })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('ProductService.getByIds', () => {
  it('returns the matching products', async () => {
    const r1 = row({ name: 'A' });
    const r2 = row({ name: 'B' });
    const r3 = row({ name: 'C' });
    const stub = makeModelStub([r1, r2, r3]);
    const svc = new ProductService(stub.model);
    const docs = await svc.getByIds({
      productIds: [r1._id.toString(), r3._id.toString()],
    });
    expect(docs.map((d) => d.name).sort()).toEqual(['A', 'C']);
  });

  it('de-duplicates repeated ids', async () => {
    const r1 = row();
    const stub = makeModelStub([r1]);
    const svc = new ProductService(stub.model);
    const id = r1._id.toString();
    const docs = await svc.getByIds({ productIds: [id, id, id] });
    expect(docs).toHaveLength(1);
    // The $in list should hold the id exactly once.
    const call = stub.calls.find[stub.calls.find.length - 1];
    expect((call.filter._id as { $in: string[] }).$in).toEqual([id]);
  });

  it('rejects an empty id list', async () => {
    const stub = makeModelStub();
    const svc = new ProductService(stub.model);
    await expect(svc.getByIds({ productIds: [] })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a malformed id', async () => {
    const stub = makeModelStub();
    const svc = new ProductService(stub.model);
    await expect(svc.getByIds({ productIds: ['nope'] })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('ProductService.adjustStock', () => {
  it('increments available for a positive delta without touching reserved', async () => {
    const r = row({ stock: { available: 5, reserved: 3 } });
    const stub = makeModelStub([r]);
    const svc = new ProductService(stub.model);
    const doc = await svc.adjustStock({ productId: r._id.toString(), delta: 7 });
    expect(doc.stock.available).toBe(12);
    expect(doc.stock.reserved).toBe(3);
    expect(stub.store[0].stock.available).toBe(12);
    expect(stub.store[0].stock.reserved).toBe(3);
  });

  it('decrements available for a negative delta when stock is sufficient', async () => {
    const r = row({ stock: { available: 10, reserved: 2 } });
    const stub = makeModelStub([r]);
    const svc = new ProductService(stub.model);
    const doc = await svc.adjustStock({ productId: r._id.toString(), delta: -4 });
    expect(doc.stock.available).toBe(6);
    expect(doc.stock.reserved).toBe(2);
  });

  it('guards negative deltas with stock.available >= -delta', async () => {
    const r = row({ stock: { available: 2, reserved: 0 } });
    const stub = makeModelStub([r]);
    const svc = new ProductService(stub.model);
    await expect(
      svc.adjustStock({ productId: r._id.toString(), delta: -5 }),
    ).rejects.toBeInstanceOf(FailedPreconditionError);
    // Store must be untouched when the guard fails.
    expect(stub.store[0].stock.available).toBe(2);
    // The guarded filter must have been sent to the DB.
    const call = stub.model.findOneAndUpdate as unknown as jest.Mock;
    const [filter] = call.mock.calls[call.mock.calls.length - 1];
    expect(filter['stock.available']).toEqual({ $gte: 5 });
  });

  it('does not use a stock guard for positive deltas', async () => {
    const r = row({ stock: { available: 1, reserved: 0 } });
    const stub = makeModelStub([r]);
    const svc = new ProductService(stub.model);
    await svc.adjustStock({ productId: r._id.toString(), delta: 100 });
    const call = stub.model.findOneAndUpdate as unknown as jest.Mock;
    const [filter] = call.mock.calls[call.mock.calls.length - 1];
    expect(filter['stock.available']).toBeUndefined();
  });

  it('throws NotFoundError for an unknown product id', async () => {
    const stub = makeModelStub();
    const svc = new ProductService(stub.model);
    await expect(
      svc.adjustStock({ productId: new Types.ObjectId().toString(), delta: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a zero delta with ValidationError', async () => {
    const r = row();
    const stub = makeModelStub([r]);
    const svc = new ProductService(stub.model);
    await expect(svc.adjustStock({ productId: r._id.toString(), delta: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(stub.model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a non-integer delta with ValidationError', async () => {
    const r = row();
    const stub = makeModelStub([r]);
    const svc = new ProductService(stub.model);
    await expect(
      svc.adjustStock({ productId: r._id.toString(), delta: 1.5 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a delta outside int32 bounds', async () => {
    const r = row();
    const stub = makeModelStub([r]);
    const svc = new ProductService(stub.model);
    await expect(
      svc.adjustStock({ productId: r._id.toString(), delta: 2_147_483_648 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a malformed id with ValidationError', async () => {
    const stub = makeModelStub();
    const svc = new ProductService(stub.model);
    await expect(svc.adjustStock({ productId: 'nope', delta: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
