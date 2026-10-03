import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type StockReservationDocument = HydratedDocument<StockReservation>;

export const RESERVATION_STATUSES = ['ACTIVE', 'RELEASED', 'CONSUMED'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * One line of a reservation: how many units of a product were held. `_id: false`
 * — these are value objects, not addressable documents.
 */
@Schema({ _id: false })
export class StockReservationItem {
  @Prop({ type: SchemaTypes.ObjectId, required: true })
  productId!: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 1 })
  quantity!: number;
}
export const StockReservationItemSchema = SchemaFactory.createForClass(StockReservationItem);

/**
 * Record of the stock a single order holds (SCHEMAS.md §3). Written in the same
 * Mongo transaction that reserves stock (KFK-2); read later to release
 * (`order.cancelled`, KFK-5) or consume (`order.shipped`, KFK-6) that stock.
 * `orderId` is unique so a duplicate-delivered `order.created` can never create
 * a second reservation; `status` drives the release/consume lifecycle.
 */
@Schema({ timestamps: true, collection: 'stock_reservations' })
export class StockReservation {
  @Prop({ required: true, unique: true, index: true })
  orderId!: string; // one reservation per order

  @Prop({ type: [StockReservationItemSchema], required: true })
  items!: StockReservationItem[];

  @Prop({
    type: String,
    required: true,
    enum: RESERVATION_STATUSES,
    default: 'ACTIVE',
    index: true,
  })
  status!: ReservationStatus;

  // createdAt, updatedAt — from timestamps: true
}

export const StockReservationSchema = SchemaFactory.createForClass(StockReservation);
