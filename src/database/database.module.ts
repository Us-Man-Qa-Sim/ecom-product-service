import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { Env } from '../config/env.validation';

/**
 * Registers the default Mongoose connection for the product database.
 *
 * `autoIndex` follows the environment: on in dev/test so schema-declared indexes
 * (PRD-3) materialise automatically, off in production where index builds are
 * driven explicitly via `syncIndexes()` to avoid surprise foreground builds on
 * a live collection.
 */
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const logger = new Logger('Mongoose');
        const nodeEnv = config.get('NODE_ENV', { infer: true });
        return {
          uri: config.get('MONGO_URI', { infer: true }),
          autoIndex: nodeEnv !== 'production',
          onConnectionCreate: (connection) => {
            connection.on('connected', () => logger.log('Mongoose connected'));
            connection.on('disconnected', () => logger.warn('Mongoose disconnected'));
            connection.on('error', (err) => logger.error(`Mongoose error: ${err.message}`));
            return connection;
          },
        };
      },
    }),
  ],
})
export class DatabaseModule {}
