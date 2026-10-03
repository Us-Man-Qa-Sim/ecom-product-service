# product-service

Product catalog and stock management microservice for the ecom platform. Exposes a gRPC API (`ecom.product.v1.ProductService`) and an HTTP `/health` endpoint. Stores data in MongoDB via Mongoose.

## Status

Scaffolded (`PRD-1`): NestJS 12 hybrid app — gRPC transport on `:5002` for the `ecom.product.v1` package, HTTP `/health` on `:8082` (Mongoose ping via `@nestjs/terminus`), pino logging, `@nestjs/config` with a `zod` env schema, and a `ProductController` stub where every RPC answers gRPC `UNIMPLEMENTED`.

Schemas (`PRD-2`): the four Mongoose models live in `src/schemas/` — `Product` (catalog entry with embedded `stock.{available,reserved}`, `min: 0`-guarded money and stock, `Map` attributes, image URLs), `StockReservation` (per-order hold with embedded items and `ACTIVE`/`RELEASED`/`CONSUMED` status), `ProcessedEvent` (inbox, unique `eventId`) and `Outbox` (transactional outbox). All are registered and re-exported by `ProductModule`. The text index and `syncIndexes()` wiring are `PRD-3`; real RPC logic lands in `PRD-4` → `PRD-7`.

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
| `npm run build`                   | Compile TypeScript to `dist/`      |
| `npm start`                       | Run the built app (`dist/main.js`) |
| `npm run start:dev`               | Run from source with ts-node       |
| `npm run lint` / `lint:fix`       | ESLint                             |
| `npm run format` / `format:check` | Prettier                           |
| `npm test`                        | Jest                               |

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

- gRPC: `ecom.product.v1.ProductService` on `GRPC_PORT` (all RPCs currently `UNIMPLEMENTED`)
- `GET /health` — liveness + MongoDB readiness (Terminus)
- `GET /health/live` — process liveness only
