import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server } from "node:http";
import { connect as netConnect, isIP, type LookupFunction, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { guardedLookup, refusedAddress, type Resolver } from "./address.js";

/**
 * A local HTTP proxy the scan's browser sends every request through. It is how the browser's redirect hops and
 * subresources are checked: the route guard in the browser sees only the first URL of a request, but the proxy sees
 * each request Chromium makes, including every redirect hop, and each CONNECT tunnel.
 *
 * Every destination is resolved and checked here (refusedAddress), and the connection goes to the address that was
 * checked, so a DNS answer that changes later cannot redirect it. A refused request or tunnel is dropped with no
 * response, which the browser reports as a network error, never as a page.
 */
export interface EgressPolicy {
  resolver: Resolver;
  /** Whether the scan's own target is local, so loopback and private destinations are allowed. */
  allowPrivate: boolean;
  /**
   * Test seam: the address a checked destination is really connected to. Tests map a public test address onto a local
   * server. Production leaves it unset, and the checked address is used as it is.
   */
  connectAddress?: (address: string) => string;
}

export interface EgressProxy {
  /** The proxy URL to give the browser. */
  url: string;
  /** Stops listening and closes every open connection and tunnel. */
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Headers that cross the proxy: the end-to-end ones. */
function endToEnd(headers: IncomingMessage["headers"] | OutgoingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/**
 * How to connect to a destination: an IP literal is checked here and connected to as it is; a name is looked up at
 * connect time by a checked lookup (every answer must be allowed, and the socket gets the checked answers, so both
 * families are tried as usual). A refused destination is reported through onRefused and yields undefined.
 */
function connectionFor(hostname: string, policy: EgressPolicy, onRefused: () => void): { host: string; lookup?: LookupFunction } | undefined {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) {
    if (refusedAddress(bare, policy.allowPrivate)) {
      onRefused();
      return undefined;
    }
    return { host: policy.connectAddress ? policy.connectAddress(bare) : bare };
  }
  const checked = guardedLookup(policy.resolver, policy.allowPrivate, policy.connectAddress);
  const lookup = ((name: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    checked(name, options, (err: unknown, ...rest: unknown[]) => {
      if (err) onRefused();
      callback(err, ...rest);
    });
  }) as unknown as LookupFunction;
  return { host: bare, lookup };
}

/** host and port of a CONNECT authority (`host:port`), with the host normalized by the URL parser. */
function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const match = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(authority);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return undefined;
  try {
    return { host: new URL(`http://${match[1]}`).hostname, port };
  } catch {
    return undefined;
  }
}

export async function startEgressProxy(policy: EgressPolicy, onRefused: () => void = () => {}): Promise<EgressProxy> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      let target: URL;
      try {
        target = new URL(req.url ?? "");
      } catch {
        return drop(req.socket, onRefused);
      }
      if (target.protocol !== "http:") return drop(req.socket, onRefused);
      const connection = connectionFor(target.hostname, policy, onRefused);
      if (!connection) return drop(req.socket, () => {});
      const upstream = httpRequest(
        {
          host: connection.host,
          lookup: connection.lookup,
          port: Number(target.port || 80),
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers: { ...endToEnd(req.headers), host: target.host },
          agent: false,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, endToEnd(up.headers));
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (res.headersSent) res.destroy();
        else drop(req.socket, () => {});
      });
      req.pipe(upstream);
    })();
  });

  server.on("connect", (req, client: Socket, head: Buffer) => {
    track(client);
    client.on("error", () => client.destroy());
    void (async () => {
      const parsed = parseAuthority(req.url ?? "");
      const connection = parsed ? connectionFor(parsed.host, policy, onRefused) : undefined;
      if (!parsed) return drop(client, onRefused);
      if (!connection) return drop(client, () => {});
      const upstream = netConnect({ host: connection.host, lookup: connection.lookup, port: parsed.port });
      track(upstream);
      upstream.on("error", () => client.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    })();
  });

  // A request the proxy cannot parse as a plain http request (e.g. a websocket upgrade) gets no reply.
  server.on("upgrade", (_req, socket) => drop(socket, onRefused));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("egress proxy has no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** A refused connection is dropped with no response, which the browser reports as a network error. */
function drop(socket: Duplex, onRefused: () => void): void {
  onRefused();
  socket.destroy();
}
