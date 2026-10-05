import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Env } from '../src/config/env.validation';
import { CorrelationService } from '../src/correlation/correlation.service';
import { KafkaConsumerService } from '../src/kafka/kafka-consumer.service';
import type { TopicHandler } from '../src/kafka/consumer';
import { TOPICS } from '@us-man-qa-sim/ecom-contracts/events';

const commitOffsets = jest.fn();
const consumerDisconnect = jest.fn();
const consumerSubscribe = jest.fn();
const consumerConnect = jest.fn();
let capturedEachMessage: ((payload: unknown) => Promise<void>) | undefined;
const consumerRun = jest.fn(async (config: { eachMessage: (p: unknown) => Promise<void> }) => {
  capturedEachMessage = config.eachMessage;
});

jest.mock('@confluentinc/kafka-javascript', () => ({
  KafkaJS: {
    Kafka: jest.fn().mockImplementation(() => ({
      consumer: jest.fn().mockReturnValue({
        connect: consumerConnect,
        subscribe: consumerSubscribe,
        run: consumerRun,
        commitOffsets,
        disconnect: consumerDisconnect,
      }),
    })),
  },
}));

// Manual commits (inbox + at-least-once) and earliest offset for a new group,
// so events produced before the first deploy of this service are not skipped.
function expectConsumerConfig(): void {
  const kafka = (KafkaJS.Kafka as unknown as jest.Mock).mock.results.at(-1)!.value as {
    consumer: jest.Mock;
  };
  expect(kafka.consumer).toHaveBeenCalledWith({
    kafkaJS: { groupId: 'product-service', autoCommit: false, fromBeginning: true },
  });
}

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_CLIENT_ID: 'product-service',
    KAFKA_CONSUMER_GROUP_ID: 'product-service',
    KAFKA_CONSUMER_MAX_RETRIES: 3,
    KAFKA_CONSUMER_RETRY_BASE_MS: 10,
    KAFKA_CONSUMER_RETRY_MAX_MS: 100,
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService<Env, true>;
}

function validEnvelope(topic: string) {
  const base = {
    eventId: randomUUID(),
    eventType: topic,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
  };
  if (topic === TOPICS.ORDER_CREATED) {
    return {
      ...base,
      payload: { orderId: randomUUID(), items: [{ productId: 'p1', quantity: 2 }] },
    };
  }
  if (topic === TOPICS.ORDER_CANCELLED) {
    return { ...base, payload: { orderId: randomUUID(), userId: randomUUID() } };
  }
  return { ...base, payload: { orderId: randomUUID(), userId: randomUUID() } };
}

function kafkaMessage(value: string | null, offset = '42') {
  return {
    topic: TOPICS.ORDER_CREATED,
    partition: 0,
    message: {
      key: Buffer.from('key'),
      value: value !== null ? Buffer.from(value) : null,
      timestamp: Date.now().toString(),
      attributes: 0,
      offset,
      headers: {},
    },
  };
}

describe('KafkaConsumerService', () => {
  let service: KafkaConsumerService;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedEachMessage = undefined;
    service = new KafkaConsumerService(makeConfig(), new CorrelationService());
  });

  describe('subscribe', () => {
    it('registers a handler for a topic', () => {
      const handler: TopicHandler = { handle: jest.fn() };
      expect(() => service.subscribe(TOPICS.ORDER_CREATED, handler)).not.toThrow();
    });

    it('throws if called after the consumer has started', async () => {
      const handler: TopicHandler = { handle: jest.fn() };
      service.subscribe(TOPICS.ORDER_CREATED, handler);
      await service.onApplicationBootstrap();

      expect(() => service.subscribe(TOPICS.ORDER_CANCELLED, handler)).toThrow(
        'Cannot subscribe after the consumer has started',
      );
    });
  });

  describe('onApplicationBootstrap', () => {
    it('skips consumer start when no handlers are registered', async () => {
      await service.onApplicationBootstrap();

      expect(consumerConnect).not.toHaveBeenCalled();
      expect(consumerRun).not.toHaveBeenCalled();
    });

    it('connects, subscribes to registered topics, and starts the consumer', async () => {
      service.subscribe(TOPICS.ORDER_CREATED, { handle: jest.fn() });
      service.subscribe(TOPICS.ORDER_CANCELLED, { handle: jest.fn() });

      await service.onApplicationBootstrap();

      expect(consumerConnect).toHaveBeenCalledTimes(1);
      expect(consumerSubscribe).toHaveBeenCalledWith({
        topics: [TOPICS.ORDER_CREATED, TOPICS.ORDER_CANCELLED],
      });
      expect(consumerRun).toHaveBeenCalledWith({
        eachMessage: expect.any(Function),
      });
      expectConsumerConfig();
    });
  });

  describe('message handling', () => {
    let handle: jest.Mock;

    beforeEach(async () => {
      handle = jest.fn();
      service.subscribe(TOPICS.ORDER_CREATED, { handle });
      await service.onApplicationBootstrap();
    });

    it('parses a valid envelope, calls the handler, and commits the offset', async () => {
      const envelope = validEnvelope(TOPICS.ORDER_CREATED);
      const msg = kafkaMessage(JSON.stringify(envelope));

      await capturedEachMessage!(msg);

      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: envelope.eventId,
          eventType: TOPICS.ORDER_CREATED,
          correlationId: envelope.correlationId,
        }),
      );
      expect(commitOffsets).toHaveBeenCalledWith([
        { topic: TOPICS.ORDER_CREATED, partition: 0, offset: '43' },
      ]);
    });

    it('skips and commits when message value is null', async () => {
      const msg = kafkaMessage(null);

      await capturedEachMessage!(msg);

      expect(handle).not.toHaveBeenCalled();
      expect(commitOffsets).toHaveBeenCalledWith([
        { topic: TOPICS.ORDER_CREATED, partition: 0, offset: '43' },
      ]);
    });

    it('skips and commits when message is not valid JSON', async () => {
      const msg = kafkaMessage('not json {{');

      await capturedEachMessage!(msg);

      expect(handle).not.toHaveBeenCalled();
      expect(commitOffsets).toHaveBeenCalledWith([
        { topic: TOPICS.ORDER_CREATED, partition: 0, offset: '43' },
      ]);
    });

    it('skips and commits when envelope validation fails', async () => {
      const msg = kafkaMessage(JSON.stringify({ not: 'an envelope' }));

      await capturedEachMessage!(msg);

      expect(handle).not.toHaveBeenCalled();
      expect(commitOffsets).toHaveBeenCalledWith([
        { topic: TOPICS.ORDER_CREATED, partition: 0, offset: '43' },
      ]);
    });

    it('skips and commits when eventType does not match topic', async () => {
      const envelope = validEnvelope(TOPICS.ORDER_CANCELLED);
      const msg = kafkaMessage(JSON.stringify(envelope));

      await capturedEachMessage!(msg);

      expect(handle).not.toHaveBeenCalled();
      expect(commitOffsets).toHaveBeenCalledWith([
        { topic: TOPICS.ORDER_CREATED, partition: 0, offset: '43' },
      ]);
    });
  });

  describe('retry with backoff', () => {
    let handle: jest.Mock;

    beforeEach(async () => {
      handle = jest.fn();
      service.subscribe(TOPICS.ORDER_CREATED, { handle });
      await service.onApplicationBootstrap();
    });

    it('retries and succeeds on second attempt', async () => {
      handle.mockRejectedValueOnce(new Error('transient failure')).mockResolvedValueOnce(undefined);

      const envelope = validEnvelope(TOPICS.ORDER_CREATED);
      const msg = kafkaMessage(JSON.stringify(envelope));

      await capturedEachMessage!(msg);

      expect(handle).toHaveBeenCalledTimes(2);
      expect(commitOffsets).toHaveBeenCalledTimes(1);
      expect(commitOffsets).toHaveBeenCalledWith([
        { topic: TOPICS.ORDER_CREATED, partition: 0, offset: '43' },
      ]);
    });

    it('retries and succeeds on the last attempt', async () => {
      handle
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValueOnce(undefined);

      const envelope = validEnvelope(TOPICS.ORDER_CREATED);
      const msg = kafkaMessage(JSON.stringify(envelope));

      await capturedEachMessage!(msg);

      expect(handle).toHaveBeenCalledTimes(3);
      expect(commitOffsets).toHaveBeenCalledTimes(1);
    });

    it('commits as poison message after exhausting all retries', async () => {
      handle.mockRejectedValue(new Error('persistent failure'));

      const envelope = validEnvelope(TOPICS.ORDER_CREATED);
      const msg = kafkaMessage(JSON.stringify(envelope));

      await capturedEachMessage!(msg);

      expect(handle).toHaveBeenCalledTimes(3);
      expect(commitOffsets).toHaveBeenCalledTimes(1);
      expect(commitOffsets).toHaveBeenCalledWith([
        { topic: TOPICS.ORDER_CREATED, partition: 0, offset: '43' },
      ]);
    });

    it('applies backoff delay between retries', async () => {
      handle.mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce(undefined);

      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      const envelope = validEnvelope(TOPICS.ORDER_CREATED);
      const msg = kafkaMessage(JSON.stringify(envelope));

      await capturedEachMessage!(msg);

      expect(sleepSpy).toHaveBeenCalledTimes(1);
      const delay = sleepSpy.mock.calls[0][0] as number;
      expect(delay).toBeGreaterThanOrEqual(10);
      expect(delay).toBeLessThanOrEqual(12);

      sleepSpy.mockRestore();
    });

    it('does not apply backoff delay on the final failed attempt', async () => {
      handle.mockRejectedValue(new Error('always fails'));

      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      const envelope = validEnvelope(TOPICS.ORDER_CREATED);
      const msg = kafkaMessage(JSON.stringify(envelope));

      await capturedEachMessage!(msg);

      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(handle).toHaveBeenCalledTimes(3);

      sleepSpy.mockRestore();
    });

    it('caps backoff delay at retryMaxMs', async () => {
      const svc = new KafkaConsumerService(
        makeConfig({ KAFKA_CONSUMER_RETRY_BASE_MS: 1000, KAFKA_CONSUMER_RETRY_MAX_MS: 50 }),
        new CorrelationService(),
      );
      const h = jest.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce(undefined);
      svc.subscribe(TOPICS.ORDER_CREATED, { handle: h });
      await svc.onApplicationBootstrap();

      const sleepSpy = jest.spyOn(svc as any, 'sleep').mockResolvedValue(undefined);
      const envelope = validEnvelope(TOPICS.ORDER_CREATED);
      const msg = kafkaMessage(JSON.stringify(envelope));

      await capturedEachMessage!(msg);

      const delay = sleepSpy.mock.calls[0][0] as number;
      expect(delay).toBeLessThanOrEqual(60);

      sleepSpy.mockRestore();
    });
  });

  describe('onApplicationShutdown', () => {
    it('disconnects the consumer', async () => {
      service.subscribe(TOPICS.ORDER_CREATED, { handle: jest.fn() });
      await service.onApplicationBootstrap();

      await service.onApplicationShutdown();

      expect(consumerDisconnect).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when the consumer was never started', async () => {
      await service.onApplicationShutdown();

      expect(consumerDisconnect).not.toHaveBeenCalled();
    });
  });
});
