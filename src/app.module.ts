import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { hostname } from 'node:os';
import { validateEnv } from './config/env.validation';
import { CorrelationModule } from './correlation/correlation.module';
import { CorrelationService } from './correlation/correlation.service';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { KafkaModule } from './kafka/kafka.module';
import { OutboxModule } from './outbox/outbox.module';
import { ProductModule } from './product/product.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    CorrelationModule,
    LoggerModule.forRootAsync({
      inject: [CorrelationService],
      useFactory: (correlation: CorrelationService) => ({
        pinoHttp: {
          level: process.env.LOG_LEVEL ?? 'info',
          transport:
            process.env.NODE_ENV === 'production'
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true, colorize: true } },
          customProps: () => ({ service: 'product-service', instanceId: hostname() }),
          mixin: () => {
            const correlationId = correlation.getCorrelationId();
            return correlationId ? { correlationId } : {};
          },
        },
      }),
    }),
    DatabaseModule,
    KafkaModule,
    HealthModule,
    OutboxModule,
    ProductModule,
  ],
})
export class AppModule {}
