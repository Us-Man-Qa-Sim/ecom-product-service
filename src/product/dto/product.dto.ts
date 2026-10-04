import { z } from 'zod';

// Shared field schemas. Trimming + length caps protect the DB from accidental
// whitespace-only inputs and runaway documents.

export const ObjectIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex ObjectId');

const Name = z.string().trim().min(1).max(200);
const Description = z.string().trim().max(5000);
const Category = z.string().trim().min(1).max(100);

// ISO 4217 currency codes are exactly three uppercase letters.
const Currency = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(
    z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code'),
  );

// Prices and stock are int32 at the proto edge and non-negative on the schema,
// so we clamp here too — a float here would silently truncate at save time.
const PriceMinor = z.number().int().min(0).max(2_147_483_647);
const InitialStock = z.number().int().min(0).max(2_147_483_647);
const PriceInput = z.object({
  amountMinor: PriceMinor,
  currency: Currency,
});

// `attributes` is `map<string, string>` on the wire. Keys are trimmed to catch
// stray whitespace; values are capped so the Mixed-typed Map stays small.
const AttributesMap = z.record(z.string().trim().min(1).max(100), z.string().max(500));

const ImagesList = z.array(z.string().trim().url().max(2048)).max(20);

export const CreateProductInputSchema = z.object({
  name: Name,
  description: Description.default(''),
  category: Category,
  price: PriceInput,
  initialStock: InitialStock.default(0),
  attributes: AttributesMap.default({}),
  images: ImagesList.default([]),
});
export type CreateProductInput = z.infer<typeof CreateProductInputSchema>;

// AttributesUpdate / ImagesUpdate carry presence: unset = don't touch, set
// (even to empty) = replace. Mirror the proto wrapper shape so the service can
// tell the three states apart.
const AttributesUpdateWrapper = z.object({ values: AttributesMap });
const ImagesUpdateWrapper = z.object({ urls: ImagesList });

export const UpdateProductInputSchema = z
  .object({
    productId: ObjectIdSchema,
    name: Name.optional(),
    description: Description.optional(),
    category: Category.optional(),
    price: PriceInput.optional(),
    attributes: AttributesUpdateWrapper.optional(),
    images: ImagesUpdateWrapper.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.category !== undefined ||
      v.price !== undefined ||
      v.attributes !== undefined ||
      v.images !== undefined ||
      v.isActive !== undefined,
    { message: 'at least one field must be provided' },
  );
export type UpdateProductInput = z.infer<typeof UpdateProductInputSchema>;

export const ProductIdSchema = z.object({ productId: ObjectIdSchema });
export type ProductIdInput = z.infer<typeof ProductIdSchema>;

// Pagination defaults match the gateway contract (GW-5): 1-based page, cap at
// 100 rows. The service re-asserts them so a direct caller cannot opt out.
export const ListProductsInputSchema = z.object({
  pagination: z
    .object({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(20),
    })
    .default({ page: 1, pageSize: 20 }),
  category: Category.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  minPriceMinor: PriceMinor.optional(),
  maxPriceMinor: PriceMinor.optional(),
});
export type ListProductsInput = z.infer<typeof ListProductsInputSchema>;

// Mongo's `$in` is cheap even on large arrays; the cap prevents a caller from
// pulling the whole catalog in a single call.
export const GetProductsByIdsInputSchema = z.object({
  productIds: z.array(ObjectIdSchema).min(1).max(100),
});
export type GetProductsByIdsInput = z.infer<typeof GetProductsByIdsInputSchema>;

// AdjustStock applies a signed delta to `stock.available` (positive = restock,
// negative = reduce). Bounded to int32 at the proto edge; zero is rejected as a
// no-op programming error — a caller that wants to set an absolute value
// should go through UpdateProduct instead.
export const AdjustStockInputSchema = z.object({
  productId: ObjectIdSchema,
  delta: z
    .number()
    .int()
    .min(-2_147_483_647)
    .max(2_147_483_647)
    .refine((v) => v !== 0, { message: 'must not be zero' }),
});
export type AdjustStockInput = z.infer<typeof AdjustStockInputSchema>;
