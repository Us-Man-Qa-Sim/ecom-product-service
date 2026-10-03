import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Outbox, OutboxSchema } from '../schemas/outbox.schema';
import { ProcessedEvent, ProcessedEventSchema } from '../schemas/processed-event.schema';
import { Product, ProductSchema } from '../schemas/product.schema';
import { StockReservation, StockReservationSchema } from '../schemas/stock-reservation.schema';
import { ProductController } from './product.controller';

// Model registration for the product database. Product is used by the sync CRUD
// endpoints (PRD-4/PRD-5); Outbox, ProcessedEvent and StockReservation back the
// Kafka reserve/release/consume flow (KFK-2…KFK-6). MongooseModule is re-exported
// so those later feature modules can inject the same models without re-declaring
// them against the connection.
const MODELS = MongooseModule.forFeature([
  { name: Product.name, schema: ProductSchema },
  { name: Outbox.name, schema: OutboxSchema },
  { name: ProcessedEvent.name, schema: ProcessedEventSchema },
  { name: StockReservation.name, schema: StockReservationSchema },
]);

@Module({
  imports: [MODELS],
  controllers: [ProductController],
  exports: [MODELS],
})
export class ProductModule {}
