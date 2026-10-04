# product-service

Product catalog and stock management microservice for the ecom platform. Exposes a gRPC API (`ecom.product.v1.ProductService`) and an HTTP `/health` endpoint. Stores data in MongoDB via Mongoose.

## Status

Scaffolded (`PRD-1`): NestJS 12 hybrid app — gRPC transport on `:5002` for the `ecom.product.v1` package, HTTP `/health` on `:8082` (Mongoose ping via `@nestjs/terminus`), pino logging, `@nestjs/config` with a `zod` env schema.

Schemas (`PRD-2`): the four Mongoose models live in `src/schemas/` — `Product` (catalog entry with embedded `stock.{available,reserved}`, `min: 0`-guarded money and stock, `Map` attributes, image URLs), `StockReservation` (per-order hold with embedded items and `ACTIVE`/`RELEASED`/`CONSUMED` status), `ProcessedEvent` (inbox, unique `eventId`) and `Outbox` (transactional outbox). All are registered and re-exported by `ProductModule`.

Sync CRUD + list (`PRD-4`): `CreateProduct`, `UpdateProduct`, `DeleteProduct`, `GetProduct`, `ListProducts`, `GetProductsByIds` are implemented. Writes require the forwarded identity to carry `role=ADMIN`; reads are anonymous. Filters: `category`, `isActive`, `priceMinor` range, full-text `search` over `name`+`description` (textScore-ranked when search is set). Pagination is 1-based, defaults to 20 rows, capped at 100. Only `AdjustStock` still returns `UNIMPLEMENTED` — it lands in `PRD-5`.

Catalog seed (`PRD-6`): `npm run seed:products` loads `.env`, connects to Mongo (`MONGO_URI`), and ingests the sample catalog in `src/seed/sample-catalog.ts`. Idempotent on `(name, category)`: missing items are inserted with their `initialStock` and `reserved: 0`; existing items get their price, description, attributes, images and `isActive` flag refreshed, but the live stock counters are left alone (operational data belongs to AdjustStock and the reservation lifecycle). The compiled seed also ships in the Docker image at `dist/seed/seed-products.js` for `docker exec product-service node dist/seed/seed-products.js`.

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

| Script                            | Purpose                            |
| --------------------------------- | ---------------------------------- |
| `npm run build`                   | Compile TypeScript to `dist/`               |
| `npm start`                       | Run the built app (`dist/main.js`)          |
| `npm run start:dev`               | Run from source with ts-node                |
| `npm run sync-indexes`            | Run Mongo `syncIndexes()` (compiled)        |
| `npm run sync-indexes:dev`        | Same, from source                           |
| `npm run seed:products`           | Seed the sample catalog (idempotent)        |
| `npm run lint` / `lint:fix`       | ESLint                                      |
| `npm run format` / `format:check` | Prettier                                    |
| `npm test`                        | Jest                                        |

## Environment

| Var               | Default           | Notes                                           |
| ----------------- | ----------------- | ----------------------------------------------- |
| `NODE_ENV`        | `development`     | `development` \| `test` \| `production`         |
| `LOG_LEVEL`       | `info`            | pino level                                      |
| `GRPC_HOST`       | `0.0.0.0`         | gRPC bind host                                  |
| `GRPC_PORT`       | `5002`            | gRPC bind port                                  |
| `HTTP_HOST`       | `0.0.0.0`         | health bind host                                |
| `HTTP_PORT`       | `8082`            | health bind port                                |
| `MONGO_URI`       | —                 | **required**; must target the `rs0` replica set |
| `KAFKA_BROKERS`   | `localhost:9092`  | used once the Kafka phase (KFK) lands           |
| `KAFKA_CLIENT_ID` | `product-service` | Kafka client id                                 |

See `.env.example` for the full annotated list.

## Endpoints

- gRPC: `ecom.product.v1.ProductService` on `GRPC_PORT`
  - **Public reads** — `GetProduct`, `ListProducts`, `GetProductsByIds` (service-to-service; order-service calls this at order-creation time to snapshot name/price)
  - **Admin writes** — `CreateProduct`, `UpdateProduct`, `DeleteProduct` (require `x-user-role: ADMIN` metadata forwarded by the gateway)
  - **Deferred** — `AdjustStock` (`PRD-5`) still answers `UNIMPLEMENTED`
- `GET /health` — liveness + MongoDB readiness (Terminus)
- `GET /health/live` — process liveness only
