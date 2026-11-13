import * as NodeCrypto from "node:crypto";

import type { Connector } from "@beebot/contracts";
import {
  auth,
  discoverOAuthServerInfo,
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  type OAuthClientInformationMixed,
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  type OAuthTokens,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { type ConnectorStore, oauthName, urlProblem } from "./connectors.ts";
import type { Vault } from "./vault.ts";

export const oauthCallbackPath = "/connectors/oauth/callback";
const stateTtlMs = 10 * 60_000;
const refreshAheadMs = 60_000;
// Only a refresh reads it, and a refresh never sends anyone there.
const unusedRedirect = `http://127.0.0.1${oauthCallbackPath}`;

const clientMetadata = (redirectUrl: string) => ({
  client_name: "Bee Bot",
  redirect_uris: [redirectUrl],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
});

// The vault row `connector:<id>:oauth`. Bound to the URL it was issued for: read for any other URL,
// it is not there.
type Saved = {
  url: string;
  client?: OAuthClientInformationMixed | undefined;
  tokens?: OAuthTokens | undefined;
  expiresAt?: number | null | undefined;
};
const SavedRow = z.object({
  url: z.string(),
  client: z.unknown().optional(),
  tokens: z.unknown().optional(),
  expiresAt: z.number().nullable().optional(),
});

function parseSaved(text: string | undefined, url: string): Saved | undefined {
  let row;
  try {
    row = SavedRow.safeParse(JSON.parse(text ?? "")).data;
  } catch {
    return undefined;
  }
  if (!row || row.url !== url) {
    return undefined;
  }
  const client =
    OAuthClientInformationFullSchema.safeParse(row.client).data ??
    OAuthClientInformationSchema.safeParse(row.client).data;
  const tokens = OAuthTokensSchema.safeParse(row.tokens).data;
  return { url, client, tokens, expiresAt: row.expiresAt ?? null };
}

// What a connector result must never echo.
export function oauthSecretValues(text: string | undefined) {
  let row;
  try {
    row = SavedRow.safeParse(JSON.parse(text ?? "")).data;
  } catch {
    return [];
  }
  const tokens = OAuthTokensSchema.safeParse(row?.tokens).data;
  const client = OAuthClientInformationSchema.safeParse(row?.client).data;
  return [tokens?.access_token, tokens?.refresh_token, client?.client_secret].filter(
    (value): value is string => value !== undefined,
  );
}

const Revocation = z.object({ revocation_endpoint: z.string().optional() });

type Remote = Connector & { url: string };
const remote = (connector: Connector): connector is Remote =>
  connector.transport === "http" && connector.url !== null;

export function createConnectorOauth({
  connectors,
  vault,
  fetchFn,
  now = Date.now,
}: {
  connectors: ConnectorStore;
  vault: Vault;
  fetchFn: FetchLike;
  now?: (() => number) | undefined;
}) {
  const refreshing = new Map<string, Promise<string>>();

  const read = async (connector: Remote) =>
    parseSaved(await vault.get(oauthName(connector.id)), connector.url);
  const write = (id: string, saved: Saved) => vault.put(oauthName(id), JSON.stringify(saved));
  const withTokens = (saved: Saved, tokens: OAuthTokens): Saved => ({
    ...saved,
    // A server that doesn't rotate sends no new refresh token: the one we hold stays good.
    tokens: { ...tokens, refresh_token: tokens.refresh_token ?? saved.tokens?.refresh_token },
    expiresAt: tokens.expires_in === undefined ? null : now() + tokens.expires_in * 1000,
  });

  // Discovery (RFC 9728, RFC 8414), registration (RFC 7591) and the authorization URL with PKCE
  // S256 and `resource` (RFC 8707), all by the SDK. Undefined when the server can't register us.
  async function start(connector: Connector, redirectUrl: string) {
    if (!remote(connector)) {
      throw new Error("Only a remote server signs in.");
    }
    const { id, url } = connector;
    let saved: Saved = (await read(connector)) ?? { url };
    // A client we registered names this callback, and the port changes between launches.
    const registered = saved.client && "redirect_uris" in saved.client ? saved.client : undefined;
    if (registered && !registered.redirect_uris.includes(redirectUrl)) {
      saved = { url };
    }
    const state = NodeCrypto.randomBytes(32).toString("base64url");
    let authorizationUrl: URL | undefined;
    let codeVerifier = "";
    let discovered = false;
    const provider: OAuthClientProvider = {
      redirectUrl,
      clientMetadata: clientMetadata(redirectUrl),
      state: () => state,
      clientInformation: () => saved.client,
      saveClientInformation: async (client) => {
        saved = { url, client };
        await write(id, saved);
      },
      // A fresh sign-in, never a refresh: the owner asked to sign in.
      tokens: () => undefined,
      saveTokens: () => {},
      saveCodeVerifier: (verifier) => {
        codeVerifier = verifier;
      },
      codeVerifier: () => codeVerifier,
      redirectToAuthorization: (target) => {
        authorizationUrl = target;
      },
      saveDiscoveryState: () => {
        discovered = true;
      },
    };
    try {
      await auth(provider, { serverUrl: url, fetchFn });
    } catch (error) {
      if (discovered && !saved.client) {
        return undefined;
      }
      throw error;
    }
    if (!authorizationUrl || urlProblem(authorizationUrl.href)) {
      throw new Error("The server gave no usable sign-in page.");
    }
    connectors.saveOauthState({
      state,
      connectorId: id,
      url,
      codeVerifier,
      redirectUrl,
      ttlMs: stateTtlMs,
    });
    return authorizationUrl.href;
  }

  // The browser came back. The state row is gone before the code is exchanged.
  async function finish(state: string, code: string) {
    const pending = connectors.takeOauthState(state);
    const connector = pending && connectors.getConnector(pending.connectorId);
    if (!pending || !connector || !remote(connector) || connector.url !== pending.url) {
      return undefined;
    }
    let saved = await read(connector);
    if (!saved?.client) {
      return undefined;
    }
    const provider: OAuthClientProvider = {
      redirectUrl: pending.redirectUrl,
      clientMetadata: clientMetadata(pending.redirectUrl),
      clientInformation: () => saved?.client,
      saveClientInformation: (client) => {
        saved = { url: connector.url, ...saved, client };
      },
      tokens: () => undefined,
      saveTokens: async (tokens) => {
        saved = withTokens({ url: connector.url, client: saved?.client }, tokens);
        await write(connector.id, saved);
      },
      saveCodeVerifier: () => {},
      codeVerifier: () => pending.codeVerifier,
      redirectToAuthorization: () => {
        throw new UnauthorizedError("The sign-in didn't finish.");
      },
    };
    await auth(provider, { serverUrl: connector.url, authorizationCode: code, fetchFn });
    return connector;
  }

  async function refresh(connector: Remote) {
    let saved = await read(connector);
    if (!saved?.tokens?.refresh_token || !saved.client) {
      throw new UnauthorizedError("The sign-in ran out.");
    }
    // A sign-in server that is down is not a sign-in that ended. The SDK treats both alike.
    let down: string | undefined;
    const watched: FetchLike = async (input, init) => {
      try {
        const response = await fetchFn(input, init);
        if (response.status >= 500 || response.status === 429) {
          down = `HTTP ${response.status}`;
        }
        return response;
      } catch (error) {
        down = error instanceof Error ? error.message : "no answer";
        throw error;
      }
    };
    const provider: OAuthClientProvider = {
      redirectUrl: unusedRedirect,
      clientMetadata: clientMetadata(unusedRedirect),
      clientInformation: () => saved?.client,
      saveClientInformation: (client) => {
        saved = { url: connector.url, ...saved, client };
      },
      tokens: () => saved?.tokens,
      saveTokens: async (tokens) => {
        saved = withTokens(saved ?? { url: connector.url }, tokens);
        await write(connector.id, saved);
      },
      saveCodeVerifier: () => {},
      codeVerifier: () => "",
      redirectToAuthorization: () => {
        throw down
          ? new Error(`The sign-in server didn't answer (${down}).`)
          : new UnauthorizedError("The sign-in ran out.");
      },
      // A refresh token the server refused is dropped, so nothing tries it again.
      invalidateCredentials: async (scope) => {
        if (scope === "tokens" || scope === "all") {
          saved = { url: connector.url, client: scope === "tokens" ? saved?.client : undefined };
          await write(connector.id, saved);
        }
      },
    };
    await auth(provider, { serverUrl: connector.url, fetchFn: watched });
    const token = saved?.tokens?.access_token;
    if (!token) {
      throw new UnauthorizedError("The sign-in ran out.");
    }
    return token;
  }

  // One refresh per connector at a time: a rotated refresh token works once.
  function refreshOnce(connector: Remote) {
    let running = refreshing.get(connector.id);
    if (!running) {
      running = refresh(connector).finally(() => refreshing.delete(connector.id));
      refreshing.set(connector.id, running);
    }
    return running;
  }

  return {
    start,
    finish,

    // A token for this URL, refreshed a minute before it runs out.
    accessToken: async (connector: Connector) => {
      if (!remote(connector)) {
        throw new UnauthorizedError("Not signed in.");
      }
      const saved = await read(connector);
      if (!saved?.tokens) {
        throw new UnauthorizedError("Not signed in.");
      }
      if (saved.expiresAt != null && saved.expiresAt - refreshAheadMs <= now()) {
        return refreshOnce(connector);
      }
      return saved.tokens.access_token;
    },

    // A client the owner made in the app's developer settings. Tokens from another client go.
    saveClient: async (connector: Connector, clientId: string, clientSecret?: string) => {
      if (!remote(connector)) {
        return;
      }
      const client = { client_id: clientId, ...(clientSecret && { client_secret: clientSecret }) };
      await write(connector.id, { url: connector.url, client });
    },

    // RFC 7009, which the SDK has no client for. Best effort: the vault rows go either way.
    revoke: async (connector: Connector) => {
      const saved = remote(connector) ? await read(connector) : undefined;
      if (!remote(connector) || !saved?.tokens || !saved.client) {
        return;
      }
      try {
        const info = await discoverOAuthServerInfo(connector.url, { fetchFn });
        const endpoint = Revocation.safeParse(info.authorizationServerMetadata).data
          ?.revocation_endpoint;
        if (!endpoint) {
          return;
        }
        const { client_id, client_secret } = saved.client;
        const tokens = [
          [saved.tokens.refresh_token, "refresh_token"],
          [saved.tokens.access_token, "access_token"],
        ] as const;
        for (const [token, hint] of tokens) {
          if (token) {
            const body = new URLSearchParams({ token, token_type_hint: hint, client_id });
            if (client_secret) {
              body.set("client_secret", client_secret);
            }
            const headers = { "Content-Type": "application/x-www-form-urlencoded" };
            await fetchFn(endpoint, { method: "POST", headers, body });
          }
        }
      } catch {
        // The server keeps a token we no longer hold; it runs out on its own.
      }
    },
  };
}

export type ConnectorOauth = ReturnType<typeof createConnectorOauth>;
