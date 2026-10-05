# product-service

Product catalog and stock management microservice for the ecom platform. Exposes a gRPC API (`ecom.product.v1.ProductService`) and an HTTP `/health` endpoint. Stores data in MongoDB via Mongoose.

## Status

Scaffolded (`PRD-1`): NestJS 12 hybrid app — gRPC transport on `:5002` for the `ecom.product.v1` package, HTTP `/health` on `:8082` (Mongoose ping via `@nestjs/terminus`), pino logging, `@nestjs/config` with a `zod` env schema.

Schemas (`PRD-2`): the four Mongoose models live in `src/schemas/` — `Product` (catalog entry with embedded `stock.{available,reserved}`, `min: 0`-guarded money and stock, `Map` attributes, image URLs), `StockReservation` (per-order hold with embedded items and `ACTIVE`/`RELEASED`/`CONSUMED` status), `ProcessedEvent` (inbox, unique `eventId`) and `Outbox` (transactional outbox). All are registered and re-exported by `ProductModule`.

Sync CRUD + list (`PRD-4`): `CreateProduct`, `UpdateProduct`, `DeleteProduct`, `GetProduct`, `ListProducts`, `GetProductsByIds` are implemented. Writes require the forwarded identity to carry `role=ADMIN`; reads are anonymous. Filters: `category`, `isActive`, `priceMinor` range, full-text `search` over `name`+`description` (textScore-ranked when search is set). Pagination is 1-based, defaults to 20 rows, capped at 100.

Stock adjustment (`PRD-5`): `AdjustStock` applies a signed integer delta to `stock.available` under a single conditional atomic update — negative deltas carry a `stock.available >= -delta` guard so the counter can never go below zero even under parallel reservations. Admin-only.

Catalog seed (`PRD-6`): `npm run seed:products` loads `.env`, connects to Mongo (`MONGO_URI`), and ingests the sample catalog in `src/seed/sample-catalog.ts`. Idempotent on `(name, category)`: missing items are inserted with their `initialStock` and `reserved: 0`; existing items get their price, description, attributes, images and `isActive` flag refreshed, but the live stock counters are left alone (operational data belongs to AdjustStock and the reservation lifecycle). The compiled seed also ships in the Docker image at `dist/seed/seed-products.js` for `docker exec product-service node dist/seed/seed-products.js`.

Tests (`PRD-7`, at the end of Phase 5): 124 Jest cases across `test/` — DTO parsing and ISO-currency normalisation, the error filter's mapping table (RpcException/DomainError/Zod/Mongoose Validation/Cast/E11000), the Mongoose schemas (defaults, min, enum, uniques), the service (CRUD + list filters/pagination/textScore + GetProductsByIds + AdjustStock + the stock guard), the controller (admin gating + metadata), the gRPC-to-proto mapper, the health controller, the sync-indexes model list, the identity util, the seed, and an exception-filter-scope guard that keeps the gRPC filter off the HTTP `/health` route.

Kafka flow (`KFK-1`–`KFK-11`):

- **Consumer** (`src/kafka/kafka-consumer.service.ts`): one consumer group for `order.created`, `order.cancelled` and `order.shipped`. Offsets are committed manually after the handler succeeds, and a new group starts from the earliest offset. Each envelope is validated with the contracts' `parseEvent()`. A failing handler is retried with exponential backoff. After `KAFKA_CONSUMER_MAX_RETRIES` attempts the message is logged as poison and skipped (no DLQ yet, see `STR-1`).
- **Reserve** (`order.created`): runs in one Mongo transaction: inbox insert (`processed_events`, unique `eventId`), all-or-nothing `$gte`-guarded reservation per item, a `StockReservation` row and an outbox `order.stock-reserved` / `order.stock-reservation-failed`. Unknown or malformed product ids and empty orders produce `stock-reservation-failed` instead of throwing.
- **Release / consume** (`order.cancelled` / `order.shipped`): an `ACTIVE` reservation is released (`reserved → available`) or consumed (`reserved↓`) and marked `RELEASED` / `CONSUMED`. If there is no reservation, a tombstone is written so a late `order.created` reserves nothing (`KFK-7`).
- **Outbox relay** (`src/outbox/outbox-relay.service.ts`): claims a row with a `claimedUntil` lease, publishes it and only then stamps `sentAt`. If the relay crashes mid-publish, the lease expires and the row is re-published, so delivery is at-least-once and consumers dedupe.
- **Correlation**: the gRPC `x-request-id` and the envelope's `correlationId` are held in `AsyncLocalStorage` (`src/correlation/`) and copied into new outbox envelopes and the `x-correlation-id` Kafka header.

## Responsibilities

- Product CRUD (admin-only writes)
- Product listing with filters, pagination, and text search
- Atomic stock reservation and release (Kafka-driven)
- Consumes `order.created`, `order.cancelled`, `order.shipped` events
- Produces `order.stock-reserved`, `order.stock-reservation-failed` events via transactional outbox

## Development

```bash
npm install
cp .env.example .env   # adjust MONGO_URI for your local Mongo replica set
npm run start:dev
```

Requires a MongoDB replica set (`rs0`) — see `../infra/docker-compose.yml`. The gRPC
service and health endpoint come up together; `/health` reports `down` until Mongo
is reachable.

## Scripts

| Script                            | Purpose                              |
| --------------------------------- | ------------------------------------ |
| `npm run build`                   | Compile TypeScript to `dist/`        |
| `npm start`                       | Run the built app (`dist/main.js`)   |
| `npm run start:dev`               | Run from source with ts-node         |
| `npm run sync-indexes`            | Run Mongo `syncIndexes()` (compiled) |
| `npm run sync-indexes:dev`        | Same, from source                    |
| `npm run seed:products`           | Seed the sample catalog (idempotent) |
| `npm run lint` / `lint:fix`       | ESLint                               |
| `npm run format` / `format:check` | Prettier                             |
| `npm test`                        | Jest                                 |

## Environment

| Var                             | Default           | Notes                                                                    |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| `NODE_ENV`                      | `development`     | `development` \| `test` \| `production`                                  |
| `LOG_LEVEL`                     | `info`            | pino level                                                               |
| `GRPC_HOST`                     | `0.0.0.0`         | gRPC bind host                                                           |
| `GRPC_PORT`                     | `5002`            | gRPC bind port                                                           |
| `HTTP_HOST`                     | `0.0.0.0`         | health bind host                                                         |
| `HTTP_PORT`                     | `8082`            | health bind port                                                         |
| `MONGO_URI`                     | —                 | **required**; must target the `rs0` replica set                          |
| `KAFKA_BROKERS`                 | `localhost:9092`  | Kafka bootstrap servers (comma-separated)                                |
| `KAFKA_CLIENT_ID`               | `product-service` | Kafka client id                                                          |
| `KAFKA_CONSUMER_GROUP_ID`       | `product-service` | consumer group for `order.created/cancelled/shipped`                     |
| `KAFKA_CONSUMER_MAX_RETRIES`    | `5`               | handler attempts before a message is logged as poison and skipped        |
| `KAFKA_CONSUMER_RETRY_BASE_MS`  | `1000`            | first retry backoff (doubles per attempt, +≤20% jitter)                  |
| `KAFKA_CONSUMER_RETRY_MAX_MS`   | `30000`           | backoff cap                                                              |
| `OUTBOX_RELAY_ENABLED`          | `true`            | run the outbox → Kafka relay                                             |
| `OUTBOX_RELAY_POLL_INTERVAL_MS` | `250`             | relay poll interval                                                      |
| `OUTBOX_RELAY_BATCH_SIZE`       | `32`              | rows per relay tick                                                      |
| `OUTBOX_RELAY_ERROR_BACKOFF_MS` | `5000`            | backoff after a failed tick                                              |
| `OUTBOX_RELAY_CLAIM_TTL_MS`     | `60000`           | claim lease; a row claimed by a crashed relay is re-published after this |

See `.env.example` for the full annotated list.

## Endpoints

- gRPC: `ecom.product.v1.ProductService` on `GRPC_PORT`
  - **Public reads** — `GetProduct`, `ListProducts`, `GetProductsByIds` (service-to-service; order-service calls this at order-creation time to snapshot name/price)
  - **Admin writes** — `CreateProduct`, `UpdateProduct`, `DeleteProduct`, `AdjustStock` (require `x-user-role: ADMIN` metadata forwarded by the gateway)
- `GET /health` — liveness + MongoDB readiness (Terminus)
- `GET /health/live` — process liveness only
