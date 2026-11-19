import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { DBAdapter, DBTransactionAdapter, Where } from "better-auth/adapters";
import { getAdapter } from "better-auth/db/adapter";
import { getMigrations } from "better-auth/db/migration";

import { log } from "./log.ts";

export const sessionCookie = "__Host-beebot.session_token";

const sha256 = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(String(value)).digest("base64url");

const hashTokenWhere = (where: Where[] | undefined) =>
  where?.map((clause) =>
    clause.field === "token"
      ? {
          ...clause,
          value: Array.isArray(clause.value) ? clause.value.map(sha256) : sha256(clause.value),
        }
      : clause,
  );

// A row found by its token goes back with that token, which Better Auth signs into the cookie.
function withRawToken(row: unknown, where: Where[] | undefined) {
  const presented = [where?.find((clause) => clause.field === "token")?.value ?? []].flat();
  const stored = (row as { token?: unknown } | null)?.token;
  const raw =
    stored === undefined ? undefined : presented.find((value) => sha256(value) === stored);
  return raw === undefined ? row : { ...(row as object), token: raw };
}

const lookups = [
  "findOne",
  "findMany",
  "update",
  "updateMany",
  "count",
  "delete",
  "deleteMany",
  "consumeOne",
  "incrementOne",
] as const;

type Lookup = (args: { model: string; where?: Where[] | undefined }) => Promise<unknown>;

// Better Auth stores session tokens as issued. Here the database only ever sees their SHA-256, so
// a copy of it signs nobody in.
export function hashSessionTokens<A extends DBTransactionAdapter>(adapter: A): A {
  const wrapped: Record<string, unknown> = { ...adapter };
  for (const method of lookups) {
    const original = adapter[method] as Lookup;
    wrapped[method] = async (args: Parameters<Lookup>[0]) => {
      if (args.model !== "session") {
        return original(args);
      }
      const result = await original({ ...args, where: hashTokenWhere(args.where) });
      return Array.isArray(result)
        ? result.map((row) => withRawToken(row, args.where))
        : withRawToken(result, args.where);
    };
  }
  wrapped.create = async (args: { model: string; data: { token?: unknown } }) => {
    if (args.model !== "session") {
      return adapter.create(args);
    }
    const { token } = args.data;
    const row = await adapter.create({ ...args, data: { ...args.data, token: sha256(token) } });
    return { ...row, token };
  };
  if ("transaction" in adapter) {
    const { transaction } = adapter as unknown as DBAdapter;
    wrapped.transaction = (callback: (trx: DBTransactionAdapter) => Promise<unknown>) =>
      transaction((trx) => callback(hashSessionTokens(trx)));
  }
  return wrapped as A;
}

export async function createAuth(
  db: DatabaseSync,
  { secret, origin }: { secret: string; origin: string },
) {
  const options = {
    appName: "Bee Bot",
    secret,
    baseURL: origin,
    trustedOrigins: [origin],
    telemetry: { enabled: false },
    logger: { log: (level, msg) => log(level, msg) },
    // Accepting an invite creates the account through the internal adapter; no route signs up.
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: { expiresIn: 30 * 24 * 60 * 60 },
    rateLimit: { enabled: true },
    advanced: {
      // __Host- means Secure, Path=/ and no Domain. Behind Caddy every request is HTTPS.
      useSecureCookies: false,
      cookiePrefix: "__Host-beebot",
      defaultCookieAttributes: { secure: true },
    },
  } satisfies BetterAuthOptions;
  const direct = { ...options, database: db };
  await (await getMigrations(direct)).runMigrations();
  const adapter = await getAdapter(direct);
  return betterAuth({ ...options, database: () => hashSessionTokens(adapter) });
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;

export async function passwordProblem(auth: Auth, password: string) {
  const { minPasswordLength, maxPasswordLength } = (await auth.$context).password.config;
  return password.length < minPasswordLength || password.length > maxPasswordLength
    ? `Use a password of ${minPasswordLength} to ${maxPasswordLength} characters.`
    : undefined;
}

export async function createPasswordUser(auth: Auth, email: string, password: string) {
  const context = await auth.$context;
  const hash = await context.password.hash(password);
  const user = await context.internalAdapter.createUser(
    { email, name: email, emailVerified: true },
    { method: "email-password" },
  );
  await context.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: hash,
  });
  return user;
}
