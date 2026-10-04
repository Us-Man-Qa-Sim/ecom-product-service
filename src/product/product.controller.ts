import { Controller, UseFilters } from '@nestjs/common';
import type { Metadata } from '@grpc/grpc-js';
import {
  AdjustStockRequest,
  AdjustStockResponse,
  CreateProductRequest,
  CreateProductResponse,
  DeleteProductRequest,
  DeleteProductResponse,
  GetProductRequest,
  GetProductResponse,
  GetProductsByIdsRequest,
  GetProductsByIdsResponse,
  ListProductsRequest,
  ListProductsResponse,
  ProductServiceController,
  ProductServiceControllerMethods,
  UpdateProductRequest,
  UpdateProductResponse,
} from '@us-man-qa-sim/ecom-contracts/generated/product';
import { GrpcExceptionFilter } from '../common/errors/grpc-exception.filter';
import { readIdentity, requireAdmin } from '../identity/identity.util';
import { ProductService } from './product.service';
import { toProtoProduct } from './product.mapper';

// PRD-4/PRD-5: public reads (Get, List, GetProductsByIds — the last used by
// order-service when snapshotting items at order-creation time), admin-only
// writes (Create, Update, Delete, AdjustStock). Admin enforcement is the
// gateway's primary job (JWT verified there), but we re-check here from the
// forwarded identity metadata so a leaked internal path still cannot write.

@Controller()
@UseFilters(GrpcExceptionFilter)
@ProductServiceControllerMethods()
export class ProductController implements ProductServiceController {
  constructor(private readonly productService: ProductService) {}

  async createProduct(
    request: CreateProductRequest,
    metadata?: Metadata,
  ): Promise<CreateProductResponse> {
    requireAdmin(readIdentity(metadata));
    const product = await this.productService.create(request);
    return { product: toProtoProduct(product) };
  }

  async updateProduct(
    request: UpdateProductRequest,
    metadata?: Metadata,
  ): Promise<UpdateProductResponse> {
    requireAdmin(readIdentity(metadata));
    const product = await this.productService.update(request);
    return { product: toProtoProduct(product) };
  }

  async deleteProduct(
    request: DeleteProductRequest,
    metadata?: Metadata,
  ): Promise<DeleteProductResponse> {
    requireAdmin(readIdentity(metadata));
    await this.productService.remove(request);
    return {};
  }

  async getProduct(request: GetProductRequest): Promise<GetProductResponse> {
    const product = await this.productService.get(request);
    return { product: toProtoProduct(product) };
  }

  async listProducts(request: ListProductsRequest): Promise<ListProductsResponse> {
    const result = await this.productService.list(request);
    return {
      products: result.products.map(toProtoProduct),
      pagination: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
      },
    };
  }

  async getProductsByIds(request: GetProductsByIdsRequest): Promise<GetProductsByIdsResponse> {
    const products = await this.productService.getByIds(request);
    return { products: products.map(toProtoProduct) };
  }

  async adjustStock(
    request: AdjustStockRequest,
    metadata?: Metadata,
  ): Promise<AdjustStockResponse> {
    requireAdmin(readIdentity(metadata));
    const product = await this.productService.adjustStock(request);
    return { product: toProtoProduct(product) };
  }
}
