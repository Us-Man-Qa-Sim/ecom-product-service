import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { HealthCheck, HealthCheckService, MongooseHealthIndicator } from '@nestjs/terminus';
import type { Connection } from 'mongoose';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongoose: MongooseHealthIndicator,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    // Pass the injected connection explicitly so the ping targets this service's
    // database rather than relying on Terminus resolving a default connection.
    return this.health.check([
      () => this.mongoose.pingCheck('database', { connection: this.connection }),
    ]);
  }

  @Get('live')
  live() {
    return { status: 'ok' as const };
  }
}
