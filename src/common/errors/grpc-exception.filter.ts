import { ArgumentsHost, Catch, Logger, RpcExceptionFilter } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Error as MongooseError } from 'mongoose';
import { ZodError } from 'zod';
import { Observable, throwError } from 'rxjs';
import { DomainError, DomainErrorKind } from './domain-errors';

// Edge filter that turns whatever the domain throws into a gRPC status the
// gateway can act on. Bound to the ProductController with `@UseFilters` — not
// registered globally, same reason as user-service: a global catch-all would
// also swallow HTTP exceptions from `/health` and the Express adapter would
// hang on the resulting Observable.
//
// Mapping table (single source of truth):
//   RpcException                   → passthrough (already carries its code)
//   DomainError                    → kind → gRPC code (see kindToStatus)
//   ZodError                       → INVALID_ARGUMENT
//   Mongoose ValidationError       → INVALID_ARGUMENT (field-level reasons kept)
//   Mongoose CastError             → INVALID_ARGUMENT (e.g. bad ObjectId cast)
//   Mongo duplicate key (E11000)   → ALREADY_EXISTS
//   anything else                  → INTERNAL, message scrubbed, logged

const kindToStatus: Record<DomainErrorKind, number> = {
  INVALID_ARGUMENT: GrpcStatus.INVALID_ARGUMENT,
  NOT_FOUND: GrpcStatus.NOT_FOUND,
  ALREADY_EXISTS: GrpcStatus.ALREADY_EXISTS,
  PERMISSION_DENIED: GrpcStatus.PERMISSION_DENIED,
  UNAUTHENTICATED: GrpcStatus.UNAUTHENTICATED,
  FAILED_PRECONDITION: GrpcStatus.FAILED_PRECONDITION,
};

@Catch()
export class GrpcExceptionFilter implements RpcExceptionFilter {
  private readonly logger = new Logger(GrpcExceptionFilter.name);

  catch(exception: unknown, _host: ArgumentsHost): Observable<never> {
    return throwError(() => this.toRpcException(exception));
  }

  private toRpcException(exception: unknown): RpcException {
    if (exception instanceof RpcException) {
      return exception;
    }
    if (exception instanceof DomainError) {
      return new RpcException({
        code: kindToStatus[exception.kind],
        message: exception.message,
      });
    }
    if (exception instanceof ZodError) {
      const message = exception.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      return new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: `Validation failed: ${message}`,
      });
    }
    if (exception instanceof MongooseError.ValidationError) {
      const message = Object.entries(exception.errors)
        .map(([path, err]) => `${path}: ${(err as Error).message}`)
        .join('; ');
      return new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: `Validation failed: ${message}`,
      });
    }
    if (exception instanceof MongooseError.CastError) {
      // e.g. an id that cannot be cast to ObjectId. Surface as INVALID_ARGUMENT
      // rather than letting it reach the unknown-error branch.
      return new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: `Invalid value for ${exception.path}`,
      });
    }
    if (isDuplicateKeyError(exception)) {
      return new RpcException({
        code: GrpcStatus.ALREADY_EXISTS,
        message: 'Value already exists for a unique field',
      });
    }
    this.logger.error(
      { err: exception },
      'Unhandled exception in gRPC handler; returning INTERNAL',
    );
    return new RpcException({
      code: GrpcStatus.INTERNAL,
      message: 'Internal server error',
    });
  }
}

// Mongo duplicate-key errors come from the driver (not Mongoose) with `code:
// 11000` on a plain-ish object; the driver class isn't a stable `instanceof`
// target across versions, so we check the shape.
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}
