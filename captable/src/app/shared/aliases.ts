import "./api/zod-config.ts";
import type { MeResponse as MeResponseType } from "./api/auth.ts";
import { meResponseSchema } from "./api/auth.ts";
import type { AuthMethod as AuthMethodType, OrgAccess as OrgAccessType } from "./api/enums.ts";
import { authMethodSchema, orgAccessSchema } from "./api/enums.ts";
import type { ApiErrorBody as ApiErrorBodyType, ApiErrorCode as ApiErrorCodeType } from "./api/errors.ts";
import { apiErrorBodySchema, apiErrorCodeSchema } from "./api/errors.ts";

// The platform shell imports these names, each a schema and its type. They are the same
// objects as the `api` namespace's schemas, so there is one contract; new code uses `api.*`.

export const AuthMethod = authMethodSchema;
export type AuthMethod = AuthMethodType;

export const OrgAccess = orgAccessSchema;
export type OrgAccess = OrgAccessType;

export const ApiErrorCode = apiErrorCodeSchema;
export type ApiErrorCode = ApiErrorCodeType;

export const ApiErrorBody = apiErrorBodySchema;
export type ApiErrorBody = ApiErrorBodyType;

export const MeResponse = meResponseSchema;
export type MeResponse = MeResponseType;
