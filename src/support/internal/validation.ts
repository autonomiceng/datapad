import { FormatRegistry, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Temporal } from "@js-temporal/polyfill";
import { AccountPaginationSchema } from "../../access/contract";
import type { AccountPagination } from "../../access/contract";
// Domain validation must also work without HTTP composition registering formats.
if (!FormatRegistry.Has("uuid"))
  FormatRegistry.Set("uuid", (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
  );
if (!FormatRegistry.Has("date-time"))
  FormatRegistry.Set("date-time", (value) => {
    try {
      Temporal.Instant.from(value);
      return true;
    } catch {
      return false;
    }
  });
const id = Type.String({ format: "uuid" });
export const validId = (value: string) => Value.Check(id, value);
export function pagination(
  input: Partial<AccountPagination> = {},
): AccountPagination | null {
  const page = { limit: 50, offset: 0, ...input };
  return Value.Check(AccountPaginationSchema, page) ? page : null;
}
