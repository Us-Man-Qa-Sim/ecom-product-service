import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Mongoose, Types } from 'mongoose';
import { Product, ProductSchema, type ProductDocument } from '../src/schemas/product.schema';
import { ProductController } from '../src/product/product.controller';
import { ProductService } from '../src/product/product.service';
import { PermissionDeniedError, UnauthenticatedError } from '../src/common/errors/domain-errors';

const m = new Mongoose();
const ProductModel = m.model(Product.name, ProductSchema);

function buildDoc(overrides: Partial<Record<string, unknown>> = {}): ProductDocument {
  const doc = new ProductModel({
    name: 'Widget',
    description: '',
    category: 'tools',
    priceMinor: 1000,
    currency: 'USD',
    stock: { available: 1, reserved: 0 },
    attributes: {},
    images: [],
    isActive: true,
    ...overrides,
  }) as ProductDocument;
  doc._id = new Types.ObjectId();
  doc.set('createdAt', new Date('2026-01-01T00:00:00Z'));
  doc.set('updatedAt', new Date('2026-01-01T00:00:00Z'));
  return doc;
}

function md(entries: Record<string, string>): Metadata {
  const meta = new Metadata();
  for (const [k, v] of Object.entries(entries)) meta.set(k, v);
  return meta;
}

const ADMIN = md({ 'x-user-id': 'u1', 'x-user-role': 'ADMIN' });
const CUSTOMER = md({ 'x-user-id': 'u1', 'x-user-role': 'CUSTOMER' });

function makeService(): jest.Mocked<ProductService> {
  return {
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    get: jest.fn(),
    list: jest.fn(),
    getByIds: jest.fn(),
  } as unknown as jest.Mocked<ProductService>;
}

describe('ProductController — admin-only writes', () => {
  it('createProduct allows ADMIN and returns the mapped product', async () => {
    const svc = makeService();
    const doc = buildDoc({ name: 'Created' });
    svc.create.mockResolvedValue(doc);
    const ctl = new ProductController(svc);
    const response = await ctl.createProduct(
      { name: 'Created', description: '', category: 'tools' } as never,
      ADMIN,
    );
    expect(response.product?.name).toBe('Created');
    expect(svc.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['createProduct', 'create'],
    ['updateProduct', 'update'],
    ['deleteProduct', 'remove'],
  ] as const)('%s rejects a CUSTOMER with PermissionDeniedError', async (rpc, serviceMethod) => {
    const svc = makeService();
    const ctl = new ProductController(svc);
    const call = () =>
      (ctl as unknown as Record<string, (req: unknown, meta: Metadata) => Promise<unknown>>)[rpc](
        {} as never,
        CUSTOMER,
      );
    await expect(call()).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(svc[serviceMethod]).not.toHaveBeenCalled();
  });

  it.each([['createProduct'], ['updateProduct'], ['deleteProduct']])(
    '%s rejects a missing identity with UnauthenticatedError',
    async (rpc) => {
      const svc = makeService();
      const ctl = new ProductController(svc);
      const call = () =>
        (ctl as unknown as Record<string, (req: unknown, meta?: Metadata) => Promise<unknown>>)[
          rpc
        ]({} as never, undefined);
      await expect(call()).rejects.toBeInstanceOf(UnauthenticatedError);
    },
  );

  it('updateProduct returns the mapped updated document', async () => {
    const svc = makeService();
    const doc = buildDoc({ name: 'Renamed' });
    svc.update.mockResolvedValue(doc);
    const ctl = new ProductController(svc);
    const resp = await ctl.updateProduct(
      { productId: doc._id.toString(), name: 'Renamed' } as never,
      ADMIN,
    );
    expect(resp.product?.name).toBe('Renamed');
  });

  it('deleteProduct returns an empty response and calls the service', async () => {
    const svc = makeService();
    svc.remove.mockResolvedValue(undefined);
    const ctl = new ProductController(svc);
    const resp = await ctl.deleteProduct(
      { productId: new Types.ObjectId().toString() } as never,
      ADMIN,
    );
    expect(resp).toEqual({});
    expect(svc.remove).toHaveBeenCalledTimes(1);
  });
});

describe('ProductController — public reads', () => {
  it('getProduct requires no identity', async () => {
    const svc = makeService();
    const doc = buildDoc();
    svc.get.mockResolvedValue(doc);
    const ctl = new ProductController(svc);
    const resp = await ctl.getProduct({ productId: doc._id.toString() } as never);
    expect(resp.product?.id).toBe(doc._id.toString());
  });

  it('listProducts wraps the service result and the pagination block', async () => {
    const svc = makeService();
    svc.list.mockResolvedValue({
      products: [buildDoc({ name: 'A' }), buildDoc({ name: 'B' })],
      total: 2,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const ctl = new ProductController(svc);
    const resp = await ctl.listProducts({} as never);
    expect(resp.products).toHaveLength(2);
    expect(resp.pagination).toEqual({ total: 2, page: 1, pageSize: 20, totalPages: 1 });
  });

  it('getProductsByIds returns the mapped list', async () => {
    const svc = makeService();
    svc.getByIds.mockResolvedValue([buildDoc({ name: 'A' })]);
    const ctl = new ProductController(svc);
    const resp = await ctl.getProductsByIds({
      productIds: [new Types.ObjectId().toString()],
    } as never);
    expect(resp.products).toHaveLength(1);
  });
});

describe('ProductController — adjustStock (deferred to PRD-5)', () => {
  it('throws UNIMPLEMENTED', async () => {
    const svc = makeService();
    const ctl = new ProductController(svc);
    try {
      await ctl.adjustStock({ productId: new Types.ObjectId().toString(), delta: 1 } as never);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcException);
      const payload = (err as RpcException).getError() as { code: number };
      expect(payload.code).toBe(GrpcStatus.UNIMPLEMENTED);
    }
  });
});
