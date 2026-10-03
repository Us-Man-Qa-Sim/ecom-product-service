import { Mongoose, Types } from 'mongoose';
import { Outbox, OutboxSchema } from '../src/schemas/outbox.schema';
import { ProcessedEvent, ProcessedEventSchema } from '../src/schemas/processed-event.schema';
import { Product, ProductSchema } from '../src/schemas/product.schema';
import { StockReservation, StockReservationSchema } from '../src/schemas/stock-reservation.schema';

// An isolated Mongoose instance keeps model registration local to this file (no
// global OverwriteModelError across suites) and needs no live connection:
// validateSync() and Schema.indexes() are pure, in-memory operations.
const m = new Mongoose();
const ProductModel = m.model(Product.name, ProductSchema);
const OutboxModel = m.model(Outbox.name, OutboxSchema);
const ProcessedEventModel = m.model(ProcessedEvent.name, ProcessedEventSchema);
const StockReservationModel = m.model(StockReservation.name, StockReservationSchema);

/** Flatten `Schema.indexes()` into `{ keys, options }` for easy assertions. */
function indexesOf(model: {
  schema: { indexes(): [Record<string, unknown>, Record<string, unknown>][] };
}) {
  return model.schema.indexes().map(([keys, options]) => ({ keys, options }));
}

describe('Product schema', () => {
  const valid = () => ({
    name: 'Widget',
    category: 'tools',
    priceMinor: 1999,
    currency: 'USD',
  });

  it('applies defaults for optional fields', () => {
    const doc = new ProductModel(valid());
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.description).toBe('');
    expect(doc.currency).toBe('USD');
    expect(doc.isActive).toBe(true);
    expect(doc.images).toEqual([]);
    expect(doc.attributes).toBeInstanceOf(Map);
    expect(doc.attributes.size).toBe(0);
    expect(doc.stock.available).toBe(0);
    expect(doc.stock.reserved).toBe(0);
  });

  it('requires name, category and priceMinor', () => {
    const errors = new ProductModel({ currency: 'USD' }).validateSync();
    expect(errors?.errors.name).toBeDefined();
    expect(errors?.errors.category).toBeDefined();
    expect(errors?.errors.priceMinor).toBeDefined();
  });

  it('rejects a negative priceMinor', () => {
    const errors = new ProductModel({ ...valid(), priceMinor: -1 }).validateSync();
    expect(errors?.errors.priceMinor).toBeDefined();
  });

  it('rejects negative stock counters', () => {
    const errors = new ProductModel({
      ...valid(),
      stock: { available: -1, reserved: -5 },
    }).validateSync();
    expect(errors?.errors['stock.available']).toBeDefined();
    expect(errors?.errors['stock.reserved']).toBeDefined();
  });

  it('stores arbitrary attributes as a Map of Mixed values', () => {
    const doc = new ProductModel({ ...valid(), attributes: { color: 'red', sizes: [1, 2] } });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.attributes.get('color')).toBe('red');
    expect(doc.attributes.get('sizes')).toEqual([1, 2]);
  });

  it('declares category and isActive filter indexes', () => {
    const keys = indexesOf(ProductModel).map((i) => i.keys);
    expect(keys).toContainEqual({ category: 1 });
    expect(keys).toContainEqual({ isActive: 1 });
  });

  it('enables timestamps', () => {
    expect(ProductModel.schema.get('timestamps')).toBe(true);
  });
});

describe('StockReservation schema', () => {
  const valid = () => ({
    orderId: 'order-1',
    items: [{ productId: new Types.ObjectId(), quantity: 2 }],
  });

  it('defaults status to ACTIVE', () => {
    const doc = new StockReservationModel(valid());
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.status).toBe('ACTIVE');
  });

  it('requires orderId (items defaults to an empty array)', () => {
    const doc = new StockReservationModel({});
    const errors = doc.validateSync();
    expect(errors?.errors.orderId).toBeDefined();
    // Mongoose treats `required` on an array as "not null" — an empty array
    // passes — so a missing `items` is coerced to [] rather than rejected.
    expect(errors?.errors.items).toBeUndefined();
    expect(doc.items).toEqual([]);
  });

  it('rejects an item quantity below 1', () => {
    const errors = new StockReservationModel({
      orderId: 'order-1',
      items: [{ productId: new Types.ObjectId(), quantity: 0 }],
    }).validateSync();
    expect(errors?.errors['items.0.quantity']).toBeDefined();
  });

  it('rejects a status outside the allowed set', () => {
    const errors = new StockReservationModel({ ...valid(), status: 'NOPE' }).validateSync();
    expect(errors?.errors.status).toBeDefined();
  });

  it('declares a unique index on orderId', () => {
    const orderIdIndex = indexesOf(StockReservationModel).find((i) => 'orderId' in i.keys);
    expect(orderIdIndex?.options.unique).toBe(true);
  });

  it('does not give embedded items their own _id', () => {
    const doc = new StockReservationModel(valid());
    expect((doc.items[0] as unknown as { _id?: unknown })._id).toBeUndefined();
  });
});

describe('ProcessedEvent schema', () => {
  it('requires eventId and eventType and defaults processedAt', () => {
    const doc = new ProcessedEventModel({ eventId: 'e1', eventType: 'order.created' });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.processedAt).toBeInstanceOf(Date);
    const errors = new ProcessedEventModel({}).validateSync();
    expect(errors?.errors.eventId).toBeDefined();
    expect(errors?.errors.eventType).toBeDefined();
  });

  it('declares a unique index on eventId', () => {
    const eventIdIndex = indexesOf(ProcessedEventModel).find((i) => 'eventId' in i.keys);
    expect(eventIdIndex?.options.unique).toBe(true);
  });
});

describe('Outbox schema', () => {
  const valid = () => ({
    aggregateType: 'StockReservation',
    aggregateId: 'order-1',
    eventType: 'order.stock-reserved',
    payload: { orderId: 'order-1' },
  });

  it('defaults sentAt to null and stamps createdAt', () => {
    const doc = new OutboxModel(valid());
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.sentAt).toBeNull();
    expect(doc.createdAt).toBeInstanceOf(Date);
  });

  it('requires aggregateType, aggregateId, eventType and payload', () => {
    const errors = new OutboxModel({}).validateSync();
    expect(errors?.errors.aggregateType).toBeDefined();
    expect(errors?.errors.aggregateId).toBeDefined();
    expect(errors?.errors.eventType).toBeDefined();
    expect(errors?.errors.payload).toBeDefined();
  });
});
