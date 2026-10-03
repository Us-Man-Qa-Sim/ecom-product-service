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
 * text index on name/description and the `syncIndexes()` wiring land in PRD-3;
 * the single-field `category` / `isActive` filter indexes are declared inline
 * here because they are intrinsic to how the list endpoint queries.
 */
@Schema({ timestamps: true, collection: 'products' })
export class Product {
  // _id: ObjectId (auto)

  @Prop({ required: true })
  name!: string; // text index (PRD-3)

  @Prop({ default: '' })
  description!: string; // text index (PRD-3)

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
