import { Mongoose } from 'mongoose';
import { Product, ProductSchema, type ProductDocument } from '../src/schemas/product.schema';
import { dateToTimestamp, toProtoProduct } from '../src/product/product.mapper';

const m = new Mongoose();
const ProductModel = m.model(Product.name, ProductSchema);

function build(overrides: Partial<Record<string, unknown>> = {}): ProductDocument {
  const doc = new ProductModel({
    name: 'Widget',
    description: 'A widget',
    category: 'tools',
    priceMinor: 1999,
    currency: 'USD',
    stock: { available: 10, reserved: 2 },
    attributes: { color: 'red' },
    images: ['https://img/1.png'],
    isActive: true,
    ...overrides,
  }) as ProductDocument;
  // `timestamps: true` only stamps on save; set the fields explicitly for the
  // tests that assert on the mapped `createdAt`/`updatedAt`.
  doc.set('createdAt', new Date('2026-01-02T03:04:05.678Z'));
  doc.set('updatedAt', new Date('2026-01-02T03:04:05.678Z'));
  return doc;
}

describe('dateToTimestamp', () => {
  it('splits a millisecond timestamp into seconds and nanos', () => {
    expect(dateToTimestamp(new Date(1_700_000_000_123))).toEqual({
      seconds: 1_700_000_000,
      nanos: 123_000_000,
    });
  });

  it('handles the Unix epoch', () => {
    expect(dateToTimestamp(new Date(0))).toEqual({ seconds: 0, nanos: 0 });
  });
});

describe('toProtoProduct', () => {
  it('maps every field in the schema', () => {
    const doc = build();
    const proto = toProtoProduct(doc);
    expect(proto).toEqual({
      id: doc._id.toString(),
      name: 'Widget',
      description: 'A widget',
      category: 'tools',
      price: { amountMinor: 1999, currency: 'USD' },
      stock: { available: 10, reserved: 2 },
      attributes: { color: 'red' },
      images: ['https://img/1.png'],
      isActive: true,
      createdAt: dateToTimestamp(new Date('2026-01-02T03:04:05.678Z')),
      updatedAt: dateToTimestamp(new Date('2026-01-02T03:04:05.678Z')),
    });
  });

  it('serialises an empty attributes map to an empty object', () => {
    const doc = build({ attributes: {} });
    expect(toProtoProduct(doc).attributes).toEqual({});
  });

  it('coerces non-string Mixed values to strings', () => {
    const doc = build({ attributes: { count: 3 } });
    expect(toProtoProduct(doc).attributes).toEqual({ count: '3' });
  });

  it('returns a fresh images array (not a shared reference)', () => {
    const doc = build();
    const proto = toProtoProduct(doc);
    proto.images.push('mutated');
    expect(doc.images).toEqual(['https://img/1.png']);
  });
});
