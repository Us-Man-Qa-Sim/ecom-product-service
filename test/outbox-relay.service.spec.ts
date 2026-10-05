import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import type { OutboxDocument } from '../src/schemas/outbox.schema';
import { OutboxRelayService } from '../src/outbox/outbox-relay.service';
import type { Publisher } from '../src/kafka/publisher';

interface OutboxRow {
  _id: Types.ObjectId;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  sentAt: Date | null;
  claimedUntil: Date | null;
}

function envelope(aggregateId: string, type: string): OutboxRow {
  return {
    _id: new Types.ObjectId(),
    aggregateType: 'StockReservation',
    aggregateId,
    eventType: type,
    payload: {
      eventId: randomUUID(),
      eventType: type,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      payload: { orderId: aggregateId },
    },
    createdAt: new Date(),
    sentAt: null,
    claimedUntil: null,
  };
}

type ClaimFilter = {
  sentAt: null;
  $or: [{ claimedUntil: null }, { claimedUntil: { $lte: Date } }];
};

function makeOutboxModel(initial: OutboxRow[]) {
  const rows = [...initial];

  const claimable = (r: OutboxRow, now: Date) =>
    r.sentAt === null && (r.claimedUntil === null || r.claimedUntil <= now);

  const findOneAndUpdate = jest.fn(
    async (
      filter: ClaimFilter,
      update: { $set: { claimedUntil: Date } },
      _options: { sort: { createdAt: number }; returnDocument: string },
    ) => {
      const now = filter.$or[1].claimedUntil.$lte;
      const idx = rows.findIndex((r) => claimable(r, now));
      if (idx === -1) return null;
      rows[idx] = { ...rows[idx], claimedUntil: update.$set.claimedUntil };
      return rows[idx];
    },
  );

  const updateOne = jest.fn(
    async (filter: { _id: Types.ObjectId }, update: { $set: Partial<OutboxRow> }) => {
      const idx = rows.findIndex((r) => r._id.equals(filter._id));
      if (idx !== -1) {
        rows[idx] = { ...rows[idx], ...update.$set };
      }
      return { modifiedCount: idx !== -1 ? 1 : 0 };
    },
  );

  return {
    model: { findOneAndUpdate, updateOne } as unknown,
    findOneAndUpdate,
    updateOne,
    rows: () => rows,
    unsent: () => rows.filter((r) => r.sentAt === null),
    sent: () => rows.filter((r) => r.sentAt !== null),
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    OUTBOX_RELAY_ENABLED: true,
    OUTBOX_RELAY_POLL_INTERVAL_MS: 250,
    OUTBOX_RELAY_BATCH_SIZE: 32,
    OUTBOX_RELAY_ERROR_BACKOFF_MS: 5000,
    OUTBOX_RELAY_CLAIM_TTL_MS: 60_000,
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function makePublisher(): { publisher: Publisher; publish: jest.Mock } {
  const publish = jest.fn(async () => undefined);
  return { publisher: { publish }, publish };
}

function makeRelay(
  model: unknown,
  publisher: Publisher,
  overrides: Record<string, unknown> = {},
): OutboxRelayService {
  return new OutboxRelayService(
    makeConfig(overrides),
    model as unknown as Model<OutboxDocument>,
    publisher,
  );
}

describe('OutboxRelayService.drainOnce', () => {
  it('publishes every unsent row and leaves them stamped', async () => {
    const rows = [
      envelope('order-1', 'order.stock-reserved'),
      envelope('order-2', 'order.stock-reservation-failed'),
    ];
    const { model, findOneAndUpdate, sent } = makeOutboxModel(rows);
    const { publisher, publish } = makePublisher();
    const relay = makeRelay(model, publisher);

    const processed = await relay.drainOnce();

    expect(processed).toBe(2);
    expect(sent()).toHaveLength(2);
    expect(sent().every((r) => r.claimedUntil === null)).toBe(true);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(3); // 2 claims + 1 null return
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][0]).toMatchObject({
      topic: 'order.stock-reserved',
      key: 'order-1',
    });
    expect(JSON.parse(publish.mock.calls[0][0].value)).toMatchObject({
      eventType: 'order.stock-reserved',
    });
    expect(publish.mock.calls[1][0]).toMatchObject({
      topic: 'order.stock-reservation-failed',
      key: 'order-2',
    });
  });

  it('returns 0 and never touches the publisher when the queue is empty', async () => {
    const { model } = makeOutboxModel([]);
    const { publisher, publish } = makePublisher();
    const relay = makeRelay(model, publisher);

    const processed = await relay.drainOnce();

    expect(processed).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('releases the claimed row and propagates when publish fails', async () => {
    const rows = [envelope('order-9', 'order.stock-reserved')];
    const { model, updateOne, unsent } = makeOutboxModel(rows);
    const publish = jest.fn(async () => {
      throw new Error('kafka down');
    });
    const relay = makeRelay(model, { publish } as unknown as Publisher);

    await expect(relay.drainOnce()).rejects.toThrow('kafka down');
    expect(updateOne).toHaveBeenCalledWith({ _id: rows[0]._id }, { $set: { claimedUntil: null } });
    expect(unsent()).toHaveLength(1);
    expect(unsent()[0].claimedUntil).toBeNull();
  });

  it('never stamps sentAt before the publish succeeds', async () => {
    const rows = [envelope('order-p', 'order.stock-reserved')];
    const { model, rows: current } = makeOutboxModel(rows);
    let sentAtDuringPublish: Date | null | undefined;
    const publish = jest.fn(async () => {
      sentAtDuringPublish = current()[0].sentAt;
    });
    const relay = makeRelay(model, { publish } as unknown as Publisher);

    await relay.drainOnce();

    expect(sentAtDuringPublish).toBeNull();
    expect(current()[0].sentAt).toBeInstanceOf(Date);
  });

  it('re-claims a row whose lease expired (relay crashed mid-publish)', async () => {
    const crashed = {
      ...envelope('order-z', 'order.stock-reserved'),
      claimedUntil: new Date(Date.now() - 1_000),
    };
    const { model, sent } = makeOutboxModel([crashed]);
    const { publisher, publish } = makePublisher();
    const relay = makeRelay(model, publisher);

    expect(await relay.drainOnce()).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(sent()).toHaveLength(1);
  });

  it('skips a row whose lease is still held by another relay', async () => {
    const held = {
      ...envelope('order-h', 'order.stock-reserved'),
      claimedUntil: new Date(Date.now() + 30_000),
    };
    const { model } = makeOutboxModel([held]);
    const { publisher, publish } = makePublisher();
    const relay = makeRelay(model, publisher);

    expect(await relay.drainOnce()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('stops after batchSize rows even when more are available', async () => {
    const rows = [
      envelope('order-a', 'order.stock-reserved'),
      envelope('order-b', 'order.stock-reserved'),
      envelope('order-c', 'order.stock-reserved'),
    ];
    const { model, findOneAndUpdate } = makeOutboxModel(rows);
    const { publisher, publish } = makePublisher();
    const relay = makeRelay(model, publisher, { OUTBOX_RELAY_BATCH_SIZE: 2 });

    const processed = await relay.drainOnce();

    expect(processed).toBe(2);
    expect(publish).toHaveBeenCalledTimes(2);
    // Only 2 claims, no extra null-terminator call since batch limit hit first
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('claims unsent, unleased rows in createdAt order with a TTL lease', async () => {
    const { model, findOneAndUpdate } = makeOutboxModel([
      envelope('order-x', 'order.stock-reserved'),
    ]);
    const { publisher } = makePublisher();
    const relay = makeRelay(model, publisher);

    await relay.drainOnce();

    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      sentAt: null,
      $or: [{ claimedUntil: null }, { claimedUntil: { $lte: expect.any(Date) } }],
    });
    const now = filter.$or[1].claimedUntil.$lte.getTime();
    expect(update.$set.claimedUntil.getTime() - now).toBe(60_000);
    expect(findOneAndUpdate.mock.calls[0][2]).toMatchObject({
      sort: { createdAt: 1 },
      returnDocument: 'after',
    });
  });
});

describe('OutboxRelayService lifecycle', () => {
  it('does not schedule ticks when disabled', () => {
    const { model } = makeOutboxModel([]);
    const { publisher } = makePublisher();
    const relay = makeRelay(model, publisher, { OUTBOX_RELAY_ENABLED: false });
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    relay.onApplicationBootstrap();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('stops scheduling further ticks after shutdown', async () => {
    const { model } = makeOutboxModel([]);
    const { publisher } = makePublisher();
    const relay = makeRelay(model, publisher);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    relay.onApplicationBootstrap();
    await relay.onModuleDestroy();
    setTimeoutSpy.mockClear();

    relay.onApplicationBootstrap();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
