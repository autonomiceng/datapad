import { betterAuth } from "better-auth";
import { organization, magicLink } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { AuthenticationGateway } from "./types";
import * as schema from "./internal/auth-schema";

export interface AuthenticationOptions {
  pool: Pool;
  baseURL: string;
  secret: string;
  synthetic: true;
  allowedEmails: readonly string[];
  sendMagicLink: (message: { email: string; url: string }) => Promise<void>;
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string; clientSecret: string; tenantId: string };
}
export function createAuthentication(options: AuthenticationOptions): {
  gateway: AuthenticationGateway;
  handler: (request: Request) => Promise<Response>;
} {
  if (options.synthetic !== true || options.secret.length < 32)
    throw new Error(
      "Explicit synthetic authentication and a strong secret are required",
    );
  const origin = new URL(options.baseURL).origin;
  const allowed = new Set(
    options.allowedEmails.map((email) => email.toLowerCase()),
  );
  const auth = betterAuth({
    baseURL: options.baseURL,
    basePath: "/api/auth",
    secret: options.secret,
    trustedOrigins: [origin],
    database: drizzleAdapter(drizzle(options.pool), {
      provider: "pg",
      schema,
      transaction: true,
    }),
    account: {
      encryptOAuthTokens: true,
      accountLinking: { disableImplicitLinking: true },
    },
    session: { cookieCache: { enabled: false } },
    socialProviders: {
      ...(options.google ? { google: options.google } : {}),
      ...(options.microsoft ? { microsoft: options.microsoft } : {}),
    },
    databaseHooks: {
      account: {
        create: {
          before: async (account) => ({ data: { ...account, idToken: null } }),
        },
        update: {
          before: async (account) => ({ data: { ...account, idToken: null } }),
        },
      },
      user: {
        create: {
          before: async (user) => {
            if (!allowed.has(user.email.toLowerCase())) return false;
            return { data: user };
          },
        },
      },
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        requireEmailVerificationOnInvitation: true,
      }),
      magicLink({
        disableSignUp: true,
        storeToken: "hashed",
        // The isolated demo shares one local address across sample accounts.
        rateLimit: { window: 60, max: 30 },
        sendMagicLink: async ({ email, url }) => {
          if (allowed.has(email.toLowerCase()))
            await options.sendMagicLink({ email, url });
        },
      }),
    ],
  });
  return {
    gateway: {
      async getSession(headers) {
        const result = await auth.api.getSession({
          headers,
          query: { disableCookieCache: true },
        });
        return result
          ? {
              actor: { userId: result.user.id, sessionId: result.session.id },
              user: {
                name: result.user.name,
                email: result.user.email,
                emailVerified: result.user.emailVerified,
              },
              expiresAt: result.session.expiresAt.toISOString(),
            }
          : null;
      },
      async acceptInvitation(headers, invitationId) {
        const result = await auth.api.acceptInvitation({
          headers,
          body: { invitationId },
        });
        return {
          organizationId: result.member.organizationId,
          memberId: result.member.id,
        };
      },
    },
    async handler(request) {
      const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
      const permitted =
        (request.method === "GET" &&
          (path === "/get-session" ||
            path === "/magic-link/verify" ||
            (options.google && path === "/callback/google") ||
            (options.microsoft && path === "/callback/microsoft"))) ||
        (request.method === "POST" &&
          (path === "/sign-in/magic-link" ||
            path === "/sign-out" ||
            ((options.google || options.microsoft) &&
              path === "/sign-in/social")));
      if (!permitted)
        return Response.json(
          { code: "not_found" },
          { status: 404, headers: { "cache-control": "no-store" } },
        );
      if (request.method === "POST" && request.headers.get("origin") !== origin)
        return Response.json(
          { code: "forbidden" },
          { status: 403, headers: { "cache-control": "no-store" } },
        );
      const response = await auth.handler(request);
      response.headers.set("cache-control", "no-store");
      return response;
    },
  };
}
