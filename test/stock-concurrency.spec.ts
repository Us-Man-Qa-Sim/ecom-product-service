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

// ---------------------------------------------------------------------------
// KFK-10: N parallel orders for the last unit → exactly one CONFIRMED
// ---------------------------------------------------------------------------

describe('KFK-10: concurrency — N parallel orders for the last unit', () => {
  const N = 10;
  const productId = objectId();

  function buildRaceScenario() {
    const models = makeModels();

    const product = {
      _id: new Types.ObjectId(productId),
      name: 'Last-Unit Widget',
      stock: { available: 1, reserved: 0 },
    };

    models.productModel.find.mockImplementation(() => chainable([product]));

    let availableStock = 1;
    models.productModel.updateOne.mockImplementation(async () => {
      if (availableStock >= 1) {
        availableStock -= 1;
        return { modifiedCount: 1 };
      }
      return { modifiedCount: 0 };
    });

    const handler = new OrderCreatedHandler(
      models.connection as any,
      models.productModel as any,
      models.reservationModel as any,
      models.processedEventModel as any,
      models.outboxModel as any,
      models.consumerService as any,
    );

    return { models, handler, getAvailableStock: () => availableStock };
  }

  it('exactly one handler writes stock-reserved; N−1 throw on the $gte guard', async () => {
    const { handler } = buildRaceScenario();

    const events = Array.from({ length: N }, () => orderCreatedEvent(uuid(), productId));

    const results = await Promise.allSettled(events.map((e) => handler.handle(e)));

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);

    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason.message).toMatch(
        /Conditional stock update failed/,
      );
    }
  });

  it('produces exactly one stock-reserved outbox event', async () => {
    const { models, handler } = buildRaceScenario();

    const events = Array.from({ length: N }, () => orderCreatedEvent(uuid(), productId));

    await Promise.allSettled(events.map((e) => handler.handle(e)));

    const outboxCalls = models.outboxModel.create.mock.calls;
    const reserved = outboxCalls.filter(
      (c: any) => c[0][0]?.eventType === TOPICS.ORDER_STOCK_RESERVED,
    );
    expect(reserved).toHaveLength(1);

    const failedOutbox = outboxCalls.filter(
      (c: any) => c[0][0]?.eventType === TOPICS.ORDER_STOCK_RESERVATION_FAILED,
    );
    expect(failedOutbox).toHaveLength(0);
  });

  it('creates exactly one ACTIVE reservation', async () => {
    const { models, handler } = buildRaceScenario();

    const events = Array.from({ length: N }, () => orderCreatedEvent(uuid(), productId));

    await Promise.allSettled(events.map((e) => handler.handle(e)));

    expect(models.reservationModel.create).toHaveBeenCalledTimes(1);
    expect(models.reservationModel.create).toHaveBeenCalledWith(
      [expect.objectContaining({ status: 'ACTIVE' })],
      expect.anything(),
    );
  });

  it('never drives available stock below zero', async () => {
    const { handler, getAvailableStock } = buildRaceScenario();

    const events = Array.from({ length: N }, () => orderCreatedEvent(uuid(), productId));

    await Promise.allSettled(events.map((e) => handler.handle(e)));

    expect(getAvailableStock()).toBe(0);
  });

  it('a retried loser writes stock-reservation-failed when stock is depleted', async () => {
    const models = makeModels();
    const product = {
      _id: new Types.ObjectId(productId),
      name: 'Last-Unit Widget',
      stock: { available: 0, reserved: 1 },
    };

    models.productModel.find.mockImplementation(() => chainable([product]));

    const handler = new OrderCreatedHandler(
      models.connection as any,
      models.productModel as any,
      models.reservationModel as any,
      models.processedEventModel as any,
      models.outboxModel as any,
      models.consumerService as any,
    );

    const event = orderCreatedEvent(uuid(), productId);

    await handler.handle(event);

    const outboxCalls = models.outboxModel.create.mock.calls;
    const failed = outboxCalls.filter(
      (c: any) => c[0][0]?.eventType === TOPICS.ORDER_STOCK_RESERVATION_FAILED,
    );
    expect(failed).toHaveLength(1);

    expect(models.productModel.updateOne).not.toHaveBeenCalled();
    expect(models.reservationModel.create).not.toHaveBeenCalled();
  });
});
