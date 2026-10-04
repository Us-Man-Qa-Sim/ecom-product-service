import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter, SortOrder } from 'mongoose';
import type { ZodType } from 'zod';
import {
  FailedPreconditionError,
  NotFoundError,
  ValidationError,
} from '../common/errors/domain-errors';
import { Product, ProductDocument } from '../schemas/product.schema';
import {
  AdjustStockInputSchema,
  CreateProductInputSchema,
  GetProductsByIdsInputSchema,
  ListProductsInput,
  ListProductsInputSchema,
  ProductIdSchema,
  UpdateProductInput,
  UpdateProductInputSchema,
} from './dto/product.dto';

export interface ListProductsResult {
  products: ProductDocument[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

@Injectable()
export class ProductService {
  constructor(@InjectModel(Product.name) private readonly productModel: Model<ProductDocument>) {}

  async create(raw: unknown): Promise<ProductDocument> {
    const input = parse(CreateProductInputSchema, raw, 'CreateProduct');
    // `new Model().save()` keeps the single-document return type stable;
    // `Model.create` has an array overload that confuses inference. Mongoose
    // runs schema validators here (`min: 0`, enums, etc.) and the filter maps
    // the resulting `ValidationError` back to INVALID_ARGUMENT.
    const doc = new this.productModel({
      name: input.name,
      description: input.description,
      category: input.category,
      priceMinor: input.price.amountMinor,
      currency: input.price.currency,
      stock: { available: input.initialStock, reserved: 0 },
      attributes: input.attributes,
      images: input.images,
    });
    return doc.save();
  }

  async update(raw: unknown): Promise<ProductDocument> {
    const input = parse(UpdateProductInputSchema, raw, 'UpdateProduct');
    const update = buildUpdate(input);
    const doc = await this.productModel
      .findByIdAndUpdate(input.productId, update, {
        new: true,
        runValidators: true,
      })
      .exec();
    if (!doc) {
      throw new NotFoundError('Product not found');
    }
    return doc;
  }

  async remove(raw: unknown): Promise<void> {
    const input = parse(ProductIdSchema, raw, 'DeleteProduct');
    const deleted = await this.productModel.findByIdAndDelete(input.productId).exec();
    if (!deleted) {
      throw new NotFoundError('Product not found');
    }
  }

  async get(raw: unknown): Promise<ProductDocument> {
    const input = parse(ProductIdSchema, raw, 'GetProduct');
    const doc = await this.productModel.findById(input.productId).exec();
    if (!doc) {
      throw new NotFoundError('Product not found');
    }
    return doc;
  }

  async list(raw: unknown): Promise<ListProductsResult> {
    const input = parse(ListProductsInputSchema, raw, 'ListProducts');
    this.validateListRanges(input);

    const filter = buildListFilter(input);
    const { page, pageSize } = input.pagination;
    const skip = (page - 1) * pageSize;

    // `countDocuments(filter)` must share the exact same filter — including
    // the $text clause — so the total matches the paginated slice.
    const [total, products] = await Promise.all([
      this.productModel.countDocuments(filter).exec(),
      this.buildFindQuery(filter, input, skip, pageSize),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    return { products, total, page, pageSize, totalPages };
  }

  async getByIds(raw: unknown): Promise<ProductDocument[]> {
    const input = parse(GetProductsByIdsInputSchema, raw, 'GetProductsByIds');
    // De-duplicate: a caller sending the same id twice should still get a
    // single row back. Order is not promised either way — the caller joins by
    // id on its side (order-service does exactly that when snapshotting).
    const uniqueIds = Array.from(new Set(input.productIds));
    return this.productModel.find({ _id: { $in: uniqueIds } }).exec();
  }

  async adjustStock(raw: unknown): Promise<ProductDocument> {
    const input = parse(AdjustStockInputSchema, raw, 'AdjustStock');

    // Single conditional atomic update, same pattern as reservation (§2):
    // positive delta — unconditional $inc. Negative delta — guard by
    // `stock.available >= -delta` so the counter cannot go below zero even
    // under concurrent writes. `stock.reserved` is deliberately untouched;
    // restocking adds free units, reservations are a separate lifecycle.
    const filter: QueryFilter<ProductDocument> =
      input.delta < 0
        ? { _id: input.productId, 'stock.available': { $gte: -input.delta } }
        : { _id: input.productId };

    const doc = await this.productModel
      .findOneAndUpdate(
        filter,
        { $inc: { 'stock.available': input.delta } },
        { new: true, runValidators: true },
      )
      .exec();

    if (doc) return doc;

    // No match: either the product does not exist, or the stock guard failed.
    // Disambiguate with a cheap follow-up read so the caller sees NOT_FOUND vs
    // FAILED_PRECONDITION instead of a single ambiguous error.
    const exists = await this.productModel.findById(input.productId).exec();
    if (!exists) {
      throw new NotFoundError('Product not found');
    }
    throw new FailedPreconditionError(
      `Insufficient available stock to adjust by ${input.delta} (available=${exists.stock.available})`,
    );
  }

  private validateListRanges(input: ListProductsInput): void {
    if (
      input.minPriceMinor !== undefined &&
      input.maxPriceMinor !== undefined &&
      input.minPriceMinor > input.maxPriceMinor
    ) {
      throw new ValidationError('minPriceMinor must be <= maxPriceMinor');
    }
  }

  private buildFindQuery(
    filter: QueryFilter<ProductDocument>,
    input: ListProductsInput,
    skip: number,
    limit: number,
  ): Promise<ProductDocument[]> {
    if (input.search) {
      // Text search uses the compound text index on name + description
      // (PRD-3). Sorting by the per-document `textScore` gives the standard
      // relevance ordering; the projection is required for Mongo to compute
      // it. `_id: -1` after the score keeps a stable total order on ties.
      const sort: Record<string, SortOrder | { $meta: 'textScore' }> = {
        score: { $meta: 'textScore' },
        _id: -1,
      };
      return this.productModel
        .find(filter, { score: { $meta: 'textScore' } })
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .exec();
    }
    return this.productModel
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .exec();
  }
}

function buildListFilter(input: ListProductsInput): QueryFilter<ProductDocument> {
  const filter: QueryFilter<ProductDocument> = {};
  if (input.category !== undefined) filter.category = input.category;
  if (input.isActive !== undefined) filter.isActive = input.isActive;
  if (input.minPriceMinor !== undefined || input.maxPriceMinor !== undefined) {
    const priceRange: Record<string, number> = {};
    if (input.minPriceMinor !== undefined) priceRange.$gte = input.minPriceMinor;
    if (input.maxPriceMinor !== undefined) priceRange.$lte = input.maxPriceMinor;
    filter.priceMinor = priceRange;
  }
  if (input.search) {
    filter.$text = { $search: input.search };
  }
  return filter;
}

function buildUpdate(input: UpdateProductInput): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.description !== undefined) set.description = input.description;
  if (input.category !== undefined) set.category = input.category;
  if (input.price !== undefined) {
    set.priceMinor = input.price.amountMinor;
    set.currency = input.price.currency;
  }
  if (input.attributes !== undefined) set.attributes = input.attributes.values;
  if (input.images !== undefined) set.images = input.images.urls;
  if (input.isActive !== undefined) set.isActive = input.isActive;
  // `$set` is intentional: replacing `attributes` or `images` with an empty
  // object/array is a documented operation (clear), and $set on the whole
  // field does exactly that without touching unrelated keys.
  return { $set: set };
}

function parse<T>(schema: ZodType<T>, raw: unknown, rpc: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ValidationError(`Invalid ${rpc} request: ${message}`);
  }
  return parsed.data;
}
