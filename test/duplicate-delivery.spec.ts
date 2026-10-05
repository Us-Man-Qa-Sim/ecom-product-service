import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { TOPICS } from '@us-man-qa-sim/ecom-contracts/events';
import { OrderCreatedHandler } from '../src/kafka/handlers/order-created.handler';

const uuid = () => randomUUID();
const objectId = () => new Types.ObjectId().toString();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chainable(result: unknown) {
  const obj: Record<string, unknown> = {};
  obj.session = jest.fn().mockReturnValue(obj);
  obj.exec = jest.fn().mockResolvedValue(result);
  return obj;
}

function makeModels() {
  return {
    processedEventModel: { create: jest.fn() },
    reservationModel: {
      findOne: jest.fn().mockImplementation(() => chainable(null)),
      create: jest.fn(),
      updateOne: jest.fn(),
    },
    productModel: {
      find: jest.fn().mockImplementation(() => chainable([])),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    },
    outboxModel: { create: jest.fn() },
    connection: {
      transaction: jest.fn(async (fn: (session: unknown) => Promise<void>) => fn({})),
    },
    consumerService: { subscribe: jest.fn() },
  };
}

function buildHandler(models: ReturnType<typeof makeModels>) {
  return new OrderCreatedHandler(
    models.connection as any,
    models.productModel as any,
    models.reservationModel as any,
    models.processedEventModel as any,
    models.outboxModel as any,
    models.consumerService as any,
  );
}

function orderCreatedEvent(orderId: string, productId: string) {
  return {
    eventId: uuid(),
    eventType: TOPICS.ORDER_CREATED as const,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: uuid(),
    payload: { orderId, items: [{ productId, quantity: 1 }] },
  };
}

function duplicateKeyError(): Error {
  return Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
}

// ---------------------------------------------------------------------------
// KFK-11: Duplicate-delivery test — replay same event → no double reservation
// ---------------------------------------------------------------------------

describe('KFK-11: duplicate delivery — replay same event → no double reservation', () => {
  const productId = objectId();

  function setupProduct(models: ReturnType<typeof makeModels>) {
    const product = {
      _id: new Types.ObjectId(productId),
      name: 'Widget',
      stock: { available: 5, reserved: 0 },
    };
    models.productModel.find.mockImplementation(() => chainable([product]));
  }

  it('first delivery reserves stock; replay is a silent no-op', async () => {
    const models = makeModels();
    setupProduct(models);
    const handler = buildHandler(models);

    const event = orderCreatedEvent(uuid(), productId);

    // --- first delivery: full happy path ---
    await handler.handle(event);

    expect(models.productModel.updateOne).toHaveBeenCalledTimes(1);
    expect(models.reservationModel.create).toHaveBeenCalledTimes(1);
    expect(models.outboxModel.create).toHaveBeenCalledTimes(1);

    // --- replay: inbox unique index rejects the duplicate eventId ---
    models.processedEventModel.create.mockRejectedValueOnce(duplicateKeyError());

    await handler.handle(event);

    // side-effect counts unchanged — nothing ran past the inbox check
    expect(models.productModel.updateOne).toHaveBeenCalledTimes(1);
    expect(models.reservationModel.create).toHaveBeenCalledTimes(1);
    expect(models.outboxModel.create).toHaveBeenCalledTimes(1);
  });

  it('replay does not throw (error is swallowed, not propagated)', async () => {
    const models = makeModels();
    setupProduct(models);
    const handler = buildHandler(models);

    const event = orderCreatedEvent(uuid(), productId);
    await handler.handle(event);

    models.processedEventModel.create.mockRejectedValueOnce(duplicateKeyError());

    await expect(handler.handle(event)).resolves.toBeUndefined();
  });

  it('non-duplicate errors still propagate', async () => {
    const models = makeModels();
    setupProduct(models);
    const handler = buildHandler(models);

    const event = orderCreatedEvent(uuid(), productId);

    const transientError = new Error('connection reset');
    models.processedEventModel.create.mockRejectedValueOnce(transientError);

    await expect(handler.handle(event)).rejects.toThrow('connection reset');
  });

  it('triple delivery still produces exactly one reservation', async () => {
    const models = makeModels();
    setupProduct(models);
    const handler = buildHandler(models);

    const event = orderCreatedEvent(uuid(), productId);

    await handler.handle(event);

    models.processedEventModel.create.mockRejectedValueOnce(duplicateKeyError());
    await handler.handle(event);

    models.processedEventModel.create.mockRejectedValueOnce(duplicateKeyError());
    await handler.handle(event);

    expect(models.reservationModel.create).toHaveBeenCalledTimes(1);
    expect(models.outboxModel.create).toHaveBeenCalledTimes(1);
    expect(models.productModel.updateOne).toHaveBeenCalledTimes(1);
  });
});
