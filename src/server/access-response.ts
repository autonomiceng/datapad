import { status } from "elysia";
import { AccessErrorSchema } from "../access/contract";
import type { AccessResult } from "../access/types";

export const accessErrorResponses = {
  401: AccessErrorSchema,
  403: AccessErrorSchema,
  404: AccessErrorSchema,
  409: AccessErrorSchema,
  422: AccessErrorSchema,
  503: AccessErrorSchema,
};

export const accessErrorStatus = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_request: 422,
  unavailable: 503,
} as const;

export const accessResponse = <T>(result: AccessResult<T>) =>
  result.ok
    ? result.value
    : status(accessErrorStatus[result.code], { code: result.code });
