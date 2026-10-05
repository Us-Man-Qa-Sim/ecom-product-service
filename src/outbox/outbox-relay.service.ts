import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Env } from '../config/env.validation';
import { Outbox, type OutboxDocument } from '../schemas/outbox.schema';
import { PUBLISHER, Publisher } from '../kafka/publisher';

// KFK-3: outbox relay (Mongo version).
//
// Mongo has no row-level advisory locks (`SELECT … FOR UPDATE SKIP LOCKED`),
// so we use a claim-and-release pattern with `findOneAndUpdate`:
//
//   1. `findOneAndUpdate({ sentAt: null }, { $set: { sentAt: <claimTimestamp> } })`
//      atomically claims one unsent row — the returned doc is ours exclusively
//      because no other relay will see `sentAt: null` for it.
//   2. Publish the envelope to Kafka.
//   3. On success the row stays stamped (done). On failure, unset `sentAt` back
//      to `null` so the row is retried on the next tick.
//
// Compared to the Postgres relay (USR-8 / ORD-8):
// - No transaction wrapping the batch: each row is claimed, published and either
//   kept or released independently. A Kafka outage mid-batch loses no work —
//   already-published rows stay stamped, the failed row is released.
// - Concurrent relay instances are safe: `findOneAndUpdate` is atomic and the
//   `sentAt: null` filter acts as a natural SKIP LOCKED — two instances will
//   never claim the same row.
// - The cost is one extra write when publish fails (the release). That is rare
//   and cheap compared to the safety it buys.
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly errorBackoffMs: number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    config: ConfigService<Env, true>,
    @InjectModel(Outbox.name) private readonly outboxModel: Model<OutboxDocument>,
    @Inject(PUBLISHER) private readonly publisher: Publisher,
  ) {
    this.enabled = config.get('OUTBOX_RELAY_ENABLED', { infer: true });
    this.pollIntervalMs = config.get('OUTBOX_RELAY_POLL_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('OUTBOX_RELAY_BATCH_SIZE', { infer: true });
    this.errorBackoffMs = config.get('OUTBOX_RELAY_ERROR_BACKOFF_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Outbox relay disabled (OUTBOX_RELAY_ENABLED=false)');
      return;
    }
    this.logger.log(
      `Outbox relay started (batch=${this.batchSize}, poll=${this.pollIntervalMs}ms)`,
    );
    this.scheduleNextTick(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const start = Date.now();
    while (this.running && Date.now() - start < 10_000) {
      await sleep(50);
    }
    if (this.running) {
      this.logger.warn('Shutdown timed out with a relay tick still in flight');
    }
  }

  async drainOnce(): Promise<number> {
    let processed = 0;

    for (let i = 0; i < this.batchSize; i++) {
      const claimTimestamp = new Date();

      const doc = await this.outboxModel.findOneAndUpdate(
        { sentAt: null },
        { $set: { sentAt: claimTimestamp } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      );

      if (!doc) break;

      try {
        const envelope = doc.payload as Record<string, unknown>;
        const correlationId =
          typeof envelope.correlationId === 'string'
            ? envelope.correlationId
            : undefined;

        await this.publisher.publish({
          topic: doc.eventType,
          key: doc.aggregateId,
          value: JSON.stringify(doc.payload),
          headers: correlationId
            ? { 'x-correlation-id': correlationId }
            : undefined,
        });
        processed++;
      } catch (err) {
        await this.outboxModel.updateOne({ _id: doc._id }, { $set: { sentAt: null } });
        throw err;
      }
    }

    return processed;
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.running = true;
    try {
      const processed = await this.drainOnce();
      const nextDelay = processed === this.batchSize ? 0 : this.pollIntervalMs;
      this.scheduleNextTick(nextDelay);
    } catch (err) {
      this.logger.error({ err }, 'Outbox relay tick failed');
      this.scheduleNextTick(this.errorBackoffMs);
    } finally {
      this.running = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
