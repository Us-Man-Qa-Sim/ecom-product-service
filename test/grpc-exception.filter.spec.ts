import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { firstValueFrom } from 'rxjs';
import mongoose from 'mongoose';
import { ZodError, z } from 'zod';
import { GrpcExceptionFilter } from '../src/common/errors/grpc-exception.filter';
import {
  ConflictError,
  FailedPreconditionError,
  NotFoundError,
  PermissionDeniedError,
  UnauthenticatedError,
  ValidationError,
} from '../src/common/errors/domain-errors';

async function caught(filter: GrpcExceptionFilter, err: unknown): Promise<RpcException> {
  const observable = filter.catch(err, {} as never);
  try {
    await firstValueFrom(observable);
    throw new Error('expected throw');
  } catch (thrown) {
    if (thrown instanceof RpcException) return thrown;
    throw thrown;
  }
}

function code(ex: RpcException): number {
  const err = ex.getError();
  return (err as { code: number }).code;
}

function message(ex: RpcException): string {
  const err = ex.getError();
  return (err as { message: string }).message;
}

describe('GrpcExceptionFilter', () => {
  let filter: GrpcExceptionFilter;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    filter = new GrpcExceptionFilter();
    // The unknown-error branch logs the real error. Silencing keeps Jest's
    // output clean while still letting us assert on the mapped code.
    errorSpy = jest
      .spyOn((filter as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it('passes RpcException through unchanged', async () => {
    const original = new RpcException({ code: GrpcStatus.ABORTED, message: 'from inside' });
    const mapped = await caught(filter, original);
    expect(mapped).toBe(original);
  });

  it.each([
    [new ValidationError('bad field'), GrpcStatus.INVALID_ARGUMENT],
    [new NotFoundError('nope'), GrpcStatus.NOT_FOUND],
    [new ConflictError('dup'), GrpcStatus.ALREADY_EXISTS],
    [new PermissionDeniedError('go away'), GrpcStatus.PERMISSION_DENIED],
    [new UnauthenticatedError('who?'), GrpcStatus.UNAUTHENTICATED],
    [new FailedPreconditionError('wrong state'), GrpcStatus.FAILED_PRECONDITION],
  ])('maps %p to the right gRPC code', async (err, expected) => {
    const mapped = await caught(filter, err);
    expect(code(mapped)).toBe(expected);
    expect(message(mapped)).toBe(err.message);
  });

  it('maps a ZodError to INVALID_ARGUMENT and lists issues', async () => {
    let zodErr: ZodError;
    try {
      z.object({ foo: z.string() }).parse({});
      throw new Error('expected zod to throw');
    } catch (err) {
      zodErr = err as ZodError;
    }
    const mapped = await caught(filter, zodErr);
    expect(code(mapped)).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(message(mapped)).toMatch(/Validation failed/);
    expect(message(mapped)).toMatch(/foo/);
  });

  it('maps a Mongoose ValidationError to INVALID_ARGUMENT', async () => {
    const mongooseErr = new mongoose.Error.ValidationError();
    mongooseErr.addError(
      'priceMinor',
      new mongoose.Error.ValidatorError({ path: 'priceMinor', message: 'min' }),
    );
    const mapped = await caught(filter, mongooseErr);
    expect(code(mapped)).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(message(mapped)).toMatch(/priceMinor/);
  });

  it('maps a Mongoose CastError to INVALID_ARGUMENT', async () => {
    const castErr = new mongoose.Error.CastError('ObjectId', 'nope', 'productId');
    const mapped = await caught(filter, castErr);
    expect(code(mapped)).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(message(mapped)).toMatch(/productId/);
  });

  it('maps a Mongo duplicate-key error (code 11000) to ALREADY_EXISTS', async () => {
    const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const mapped = await caught(filter, dup);
    expect(code(mapped)).toBe(GrpcStatus.ALREADY_EXISTS);
  });

  it('scrubs any other error to INTERNAL and logs the original', async () => {
    const mapped = await caught(filter, new Error('sensitive detail'));
    expect(code(mapped)).toBe(GrpcStatus.INTERNAL);
    expect(message(mapped)).toBe('Internal server error');
    expect(errorSpy).toHaveBeenCalled();
  });
});
