import { Module } from '@nestjs/common';
import { ProductModule } from '../product/product.module';
import { OutboxRelayService } from './outbox-relay.service';

// ProductModule re-exports the product-database models, which provides the
// Outbox model the relay injects.
@Module({
  imports: [ProductModule],
  providers: [OutboxRelayService],
  exports: [OutboxRelayService],
})
export class OutboxModule {}
