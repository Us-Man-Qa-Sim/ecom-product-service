import type { Product as ProtoProduct } from '@us-man-qa-sim/ecom-contracts/generated/product';
import type { ProductDocument } from '../schemas/product.schema';

// Timestamp isn't re-exported from the top-level contracts entry and its
// subpath isn't declared in the package's exports; structural typing suffices
// because ts-proto's Timestamp is exactly `{ seconds; nanos }`.
export function dateToTimestamp(date: Date): { seconds: number; nanos: number } {
  const millis = date.getTime();
  return {
    seconds: Math.trunc(millis / 1000),
    nanos: (millis % 1000) * 1_000_000,
  };
}

// Mongoose stores `attributes` as a `Map<string, unknown>`; the proto surface is
// `map<string, string>`. Values are serialised with `String()` (null/undefined
// are already impossible — Mongoose would have rejected a non-string on write,
// and we accept only strings in the DTO).
function serialiseAttributes(attributes: Map<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attributes) return out;
  for (const [key, value] of attributes.entries()) {
    out[key] = typeof value === 'string' ? value : String(value);
  }
  return out;
}

export function toProtoProduct(doc: ProductDocument): ProtoProduct {
  return {
    id: doc._id.toString(),
    name: doc.name,
    description: doc.description,
    category: doc.category,
    price: { amountMinor: doc.priceMinor, currency: doc.currency },
    stock: { available: doc.stock.available, reserved: doc.stock.reserved },
    attributes: serialiseAttributes(doc.attributes),
    images: [...doc.images],
    isActive: doc.isActive,
    createdAt: dateToTimestamp(doc.get('createdAt') as Date),
    updatedAt: dateToTimestamp(doc.get('updatedAt') as Date),
  };
}
