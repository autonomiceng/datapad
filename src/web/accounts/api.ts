import { useRef } from "react";
import { v4 as randomUUID } from "uuid";
import { useQuery } from "@tanstack/react-query";
import type { AccessSessionResponse } from "../../access/contract";

export class AccountError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? "Your session has ended. Sign in to continue."
        : status === 403
          ? "You do not have permission for this action."
          : status === 404
            ? "This account or invitation is unavailable."
            : status === 409
              ? "This conflicts with a recent change to the account. Reload and review before trying again."
              : status === 400 || status === 422
                ? "Check the entered details and try again."
                : status === 429
                  ? "Too many attempts. Wait a minute and try again."
                  : "The request could not be confirmed. You can retry the same action.",
    );
  }
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  try {
    const response = await fetch(path, {
      ...options,
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) throw new AccountError(response.status);
    return await response.json();
  } catch (error) {
    if (
      error instanceof AccountError ||
      options.signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      throw error;
    throw new AccountError(0);
  }
}

export function command<T>(path: string, body: unknown, method = "POST") {
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Resolves to null when the running composition has no customer accounts. */
export function useSession() {
  return useQuery({
    queryKey: ["access-session"],
    queryFn: async ({ signal }) => {
      try {
        return await request<AccessSessionResponse>("/api/access/session", {
          signal,
        });
      } catch (error) {
        if (error instanceof AccountError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 0,
  });
}

/** Keeps one request ID for identical input so uncertain retries reconcile. */
export function useRequestId() {
  const identity = useRef<{ input: string; id: string } | null>(null);
  return {
    get: (input: unknown) => {
      const serialized = JSON.stringify(input);
      if (identity.current?.input !== serialized) {
        identity.current = { input: serialized, id: randomUUID() };
      }
      return identity.current.id;
    },
    reset: () => {
      identity.current = null;
    },
  };
}
