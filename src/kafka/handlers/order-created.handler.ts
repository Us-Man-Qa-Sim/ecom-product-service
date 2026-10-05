import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  EVENT_PAYLOAD_SCHEMAS,
  TOPICS,
  type EventPayloadMap,
  type TopicName,
  type TypedEventEnvelope,
} from '@us-man-qa-sim/ecom-contracts/events';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { Outbox, type OutboxDocument } from '../../schemas/outbox.schema';
import { ProcessedEvent, type ProcessedEventDocument } from '../../schemas/processed-event.schema';
import { Product, type ProductDocument } from '../../schemas/product.schema';
import {
  StockReservation,
  type StockReservationDocument,
} from '../../schemas/stock-reservation.schema';
import type { TopicHandler } from '../consumer';
import { KafkaConsumerService } from '../kafka-consumer.service';

@Injectable()
export class OrderCreatedHandler implements TopicHandler<'order.created'>, OnModuleInit {
  private readonly logger = new Logger(OrderCreatedHandler.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(StockReservation.name)
    private readonly reservationModel: Model<StockReservationDocument>,
    @InjectModel(ProcessedEvent.name)
    private readonly processedEventModel: Model<ProcessedEventDocument>,
    @InjectModel(Outbox.name) private readonly outboxModel: Model<OutboxDocument>,
    private readonly consumerService: KafkaConsumerService,
  ) {}

  onModuleInit(): void {
    this.consumerService.subscribe(TOPICS.ORDER_CREATED, this);
  }

  async handle(event: TypedEventEnvelope<'order.created'>): Promise<void> {
    const { eventId, correlationId, payload } = event;
    const { orderId, items } = payload;

    try {
      await this.connection.transaction(async (session) => {
        // 1. Inbox: duplicate eventId → unique-index error → caught below
        await this.processedEventModel.create([{ eventId, eventType: TOPICS.ORDER_CREATED }], {
          session,
        });

        // 2. KFK-7: a terminal event (cancel/ship) may have arrived first and
        //    planted a tombstone reservation. If one exists, skip — the order is
        //    already in a terminal state on the order-service side.
        const existing = await this.reservationModel
          .findOne({ orderId })
          .session(session)
          .exec();

        if (existing) {
          this.logger.warn(
            { orderId, status: existing.status },
            'Late order.created: reservation already exists, skipping',
          );
          return;
        }

        // 3. Load every referenced product in one round-trip
        const productIds = items.map((i) => new Types.ObjectId(i.productId));
        const products = await this.productModel
          .find({ _id: { $in: productIds } })
          .session(session)
          .exec();

        const productMap = new Map(products.map((p) => [p._id.toString(), p]));

        // 4. Check availability (all-or-nothing)
        const failures: string[] = [];
        for (const item of items) {
          const product = productMap.get(item.productId);
          if (!product) {
            failures.push(`product ${item.productId} not found`);
          } else if (product.stock.available < item.quantity) {
            failures.push(
              `${product.name}: requested ${item.quantity}, available ${product.stock.available}`,
            );
          }
        }

        if (failures.length > 0) {
          const reason = failures.join('; ');
          await this.writeOutbox(session, orderId, correlationId, {
            topic: TOPICS.ORDER_STOCK_RESERVATION_FAILED,
            payload: { orderId, reason },
          });
          this.logger.warn({ orderId, reason }, 'Stock reservation failed');
          return;
        }

        // 5. Reserve stock — conditional $gte guard as a safety net on top of
        //    the read-check above (snapshot isolation prevents races, but belt
        //    and suspenders never hurts inside a transaction).
        for (const item of items) {
          const result = await this.productModel.updateOne(
            {
              _id: new Types.ObjectId(item.productId),
              'stock.available': { $gte: item.quantity },
            },
            {
              $inc: {
                'stock.available': -item.quantity,
                'stock.reserved': item.quantity,
              },
            },
            { session },
          );

          if (result.modifiedCount !== 1) {
            throw new Error(
              `Conditional stock update failed for product ${item.productId} ` +
                `(passed read-check but $gte guard rejected the write)`,
            );
          }
        }

        // 6. Reservation record
        await this.reservationModel.create(
          [
            {
              orderId,
              items: items.map((i) => ({
                productId: new Types.ObjectId(i.productId),
                quantity: i.quantity,
              })),
              status: 'ACTIVE' as const,
            },
          ],
          { session },
        );

        // 7. Outbox: stock-reserved
        await this.writeOutbox(session, orderId, correlationId, {
          topic: TOPICS.ORDER_STOCK_RESERVED,
          payload: { orderId },
        });

        this.logger.log({ orderId }, 'Stock reserved');
      });
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        this.logger.log({ eventId }, 'Duplicate event, skipping');
        return;
      }
      throw err;
    }
  }

  private async writeOutbox<T extends TopicName>(
    session: ClientSession,
    orderId: string,
    correlationId: string,
    event: { topic: T; payload: EventPayloadMap[T] },
  ): Promise<void> {
    const validatedPayload = EVENT_PAYLOAD_SCHEMAS[event.topic].parse(event.payload);

    const envelope = {
      eventId: randomUUID(),
      eventType: event.topic,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId,
      payload: validatedPayload,
    };

    await this.outboxModel.create(
      [
        {
          aggregateType: 'StockReservation',
          aggregateId: orderId,
          eventType: event.topic,
          payload: envelope,
        },
      ],
      { session },
    );
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: number }).code === 11000
  );
}
