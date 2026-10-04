import type { Metadata } from '@grpc/grpc-js';
import { PermissionDeniedError, UnauthenticatedError } from '../common/errors/domain-errors';

export const ROLES = ['CUSTOMER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export interface Identity {
  userId: string;
  role: Role;
  requestId?: string;
}

// The gateway is the only trusted origin for these headers — the private Docker
// network is the trust boundary (architecture §2, D5). Services do not re-verify
// the JWT; they read identity from metadata forwarded by the gateway.
const HEADER_USER_ID = 'x-user-id';
const HEADER_USER_ROLE = 'x-user-role';
const HEADER_REQUEST_ID = 'x-request-id';

function firstValue(metadata: Metadata | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  const values = metadata.get(key);
  if (!values || values.length === 0) return undefined;
  const raw = values[0];
  return typeof raw === 'string' ? raw : raw.toString('utf8');
}

export function readIdentity(metadata: Metadata | undefined): Identity {
  const userId = firstValue(metadata, HEADER_USER_ID);
  const roleRaw = firstValue(metadata, HEADER_USER_ROLE);

  if (!userId || !roleRaw) {
    throw new UnauthenticatedError('Missing identity metadata');
  }

  const role = normaliseRole(roleRaw);
  if (!role) {
    throw new UnauthenticatedError(`Unknown role: ${roleRaw}`);
  }

  return {
    userId,
    role,
    requestId: firstValue(metadata, HEADER_REQUEST_ID),
  };
}

// Reads the request id without insisting on identity. Read RPCs are anonymous
// (products browse is public at the gateway), so the correlation id is still
// useful for logging even when no user is attached.
export function readRequestId(metadata: Metadata | undefined): string | undefined {
  return firstValue(metadata, HEADER_REQUEST_ID);
}

// The gateway may forward the role in either its canonical form
// (`CUSTOMER`/`ADMIN`) or the proto form (`ROLE_CUSTOMER`/`ROLE_ADMIN`). Accept
// both, canonicalise to the plain form.
function normaliseRole(value: string): Role | undefined {
  const upper = value.trim().toUpperCase();
  if (upper === 'CUSTOMER' || upper === 'ROLE_CUSTOMER') return 'CUSTOMER';
  if (upper === 'ADMIN' || upper === 'ROLE_ADMIN') return 'ADMIN';
  return undefined;
}

export function requireAdmin(identity: Identity): void {
  if (identity.role !== 'ADMIN') {
    throw new PermissionDeniedError('Admin role required');
  }
}
