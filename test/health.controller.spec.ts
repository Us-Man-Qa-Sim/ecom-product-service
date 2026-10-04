import type {
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorFunction,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import type { Connection } from 'mongoose';
import { HealthController } from '../src/health/health.controller';

// The controller delegates to Terminus and pings the injected Mongoose
// connection explicitly (so the ping targets this service's database rather
// than relying on Terminus' default-connection resolution). We construct the
// controller directly rather than booting a Nest testing module because the
// `@InjectConnection()` decorator resolves to a token Terminus does not
// provide — a plain `new` is both simpler and closer to what the Nest DI
// does once providers are satisfied.

function makeOk(): HealthCheckResult {
  return {
    status: 'ok',
    info: { database: { status: 'up' } },
    error: {},
    details: { database: { status: 'up' } },
  };
}

describe('HealthController', () => {
  it('passes the injected Mongoose connection to the Mongoose ping check', async () => {
    const fakeConnection = { readyState: 1 } as unknown as Connection;
    const pingCheck = jest.fn().mockResolvedValue({ database: { status: 'up' } });
    const healthCheck = jest
      .fn<Promise<HealthCheckResult>, [HealthIndicatorFunction[]]>()
      .mockImplementation(async (indicators) => {
        // Terminus invokes each indicator; mirror that so our ping assertion fires.
        await Promise.all(indicators.map((fn) => fn()));
        return makeOk();
      });

    const controller = new HealthController(
      { check: healthCheck } as unknown as HealthCheckService,
      { pingCheck } as unknown as MongooseHealthIndicator,
      fakeConnection,
    );

    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(healthCheck).toHaveBeenCalledTimes(1);
    expect(pingCheck).toHaveBeenCalledTimes(1);
    expect(pingCheck).toHaveBeenCalledWith('database', { connection: fakeConnection });
  });

  it('surfaces failure results from Terminus unchanged', async () => {
    const downResult: HealthCheckResult = {
      status: 'error',
      info: {},
      error: { database: { status: 'down', message: 'unreachable' } },
      details: { database: { status: 'down', message: 'unreachable' } },
    };
    const healthCheck = jest.fn().mockResolvedValue(downResult);

    const controller = new HealthController(
      { check: healthCheck } as unknown as HealthCheckService,
      { pingCheck: jest.fn() } as unknown as MongooseHealthIndicator,
      {} as Connection,
    );

    await expect(controller.check()).resolves.toBe(downResult);
  });

  it('/health/live returns ok without touching the database', () => {
    // Dependency-free liveness probe — stays answerable even if Mongo is down,
    // used by orchestrators that just want to know the process is up.
    const controller = new HealthController(
      {} as HealthCheckService,
      {} as MongooseHealthIndicator,
      {} as Connection,
    );
    expect(controller.live()).toEqual({ status: 'ok' });
  });
});
