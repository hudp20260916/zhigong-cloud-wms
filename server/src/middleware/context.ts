import type { Permission, Role } from '../../../shared/permissions.js';
import { permissionsOf } from '../../../shared/permissions.js';

export interface RequestCtx {
  userId: number;
  username: string;
  displayName: string;
  role: Role;
  permissions: Permission[];
  sessionVersion: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: RequestCtx;
    }
  }
}

export function buildCtx(user: {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  session_version: number;
}): RequestCtx {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    permissions: permissionsOf(user.role),
    sessionVersion: user.session_version,
  };
}

export function canViewPrice(ctx: RequestCtx): boolean {
  return ctx.permissions.includes('price.view');
}

export function canExport(ctx: RequestCtx): boolean {
  return ctx.permissions.includes('export.data');
}
