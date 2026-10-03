import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProcessedEventDocument = HydratedDocument<ProcessedEvent>;

/**
 * Transactional inbox (SCHEMAS.md §3). Before a Kafka event is processed, its
 * `eventId` is inserted here inside the same Mongo transaction; the unique index
 * rejects duplicates, so redelivery of an already-handled event is a no-op
 * (KFK-2 / KFK-11). No `timestamps` — `processedAt` is the only time we need.
 */
@Schema({ collection: 'processed_events' })
export class ProcessedEvent {
  @Prop({ required: true, unique: true })
  eventId!: string; // from the Kafka envelope; unique index = idempotency guard

  @Prop({ required: true })
  eventType!: string;

  @Prop({ default: () => new Date() })
  processedAt!: Date;
}

export const ProcessedEventSchema = SchemaFactory.createForClass(ProcessedEvent);
