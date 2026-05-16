import type { AccessControl, Identity } from "./types.js";
import { CallError, InfrastructureErrorCode } from "./error.js";

export function checkAccess(accessControl: AccessControl, identity: Identity): boolean {
  const { requiredScopes, requiredScopesAny, resourceType, resourceAction } = accessControl;

  if (requiredScopes.length > 0) {
    const hasAll = requiredScopes.every((scope: string) => identity.scopes.includes(scope));
    if (!hasAll) return false;
  }

  if (requiredScopesAny && requiredScopesAny.length > 0) {
    const hasAny = requiredScopesAny.some((scope: string) => identity.scopes.includes(scope));
    if (!hasAny) return false;
  }

  if (resourceType && resourceAction) {
    if (!identity.resources) return false;
    for (const [key, actions] of Object.entries(identity.resources)) {
      if (key.startsWith(`${resourceType}:`) && actions.includes(resourceAction)) {
        return true;
      }
    }
    return false;
  }

  return true;
}

export function enforceAccess(
  accessControl: AccessControl,
  identity: Identity | undefined,
  operationId: string,
  trusted?: boolean,
): void {
  if (trusted) return;

  if (accessControl.requiredScopes.length > 0 || accessControl.requiredScopesAny?.length || accessControl.resourceType) {
    if (!identity) {
      throw new CallError(
        InfrastructureErrorCode.ACCESS_DENIED,
        `Access denied for operation: ${operationId} — identity required`,
        { operationId, requiredScopes: accessControl.requiredScopes },
      );
    }
    if (!checkAccess(accessControl, identity)) {
      throw new CallError(
        InfrastructureErrorCode.ACCESS_DENIED,
        `Access denied for operation: ${operationId}`,
        { requiredScopes: accessControl.requiredScopes },
      );
    }
  }
}