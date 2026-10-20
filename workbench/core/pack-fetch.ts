// Fetching a component pack from a URL.
//
// This is the project's first path that reaches out to the network on its own,
// so it is deliberately narrow: https only, no address that could reach this
// machine or a private network, every redirect hop checked again, a short
// timeout, a hard cap on the body and a JSON content type. A pack is data;
// the fetcher must not become a way to read the machine it runs on.
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { MAX_MANIFEST_BYTES } from "./packs.ts";

export const PACK_FETCH_TIMEOUT_MS = 5000;
export const MAX_REDIRECTS = 5;

export type PackResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

export type PackHttpClient = (
  url: string,
  signal: AbortSignal,
) => Promise<PackResponse>;

function describeIpv4(ip: string): string | null {
  const parts = ip.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  )
    return "一个非法地址";
  const [a, b] = parts;
  if (a === 127) return "回环地址";
  if (a === 10) return "私有网段";
  if (a === 172 && b >= 16 && b <= 31) return "私有网段";
  if (a === 192 && b === 168) return "私有网段";
  if (a === 169 && b === 254) return "链路本地地址";
  if (a === 0) return "保留地址";
  return null;
}

function expandIpv6(ip: string): number[] | null {
  let text = ip.trim();
  const embedded = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  let tail: string[] = [];
  if (embedded) {
    const octets = embedded[1].split(".").map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
      return null;
    tail = [
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16),
    ];
    text = text.slice(0, embedded.index);
    if (text.endsWith(":")) text = text.slice(0, -1);
  }
  const double = text.indexOf("::");
  let groups: string[];
  if (double >= 0) {
    if (text.indexOf("::", double + 1) >= 0) return null;
    const left = text.slice(0, double);
    const right = text.slice(double + 2);
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const fill = 8 - leftGroups.length - rightGroups.length - tail.length;
    if (fill < 0) return null;
    groups = [...leftGroups, ...new Array(fill).fill("0"), ...rightGroups, ...tail];
  } else groups = [...text.split(":"), ...tail];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push((value >> 8) & 255, value & 255);
  }
  return bytes;
}

function describeIpv6(ip: string): string | null {
  const bytes = expandIpv6(ip);
  if (!bytes) return "一个非法地址";
  if (bytes.every((b) => b === 0)) return "未指定地址";
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1)
    return "回环地址";
  if ((bytes[0] & 0xfe) === 0xfc) return "私有网段";
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80)
    return "链路本地地址";
  if (bytes.slice(0, 12).every((b) => b === 0))
    return describeIpv4(bytes.slice(12).join("."));
  return null;
}

/** Why this address must not be reached, or null when it is fine. */
export function describeAddress(address: string): string | null {
  const kind = isIP(address);
  if (kind === 4) return describeIpv4(address);
  if (kind === 6) return describeIpv6(address);
  return null;
}

/** Scheme and literal-address checks. Host names are checked by
 * `assertPublicHost`, which resolves them first. */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Error("取件失败：这不是一个合法的网址。");
  }
  if (url.protocol !== "https:")
    throw Error("取件失败：只允许 https:// 链接。");
  if (!url.hostname) throw Error("取件失败：链接里没有主机名。");
  const reason = describeAddress(url.hostname.replace(/^\[|\]$/g, ""));
  if (reason)
    throw Error(`取件失败：拒绝指向${reason}的链接（${url.hostname}）。`);
  return url;
}

/** Refuse every address that could reach this machine or a private network. */
function refusePrivateAddresses(
  hostname: string,
  addresses: { address: string; family: number }[],
) {
  for (const entry of addresses) {
    const reason = describeAddress(entry.address);
    if (reason)
      throw Error(
        `取件失败：${hostname} 解析到${reason}（${entry.address}），已拒绝。`,
      );
  }
}

/** Resolve the host and refuse every address that could reach this machine
 * or a private network. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    const reason = describeAddress(literal);
    if (reason)
      throw Error(`取件失败：拒绝指向${reason}的链接（${hostname}）。`);
    return;
  }
  const addresses = await new Promise<
    { address: string; family: number }[]
  >((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, found) => {
      if (error) reject(Error(`取件失败：域名 ${hostname} 解析失败。`));
      else resolve(found || []);
    });
  });
  if (!addresses.length)
    throw Error(`取件失败：域名 ${hostname} 没有解析到地址。`);
  refusePrivateAddresses(hostname, addresses);
}

/** The real request. The lookup hook refuses a host that resolves to a
 * loopback, private or link-local address — and it does so on the address
 * that is actually connected to, so a name that changes between the check and
 * the connection cannot slip through. */
const validatingLookup = (
  hostname: string,
  options: any,
  callback: (error: Error | null, ...rest: any[]) => void,
) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, found) => {
    if (error) return callback(error);
    const list = (found || []).filter(Boolean);
    if (!list.length)
      return callback(Error(`取件失败：域名 ${hostname} 没有解析到地址。`));
    try {
      refusePrivateAddresses(hostname, list);
    } catch (e) {
      return callback(e as Error);
    }
    if (options?.all) return callback(null, list);
    const first = list[0];
    callback(null, first.address, first.family);
  });
};

const httpsGet: PackHttpClient = (url, signal) =>
  new Promise<PackResponse>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "sand-table-pack-import/1",
        },
        lookup: validatingLookup,
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_MANIFEST_BYTES) {
            response.destroy();
            request.destroy();
            reject(
              Error(
                `取件失败：响应体超过 ${MAX_MANIFEST_BYTES / 1024} KB 上限。`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });

function isJsonContentType(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return false;
  const type = raw.split(";")[0].trim().toLowerCase();
  return (
    type === "application/json" ||
    type === "text/json" ||
    (type.startsWith("application/") && type.endsWith("+json"))
  );
}

/**
 * Fetch a manifest.
 *
 * Every hop is checked again — scheme, literal address, and the address the
 * connection actually goes to — so a redirect cannot walk from a public host
 * into a private one. The host is resolved once per hop, by the request
 * itself, which is why there is no separate lookup here: the address that was
 * checked is the address that is connected to.
 */
export async function fetchPackManifest(
  raw: string,
  client: PackHttpClient = httpsGet,
): Promise<{ text: string; url: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PACK_FETCH_TIMEOUT_MS);
  try {
    let current = assertPublicHttpsUrl(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await client(current.href, controller.signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const header = response.headers.location;
        const location = Array.isArray(header) ? header[0] : header;
        if (!location)
          throw Error(
            `取件失败：${current.href} 返回 ${response.status}，但没有 Location。`,
          );
        current = assertPublicHttpsUrl(new URL(location, current).href);
        continue;
      }
      if (response.status !== 200)
        throw Error(
          `取件失败：${current.href} 返回 HTTP ${response.status}。`,
        );
      if (!isJsonContentType(response.headers["content-type"]))
        throw Error(
          `取件失败：${current.href} 的 Content-Type 不是 JSON（收到 ${response.headers["content-type"] ?? "空"}）。`,
        );
      if (response.body.length > MAX_MANIFEST_BYTES)
        throw Error(
          `取件失败：响应体超过 ${MAX_MANIFEST_BYTES / 1024} KB 上限。`,
        );
      return { text: response.body.toString("utf8"), url: current.href };
    }
    throw Error(`取件失败：重定向超过 ${MAX_REDIRECTS} 次。`);
  } catch (e) {
    if (controller.signal.aborted)
      throw Error(`取件失败：超过 ${PACK_FETCH_TIMEOUT_MS / 1000} 秒超时。`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
