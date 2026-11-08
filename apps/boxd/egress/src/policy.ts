import * as NodeNet from "node:net";

export type Vendor = "anthropic" | "openai";

export const vendors: readonly Vendor[] = ["anthropic", "openai"];

export const vendorApi: Record<
  Vendor,
  { host: string; header: (key: string) => [string, string] }
> = {
  anthropic: { host: "api.anthropic.com", header: (key) => ["x-api-key", key] },
  openai: { host: "api.openai.com", header: (key) => ["authorization", `Bearer ${key}`] },
};

// On the subscription lane the CLI in the box holds its own login and talks to its vendor
// directly, as a plain tunnel with nothing added. Claude Code 2.1.319 exchanges, refreshes and
// revokes its OAuth token at platform.claude.com and reads the profile at api.anthropic.com (its
// bundled TOKEN_URL and BASE_API_URL; code.claude.com/docs/en/network-config). The sign-in pages
// open in the owner's own browser. The OpenAI login hosts are unproven. No GitHub host.
export const subscriptionHosts: Record<Vendor, string[]> = {
  anthropic: ["api.anthropic.com", "platform.claude.com"],
  openai: ["api.openai.com", "auth.openai.com", "chatgpt.com"],
};

const vendorHosts = new Set(Object.values(subscriptionHosts).flat());

// What a bot may CONNECT to. Vendor hosts come only from the subscription lane, never from the
// owner's list: on the API lane the vendor is reached through the key-injecting lane alone, so an
// unauthenticated tunnel can't carry another credential past it.
export function connectHosts(granted: readonly string[], subscription: Vendor | null) {
  return [
    ...new Set([
      ...(subscription === null ? [] : subscriptionHosts[subscription]),
      ...granted.filter((host) => !vendorHosts.has(host)),
    ]),
  ];
}

export type Decision<T> = ({ allow: true } & T) | { allow: false; reason: string };

const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

// A DNS name in plain ASCII, lowercased and without the root dot. IP literals, numeric last
// labels (`0x7f.1`), userinfo, ports, percent escapes and non-ASCII are not names.
export function normalizeHost(raw: string) {
  const host = raw.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  const last = labels.at(-1) ?? "";
  if (host.length > 253 || labels.length < 2 || !labels.every((part) => label.test(part))) {
    return null;
  }
  return NodeNet.isIP(host) !== 0 || /^[0-9]+$/.test(last) ? null : host;
}

// Exact names only: a suffix or prefix of an allowed name is a different host.
export function hostAllowed(allow: readonly string[], raw: string) {
  const host = normalizeHost(raw);
  return host !== null && allow.includes(host);
}

export function decideConnect(
  allow: readonly string[],
  authority: string,
): Decision<{ host: string; port: number }> {
  const match = /^(\[[^\]]*\]|[^:[\]]+):([0-9]{1,5})$/.exec(authority);
  if (!match) {
    return { allow: false, reason: "bad target" };
  }
  const [, rawHost = "", rawPort = ""] = match;
  if (Number(rawPort) !== 443) {
    return { allow: false, reason: "port not 443" };
  }
  if (rawHost.startsWith("[") || NodeNet.isIP(rawHost) !== 0) {
    return { allow: false, reason: "IP literal" };
  }
  const host = normalizeHost(rawHost);
  if (host === null) {
    return { allow: false, reason: "bad host" };
  }
  return allow.includes(host)
    ? { allow: true, host, port: 443 }
    : { allow: false, reason: "host not allowlisted" };
}

const v4Denied: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

// Inside global unicast 2000::/3: IETF protocol space (Teredo among it), documentation, and 6to4,
// which embeds any IPv4 address.
const v6Denied: [string, number][] = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
];

function v4Bits(ip: string) {
  return BigInt(ip.split(".").reduce((value, octet) => value * 256 + Number(octet), 0) >>> 0);
}

function v6Bits(ip: string) {
  const [head = "", tail] = ip.split("::");
  const groups = (part: string) => {
    const pieces = part === "" ? [] : part.split(":");
    const last = pieces.at(-1);
    if (last?.includes(".")) {
      const bits = v4Bits(last);
      pieces.splice(-1, 1, (bits >> 16n).toString(16), (bits & 0xffffn).toString(16));
    }
    return pieces;
  };
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const all = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return all.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

const inRange = (bits: bigint, width: number, base: bigint, prefix: number) =>
  bits >> BigInt(width - prefix) === base >> BigInt(width - prefix);

// SSRF ranges, checked on the address the proxy is about to connect to. Anything it cannot parse
// counts as denied. IPv4-mapped IPv6 is judged as the IPv4 address it carries; every other IPv6
// address outside global unicast is denied, which covers loopback, IPv4-compatible, NAT64,
// unique-local, link-local, site-local and multicast.
export function isDeniedAddress(raw: string) {
  const ip = raw.replace(/%.*$/, "");
  if (NodeNet.isIPv4(ip)) {
    const bits = v4Bits(ip);
    return v4Denied.some(([base, prefix]) => inRange(bits, 32, v4Bits(base), prefix));
  }
  if (!NodeNet.isIPv6(ip)) {
    return true;
  }
  const bits = v6Bits(ip);
  if (bits >> 32n === 0xffffn) {
    return isDeniedAddress(
      [24n, 16n, 8n, 0n].map((shift) => ((bits >> shift) & 0xffn).toString()).join("."),
    );
  }
  if (!inRange(bits, 128, v6Bits("2000::"), 3)) {
    return true;
  }
  return v6Denied.some(([base, prefix]) => inRange(bits, 128, v6Bits(base), prefix));
}

// One denied address refuses the name: a resolver that mixes in a private address is hostile.
export function decideResolved(addresses: readonly string[]): Decision<{ address: string }> {
  if (addresses.length === 0) {
    return { allow: false, reason: "no address" };
  }
  if (addresses.some(isDeniedAddress)) {
    return { allow: false, reason: "resolved to denied range" };
  }
  const address = addresses.find((candidate) => NodeNet.isIPv4(candidate)) ?? addresses[0] ?? "";
  return { allow: true, address };
}

// The upstream URL for an API-lane request. The path is appended to the vendor's fixed origin as
// text: `new URL(path, origin)` would read `//evil.example/` as another host and carry the key
// there.
export function apiTarget(vendor: Vendor, rawPath: string) {
  const prefix = `/${vendor}/`;
  if (!rawPath.startsWith(prefix)) {
    return null;
  }
  const rest = rawPath.slice(prefix.length);
  if (rest === "" || rest.startsWith("/") || rest.includes("\\")) {
    return null;
  }
  const origin = `https://${vendorApi[vendor].host}`;
  try {
    const url = new URL(`${origin}/${rest}`);
    return url.origin === origin && url.username === "" && url.password === "" ? url : null;
  } catch {
    return null;
  }
}

// The only place a key becomes a header, and only for the vendor's own API host over HTTPS.
export function keyHeader(vendor: Vendor, url: URL, key: string) {
  const api = vendorApi[vendor];
  const exact =
    url.protocol === "https:" &&
    url.hostname === api.host &&
    url.port === "" &&
    url.username === "" &&
    url.password === "";
  return exact && key !== "" ? api.header(key) : null;
}
