# product-service

Product catalog and stock management microservice for the ecom platform. Exposes a gRPC API. Stores data in MongoDB via Mongoose.

## Responsibilities

- Product CRUD (admin-only writes)
- Product listing with filters, pagination, and text search
- Atomic stock reservation and release (Kafka-driven)
- Consumes `order.created`, `order.cancelled`, `order.shipped` events
- Produces `order.stock-reserved`, `order.stock-reservation-failed` events via transactional outbox

## Development

```bash
npm install
npm run start:dev
```

## Environment

See `.env.example` for required configuration.
