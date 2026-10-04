import { Controller, Get, INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { EXCEPTION_FILTERS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { GrpcExceptionFilter } from '../src/common/errors/grpc-exception.filter';
import { ProductController } from '../src/product/product.controller';
import { ProductService } from '../src/product/product.service';

// The service is a hybrid app (gRPC + HTTP /health). GrpcExceptionFilter
// returns an Observable, which the Express adapter ignores — so if it ever
// catches an HTTP exception the request hangs instead of returning a status.
// These tests pin the filter to the gRPC controller only (same guard the
// user-service review added for its UserController — see v1.12).

@Controller('probe')
class ProbeController {
  @Get()
  fail(): never {
    throw new ServiceUnavailableException('database down');
  }
}

describe('GrpcExceptionFilter scope', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProductController, ProbeController],
      providers: [{ provide: ProductService, useValue: {} }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is bound to ProductController', () => {
    const filters = Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, ProductController);
    expect(filters).toContain(GrpcExceptionFilter);
  });

  it('does not intercept HTTP exceptions (health returns 503, not a hang)', async () => {
    const res = await request(app.getHttpServer()).get('/probe').timeout(2_000);
    expect(res.status).toBe(503);
  });
});
