import { Controller } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
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

// PRD-1 scaffold: every RPC is wired to the gRPC transport but not yet
// implemented. Real logic lands in PRD-4 (CRUD / List / GetProductsByIds) and
// PRD-5 (AdjustStock). Until then each method answers UNIMPLEMENTED so callers
// get a clean gRPC status rather than a transport error.
function unimplemented(rpc: string): never {
  throw new RpcException({
    code: status.UNIMPLEMENTED,
    message: `${rpc} is not implemented yet`,
  });
}

@Controller()
@ProductServiceControllerMethods()
export class ProductController implements ProductServiceController {
  createProduct(_request: CreateProductRequest): Promise<CreateProductResponse> {
    return unimplemented('CreateProduct');
  }

  updateProduct(_request: UpdateProductRequest): Promise<UpdateProductResponse> {
    return unimplemented('UpdateProduct');
  }

  deleteProduct(_request: DeleteProductRequest): Promise<DeleteProductResponse> {
    return unimplemented('DeleteProduct');
  }

  getProduct(_request: GetProductRequest): Promise<GetProductResponse> {
    return unimplemented('GetProduct');
  }

  listProducts(_request: ListProductsRequest): Promise<ListProductsResponse> {
    return unimplemented('ListProducts');
  }

  getProductsByIds(_request: GetProductsByIdsRequest): Promise<GetProductsByIdsResponse> {
    return unimplemented('GetProductsByIds');
  }

  adjustStock(_request: AdjustStockRequest): Promise<AdjustStockResponse> {
    return unimplemented('AdjustStock');
  }
}
