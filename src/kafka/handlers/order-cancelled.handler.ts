import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { TOPICS, type TypedEventEnvelope } from '@us-man-qa-sim/ecom-contracts/events';
import { Connection, Model, Types } from 'mongoose';
import { ProcessedEvent, type ProcessedEventDocument } from '../../schemas/processed-event.schema';
import { Product, type ProductDocument } from '../../schemas/product.schema';
import {
  StockReservation,
  type StockReservationDocument,
} from '../../schemas/stock-reservation.schema';
import type { TopicHandler } from '../consumer';
import { KafkaConsumerService } from '../kafka-consumer.service';

@Injectable()
export class OrderCancelledHandler implements TopicHandler<'order.cancelled'>, OnModuleInit {
  private readonly logger = new Logger(OrderCancelledHandler.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(StockReservation.name)
    private readonly reservationModel: Model<StockReservationDocument>,
    @InjectModel(ProcessedEvent.name)
    private readonly processedEventModel: Model<ProcessedEventDocument>,
    private readonly consumerService: KafkaConsumerService,
  ) {}

  onModuleInit(): void {
    this.consumerService.subscribe(TOPICS.ORDER_CANCELLED, this);
  }

  async handle(event: TypedEventEnvelope<'order.cancelled'>): Promise<void> {
    const { eventId, payload } = event;
    const { orderId } = payload;

    try {
      await this.connection.transaction(async (session) => {
        await this.processedEventModel.create(
          [{ eventId, eventType: TOPICS.ORDER_CANCELLED }],
          { session },
        );

        const reservation = await this.reservationModel
          .findOne({ orderId, status: 'ACTIVE' })
          .session(session)
          .exec();

        if (!reservation) {
          this.logger.log({ orderId }, 'No active reservation found, nothing to release');
          return;
        }

        for (const item of reservation.items) {
          const result = await this.productModel.updateOne(
            {
              _id: new Types.ObjectId(item.productId),
              'stock.reserved': { $gte: item.quantity },
            },
            {
              $inc: {
                'stock.available': item.quantity,
                'stock.reserved': -item.quantity,
              },
            },
            { session },
          );

          if (result.modifiedCount !== 1) {
            throw new Error(
              `Failed to release stock for product ${item.productId.toString()} ` +
                `(expected reserved >= ${item.quantity})`,
            );
          }
        }

        await this.reservationModel.updateOne(
          { _id: reservation._id },
          { $set: { status: 'RELEASED' } },
          { session },
        );

        this.logger.log({ orderId }, 'Reserved stock released');
      });
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        this.logger.log({ eventId }, 'Duplicate event, skipping');
        return;
      }
      throw err;
    }
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
