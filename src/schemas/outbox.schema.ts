import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes } from 'mongoose';

export type OutboxDocument = HydratedDocument<Outbox>;

/**
 * Transactional outbox (SCHEMAS.md §3). The reserve/release/consume handlers
 * write the event to emit into this collection in the same transaction as the
 * domain change; the Mongo outbox relay (KFK-3) later claims unsent rows with
 * `findOneAndUpdate({ sentAt: null }, …)`, publishes to Kafka, and stamps
 * `sentAt`. `createdAt`/`sentAt` are declared explicitly (no `timestamps`)
 * because the relay queries and orders on them directly.
 */
@Schema({ collection: 'outbox' })
export class Outbox {
  @Prop({ required: true })
  aggregateType!: string; // "Product", "StockReservation"

  @Prop({ required: true })
  aggregateId!: string;

  @Prop({ required: true })
  eventType!: string; // e.g. "order.stock-reserved"

  @Prop({ type: SchemaTypes.Mixed, required: true })
  payload!: Record<string, unknown>;

  @Prop({ default: () => new Date() })
  createdAt!: Date;

  @Prop({ type: Date, default: null })
  sentAt!: Date | null; // null until the relay publishes to Kafka
}

export const OutboxSchema = SchemaFactory.createForClass(Outbox);

// Relay poll index (SCHEMAS.md §3). The Mongo relay (KFK-3) claims unsent rows
// with `findOneAndUpdate({ sentAt: null }, …)`; indexing `sentAt` keeps that
// scan cheap once most rows are sent. Built explicitly via `syncIndexes()`
// (PRD-3) because `autoIndex` is off in production.
OutboxSchema.index({ sentAt: 1 });
