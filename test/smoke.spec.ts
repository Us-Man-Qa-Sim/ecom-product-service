import { validateEnv } from '../src/config/env.validation';

const MONGO_URI = 'mongodb://product_svc:changeme@localhost:27017/product?authSource=admin';

describe('env validation', () => {
  it('accepts a valid environment and applies defaults', () => {
    const env = validateEnv({ MONGO_URI });
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.GRPC_PORT).toBe(5002);
    expect(env.HTTP_PORT).toBe(8082);
    expect(env.KAFKA_BROKERS).toBe('localhost:9092');
    expect(env.KAFKA_CLIENT_ID).toBe('product-service');
  });

  it('coerces numeric port strings to numbers', () => {
    const env = validateEnv({ MONGO_URI, GRPC_PORT: '6002', HTTP_PORT: '9082' });
    expect(env.GRPC_PORT).toBe(6002);
    expect(env.HTTP_PORT).toBe(9082);
  });

  it('rejects a missing MONGO_URI', () => {
    expect(() => validateEnv({})).toThrow(/MONGO_URI/);
  });

  it('rejects a non-numeric GRPC_PORT', () => {
    expect(() => validateEnv({ MONGO_URI, GRPC_PORT: 'not-a-port' })).toThrow(/GRPC_PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ MONGO_URI, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('accepts every supported log level', () => {
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']) {
      expect(validateEnv({ MONGO_URI, LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
    }
  });
});
