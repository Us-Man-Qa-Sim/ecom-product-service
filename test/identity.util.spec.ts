import { Metadata } from '@grpc/grpc-js';
import {
  readIdentity,
  readRequestId,
  requireAdmin,
  type Identity,
} from '../src/identity/identity.util';
import { PermissionDeniedError, UnauthenticatedError } from '../src/common/errors/domain-errors';

function md(entries: Record<string, string>): Metadata {
  const meta = new Metadata();
  for (const [k, v] of Object.entries(entries)) meta.set(k, v);
  return meta;
}

describe('readIdentity', () => {
  it('parses user id, role, and request id', () => {
    const identity = readIdentity(
      md({
        'x-user-id': 'user-1',
        'x-user-role': 'CUSTOMER',
        'x-request-id': 'req-1',
      }),
    );
    expect(identity).toEqual({ userId: 'user-1', role: 'CUSTOMER', requestId: 'req-1' });
  });

  it('accepts the proto-form role prefix', () => {
    const identity = readIdentity(md({ 'x-user-id': 'user-1', 'x-user-role': 'ROLE_ADMIN' }));
    expect(identity.role).toBe('ADMIN');
  });

  it.each([
    ['no metadata at all', undefined as unknown as Metadata],
    ['missing both headers', md({})],
    ['missing user id', md({ 'x-user-role': 'ADMIN' })],
    ['missing role', md({ 'x-user-id': 'user-1' })],
  ])('throws Unauthenticated when %s', (_label, metadata) => {
    expect(() => readIdentity(metadata)).toThrow(UnauthenticatedError);
  });

  it('rejects an unrecognised role', () => {
    expect(() => readIdentity(md({ 'x-user-id': 'user-1', 'x-user-role': 'ROOT' }))).toThrow(
      UnauthenticatedError,
    );
  });

  it('leaves requestId undefined when the header is absent', () => {
    const identity = readIdentity(md({ 'x-user-id': 'user-1', 'x-user-role': 'ADMIN' }));
    expect(identity.requestId).toBeUndefined();
  });
});

describe('readRequestId', () => {
  it('returns the forwarded request id', () => {
    expect(readRequestId(md({ 'x-request-id': 'req-42' }))).toBe('req-42');
  });

  it('is undefined when the header is absent', () => {
    expect(readRequestId(md({}))).toBeUndefined();
    expect(readRequestId(undefined)).toBeUndefined();
  });
});

describe('requireAdmin', () => {
  const customer: Identity = { userId: 'u1', role: 'CUSTOMER' };
  const admin: Identity = { userId: 'u2', role: 'ADMIN' };

  it('allows an admin', () => {
    expect(() => requireAdmin(admin)).not.toThrow();
  });

  it('rejects a non-admin', () => {
    expect(() => requireAdmin(customer)).toThrow(PermissionDeniedError);
  });
});
