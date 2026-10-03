import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes } from 'mongoose';

export type ProductDocument = HydratedDocument<Product>;

/**
 * Embedded stock counters. Not a separate collection — `_id: false` keeps it a
 * plain nested object. Reservation is a single conditional atomic update
 * (`$inc` on both fields, guarded by `stock.available >= qty`), so the two
 * numbers must live together on the product document. Both carry a `min: 0`
 * validator so a bug can never drive either count negative.
 */
@Schema({ _id: false })
export class ProductStock {
  @Prop({ type: Number, required: true, min: 0, default: 0 })
  available!: number;

  @Prop({ type: Number, required: true, min: 0, default: 0 })
  reserved!: number;
}
export const ProductStockSchema = SchemaFactory.createForClass(ProductStock);

/**
 * Product catalog entry (SCHEMAS.md §3). Money is integer minor units
 * (`priceMinor`, cents) plus an ISO-4217 `currency` — never a float. The
 * single-field `category` / `isActive` filter indexes are declared inline here
 * because they are intrinsic to how the list endpoint queries; the compound
 * text index over name + description is declared on the schema below (Mongo
 * allows only one text index per collection, so both fields go together).
 */
@Schema({ timestamps: true, collection: 'products' })
export class Product {
  // _id: ObjectId (auto)

  @Prop({ required: true })
  name!: string; // part of the name/description text index (see below)

  @Prop({ default: '' })
  description!: string; // part of the name/description text index (see below)

  @Prop({ required: true, index: true })
  category!: string;

  @Prop({ required: true, min: 0 })
  priceMinor!: number; // cents

  @Prop({ required: true, default: 'USD' })
  currency!: string; // ISO 4217

  @Prop({ type: ProductStockSchema, required: true, default: () => ({}) })
  stock!: ProductStock;

  @Prop({ type: SchemaTypes.Map, of: SchemaTypes.Mixed, default: {} })
  attributes!: Map<string, unknown>; // flexible key-value (color, size, …)

  @Prop({ type: [String], default: [] })
  images!: string[]; // URLs only (D9)

  @Prop({ default: true, index: true })
  isActive!: boolean;

  // createdAt, updatedAt — from timestamps: true
}

export const ProductSchema = SchemaFactory.createForClass(Product);

// Full-text search over name + description, backing the search/list endpoint
// (PRD-4). With `autoIndex` off in production, `syncIndexes()` (PRD-3,
// src/scripts/sync-indexes.ts) is what actually materialises this index.
ProductSchema.index({ name: 'text', description: 'text' });
