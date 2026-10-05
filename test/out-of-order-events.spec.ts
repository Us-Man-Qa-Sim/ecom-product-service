import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { TOPICS } from '@us-man-qa-sim/ecom-contracts/events';
import { OrderCreatedHandler } from '../src/kafka/handlers/order-created.handler';
import { OrderCancelledHandler } from '../src/kafka/handlers/order-cancelled.handler';
import { OrderShippedHandler } from '../src/kafka/handlers/order-shipped.handler';

const uuid = () => randomUUID();
const objectId = () => new Types.ObjectId().toString();

// ---------------------------------------------------------------------------
// Helpers — thin Mongoose query/model stubs
// ---------------------------------------------------------------------------

function chainable(result: unknown) {
  const obj: Record<string, unknown> = {};
  obj.session = jest.fn().mockReturnValue(obj);
  obj.exec = jest.fn().mockResolvedValue(result);
  return obj;
}

function makeModels() {
  const processedEventModel = { create: jest.fn() };

  const reservationModel = {
    findOne: jest.fn().mockReturnValue(chainable(null)),
    create: jest.fn(),
    updateOne: jest.fn(),
  };

  const productModel = {
    find: jest.fn().mockReturnValue(chainable([])),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };

  const outboxModel = { create: jest.fn() };

  const connection = {
    transaction: jest.fn(async (fn: (session: unknown) => Promise<void>) => fn({})),
  };

  const consumerService = { subscribe: jest.fn() };

  return { processedEventModel, reservationModel, productModel, outboxModel, connection, consumerService };
}

// ---------------------------------------------------------------------------
// Event factories
// ---------------------------------------------------------------------------

function orderCreatedEvent(orderId = uuid(), productId = objectId()) {
  return {
    eventId: uuid(),
    eventType: TOPICS.ORDER_CREATED as const,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: uuid(),
    payload: { orderId, items: [{ productId, quantity: 2 }] },
  };
}

function orderCancelledEvent(orderId = uuid()) {
  return {
    eventId: uuid(),
    eventType: TOPICS.ORDER_CANCELLED as const,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: uuid(),
    payload: { orderId, userId: uuid() },
  };
}

function orderShippedEvent(orderId = uuid()) {
  return {
    eventId: uuid(),
    eventType: TOPICS.ORDER_SHIPPED as const,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: uuid(),
    payload: { orderId, userId: uuid() },
  };
}

// ---------------------------------------------------------------------------
// KFK-7: Out-of-order / late event handling
// ---------------------------------------------------------------------------

describe('KFK-7: out-of-order event handling', () => {
  describe('OrderCancelledHandler — cancel arrives before order.created', () => {
    it('creates a RELEASED tombstone when no reservation exists', async () => {
      const models = makeModels();
      const handler = new OrderCancelledHandler(
        models.connection as any,
        models.productModel as any,
        models.reservationModel as any,
        models.processedEventModel as any,
        models.consumerService as any,
      );

      const orderId = uuid();
      const event = orderCancelledEvent(orderId);

      // findOne({ orderId }) → null (no reservation)
      models.reservationModel.findOne.mockReturnValue(chainable(null));

      await handler.handle(event);

      expect(models.reservationModel.create).toHaveBeenCalledWith(
        [{ orderId, items: [], status: 'RELEASED' }],
        { session: expect.anything() },
      );
    });

    it('does not touch product stock when creating a tombstone', async () => {
      const models = makeModels();
      const handler = new OrderCancelledHandler(
        models.connection as any,
        models.productModel as any,
        models.reservationModel as any,
        models.processedEventModel as any,
        models.consumerService as any,
      );

      models.reservationModel.findOne.mockReturnValue(chainable(null));

      await handler.handle(orderCancelledEvent());

      expect(models.productModel.updateOne).not.toHaveBeenCalled();
    });

    it('is a no-op when reservation is already in terminal state (RELEASED)', async () => {
      const models = makeModels();
      const handler = new OrderCancelledHandler(
        models.connection as any,
        models.productModel as any,
        models.reservationModel as any,
        models.processedEventModel as any,
        models.consumerService as any,
      );

      const orderId = uuid();
      models.reservationModel.findOne.mockReturnValue(
        chainable({ orderId, status: 'RELEASED', items: [] }),
      );

      await handler.handle(orderCancelledEvent(orderId));

      expect(models.reservationModel.create).not.toHaveBeenCalled();
      expect(models.productModel.updateOne).not.toHaveBeenCalled();
    });

    it('still releases stock normally for an ACTIVE reservation', async () => {
      const models = makeModels();
      const handler = new OrderCancelledHandler(
        models.connection as any,
        models.productModel as any,
        models.reservationModel as any,
        models.processedEventModel as any,
        models.consumerService as any,
      );

      const orderId = uuid();
      const productId = new Types.ObjectId();
      const reservation = {
        _id: new Types.ObjectId(),
        orderId,
        status: 'ACTIVE',
        items: [{ productId, quantity: 3 }],
      };

      models.reservationModel.findOne.mockReturnValue(chainable(reservation));
      models.productModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await handler.handle(orderCancelledEvent(orderId));

      expect(models.productModel.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ 'stock.reserved': { $gte: 3 } }),
        expect.objectContaining({ $inc: { 'stock.available': 3, 'stock.reserved': -3 } }),
        expect.anything(),
      );
      expect(models.reservationModel.updateOne).toHaveBeenCalledWith(
        { _id: reservation._id },
        { $set: { status: 'RELEASED' } },
        expect.anything(),
      );
    });
  });

  describe('OrderCreatedHandler — order.created arrives after cancel tombstone', () => {
    it('skips reservation when a RELEASED tombstone exists', async () => {
      const models = makeModels();
      const handler = new OrderCreatedHandler(
        models.connection as any,
        models.productModel as any,
        models.reservationModel as any,
        models.processedEventModel as any,
        models.outboxModel as any,
        models.consumerService as any,
      );

      const orderId = uuid();
      const event = orderCreatedEvent(orderId);

      // findOne({ orderId }) → tombstone
      models.reservationModel.findOne.mockReturnValue(
        chainable({ orderId, status: 'RELEASED', items: [] }),
      );

      await handler.handle(event);

      // No stock changes, no reservation created, no outbox event
      expect(models.productModel.find).not.toHaveBeenCalled();
      expect(models.productModel.updateOne).not.toHaveBeenCalled();
      expect(models.reservationModel.create).not.toHaveBeenCalled();
      expect(models.outboxModel.create).not.toHaveBeenCalled();
    });

    it('skips reservation when a CONSUMED tombstone exists', async () => {
      const models = makeModels();
      const handler = new OrderCreatedHandler(
        models.connection as any,
        models.productModel as any,
        models.reservationModel as any,
        models.processedEventModel as any,
        models.outboxModel as any,
        models.consumerService as any,
      );

      const orderId = uuid();
      const event = orderCreatedEvent(orderId);

      models.reservationModel.findOne.mockReturnValue(
        chainable({ orderId, status: 'CONSUMED', items: [] }),
      );

      await handler.handle(event);

      expect(models.productModel.find).not.toHaveBeenCalled();
      expect(models.outboxModel.create).not.toHaveBeenCalled();
    });

    it('still records the event in the inbox even when skipping', async () => {
      const models = makeModels();
      const handler = new OrderCreatedHandler(
        models.connection as any,
        models.productModel as any,
        models.reservationModel as any,
        models.processedEventModel as any,
        models.outboxModel as any,
        models.consumerService as any,
      );

      const event = orderCreatedEvent();

      models.reservationModel.findOne.mockReturnValue(
        chainable({ orderId: event.payload.orderId, status: 'RELEASED', items: [] }),
      );

      await handler.handle(event);

      expect(models.processedEventModel.create).toHaveBeenCalledWith(
        [{ eventId: event.eventId, eventType: TOPICS.ORDER_CREATED }],
        { session: expect.anything() },
      );
    });

    it('proceeds normally when no tombstone exists', async () => {
      const models = makeModels();
      const handler = new OrderCreatedHandler(
        models.connection as any,
        models.productModel as any,
        models.reservationModel as any,
        models.processedEventModel as any,
        models.outboxModel as any,
        models.consumerService as any,
      );

      const productId = objectId();
      const event = orderCreatedEvent(uuid(), productId);

      // No existing reservation
      models.reservationModel.findOne.mockReturnValue(chainable(null));

      // Product with enough stock
      const product = {
        _id: new Types.ObjectId(productId),
        name: 'Widget',
        stock: { available: 10, reserved: 0 },
      };
      models.productModel.find.mockReturnValue(chainable([product]));
      models.productModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await handler.handle(event);

      expect(models.productModel.updateOne).toHaveBeenCalled();
      expect(models.reservationModel.create).toHaveBeenCalled();
      expect(models.outboxModel.create).toHaveBeenCalled();
    });
  });

  describe('OrderShippedHandler — shipped arrives before order.created', () => {
    it('creates a CONSUMED tombstone when no reservation exists', async () => {
      const models = makeModels();
      const handler = new OrderShippedHandler(
        models.connection as any,
        models.productModel as any,
        models.reservationModel as any,
        models.processedEventModel as any,
        models.consumerService as any,
      );

      const orderId = uuid();
      models.reservationModel.findOne.mockReturnValue(chainable(null));

      await handler.handle(orderShippedEvent(orderId));

      expect(models.reservationModel.create).toHaveBeenCalledWith(
        [{ orderId, items: [], status: 'CONSUMED' }],
        { session: expect.anything() },
      );
    });

    it('is a no-op when reservation is already RELEASED', async () => {
      const models = makeModels();
      const handler = new OrderShippedHandler(
        models.connection as any,
        models.productModel as any,
        models.reservationModel as any,
        models.processedEventModel as any,
        models.consumerService as any,
      );

      const orderId = uuid();
      models.reservationModel.findOne.mockReturnValue(
        chainable({ orderId, status: 'RELEASED', items: [] }),
      );

      await handler.handle(orderShippedEvent(orderId));

      expect(models.reservationModel.create).not.toHaveBeenCalled();
      expect(models.productModel.updateOne).not.toHaveBeenCalled();
    });

    it('still consumes stock normally for an ACTIVE reservation', async () => {
      const models = makeModels();
      const handler = new OrderShippedHandler(
        models.connection as any,
        models.productModel as any,
        models.reservationModel as any,
        models.processedEventModel as any,
        models.consumerService as any,
      );

      const orderId = uuid();
      const productId = new Types.ObjectId();
      const reservation = {
        _id: new Types.ObjectId(),
        orderId,
        status: 'ACTIVE',
        items: [{ productId, quantity: 5 }],
      };

      models.reservationModel.findOne.mockReturnValue(chainable(reservation));
      models.productModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await handler.handle(orderShippedEvent(orderId));

      expect(models.productModel.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ 'stock.reserved': { $gte: 5 } }),
        expect.objectContaining({ $inc: { 'stock.reserved': -5 } }),
        expect.anything(),
      );
      expect(models.reservationModel.updateOne).toHaveBeenCalledWith(
        { _id: reservation._id },
        { $set: { status: 'CONSUMED' } },
        expect.anything(),
      );
    });
  });
});
