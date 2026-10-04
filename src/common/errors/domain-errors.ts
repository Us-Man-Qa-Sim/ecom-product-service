// Transport-neutral domain errors (same pattern as user-service USR-9).
//
// Services throw these — `NotFoundError`, `ConflictError`, … — instead of
// `RpcException`. `GrpcExceptionFilter` translates them to gRPC status codes at
// the edge; nothing under the service layer imports `@grpc/grpc-js`.
//
// Messages are safe to expose to callers: the domain is responsible for keeping
// them PII-free. Untyped Errors are scrubbed to `Internal server error` by the
// filter.

export type DomainErrorKind =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PERMISSION_DENIED'
  | 'UNAUTHENTICATED'
  | 'FAILED_PRECONDITION';

export abstract class DomainError extends Error {
  abstract readonly kind: DomainErrorKind;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly kind = 'INVALID_ARGUMENT';
}

export class NotFoundError extends DomainError {
  readonly kind = 'NOT_FOUND';
}

export class ConflictError extends DomainError {
  readonly kind = 'ALREADY_EXISTS';
}

export class PermissionDeniedError extends DomainError {
  readonly kind = 'PERMISSION_DENIED';
}

export class UnauthenticatedError extends DomainError {
  readonly kind = 'UNAUTHENTICATED';
}

export class FailedPreconditionError extends DomainError {
  readonly kind = 'FAILED_PRECONDITION';
}
