import { z } from 'zod';

const numericString = (defaultValue: number) =>
  z
    .string()
    .default(String(defaultValue))
    .transform((value, ctx) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: 'custom', message: `${value} is not a number` });
        return z.NEVER;
      }
      return parsed;
    });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  GRPC_HOST: z.string().default('0.0.0.0'),
  GRPC_PORT: numericString(5002),

  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: numericString(8082),

  // MongoDB connection string. Must point at the `rs0` replica set — multi-document
  // transactions (stock reservation, KFK-2) require it. See infra/docker-compose.yml.
  MONGO_URI: z.string().min(1),

  // Kafka: producer (outbox relay, KFK-3) + consumer group (KFK-2/5/6).
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('product-service'),
  KAFKA_CONSUMER_GROUP_ID: z.string().default('product-service'),
  KAFKA_CONSUMER_MAX_RETRIES: numericString(5),
  KAFKA_CONSUMER_RETRY_BASE_MS: numericString(1_000),
  KAFKA_CONSUMER_RETRY_MAX_MS: numericString(30_000),

  OUTBOX_RELAY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OUTBOX_RELAY_POLL_INTERVAL_MS: numericString(250),
  OUTBOX_RELAY_BATCH_SIZE: numericString(32),
  OUTBOX_RELAY_ERROR_BACKOFF_MS: numericString(5_000),
  // How long a claimed outbox row stays invisible to other relay ticks. Must
  // exceed the producer send timeout (30 s) so a slow publish is not re-claimed.
  OUTBOX_RELAY_CLAIM_TTL_MS: numericString(60_000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  return parsed.data;
}
