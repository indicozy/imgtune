// Transfer compression: text-like responses served with no Content-Encoding. The saving is the body's length minus its
// brotli-11 length (a real encode; a body over SAMPLE_BYTES is encoded in part and extrapolated, labelled an estimate).
// Findings are grouped per host and content type: one server or CDN setting covers the group.
import { brotliCompressSync, constants } from "node:zlib";
import type { ResourceAnalyzer, ResourceFinding, ResourceRecord } from "./types.js";
import { digestOf, heavyValue } from "./cache.js";

/** Responses smaller than this are not worth a setting: the saving is below a packet. */
export const MIN_BYTES = 1024;
/** A body longer than this is brotli-encoded on its first SAMPLE_BYTES only, and the rest is extrapolated. */
export const SAMPLE_BYTES = 1024 * 1024;
/** A group saves less than this in total: no finding. */
const MIN_SAVED = 1024;
const MAX_URLS = 10;

const TEXT_APPLICATION = /^application\/(javascript|x-javascript|ecmascript|json|ld\+json|manifest\+json|xml|wasm|x-font-ttf|font-sfnt|x-font-opentype)$/;

/** Whether a content type is text-like (compressible): text/*, scripts, JSON, XML, SVG, WASM, TTF and OTF fonts. */
export function isTextLike(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType === "image/svg+xml" || TEXT_APPLICATION.test(contentType) || contentType === "font/ttf" || contentType === "font/otf" || contentType === "font/sfnt";
}

/**
 * The brotli-11 size of a body: exact when short, else the sample's ratio applied to the whole (`estimate` true). Over the
 * run's resource budget it is a quick brotli (quality 4) of the same bytes, also an estimate.
 */
export async function brotliSizeOf(body: Buffer): Promise<{ bytes: number; estimate: boolean }> {
  const key = `compression:brotli11:${digestOf(body)}`;
  const measured = await heavyValue(key, async () => {
    const sampled = body.length > SAMPLE_BYTES;
    const part = sampled ? body.subarray(0, SAMPLE_BYTES) : body;
    const out = brotliCompressSync(part, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: part.length,
      },
    });
    const bytes = sampled ? Math.round((out.length / part.length) * body.length) : out.length;
    return { bytes, estimate: sampled };
  });
  if (measured !== undefined) return measured;
  const part = body.length > SAMPLE_BYTES ? body.subarray(0, SAMPLE_BYTES) : body;
  const quick = brotliCompressSync(part, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: part.length } });
  return { bytes: Math.round((quick.length / part.length) * body.length), estimate: true };
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown host";
  }
}

/** The cheap filter: an uncompressed text-like response of at least MIN_BYTES, successful, under the body cap. */
export function wantsRecord(r: ResourceRecord): boolean {
  return r.contentEncoding === undefined && r.status >= 200 && r.status < 300 && isTextLike(r.contentType) && r.bytes >= MIN_BYTES && r.bytes <= 20 * 1024 * 1024;
}

export const analyzer: ResourceAnalyzer = {
  kind: "compression",
  wants: wantsRecord,
  async analyze(records: ResourceRecord[]): Promise<ResourceFinding[]> {
    try {
      interface Member {
        url: string;
        host: string;
        contentType: string;
        bytes: number;
        saved: number;
        brotli: number;
        estimate: boolean;
      }
      const members: Member[] = [];
      for (const r of records) {
        if (r.body === undefined || !wantsRecord(r)) continue;
        const { bytes: brotli, estimate } = await brotliSizeOf(r.body);
        const bytes = r.body.length;
        members.push({ url: r.url, host: hostOf(r.url), contentType: r.contentType, bytes, saved: Math.max(0, bytes - brotli), brotli, estimate });
      }
      const groups = new Map<string, Member[]>();
      for (const m of members) {
        const key = `${m.host}\n${m.contentType}`;
        groups.set(key, [...(groups.get(key) ?? []), m]);
      }
      const findings: ResourceFinding[] = [];
      for (const [key, list] of groups) {
        const saved = list.reduce((sum, m) => sum + m.saved, 0);
        if (saved < MIN_SAVED) continue;
        const bytes = list.reduce((sum, m) => sum + m.bytes, 0);
        const brotli = list.reduce((sum, m) => sum + m.brotli, 0);
        const largest = [...list].sort((a, b) => b.bytes - a.bytes);
        const { host, contentType } = largest[0];
        const estimate = list.some((m) => m.estimate);
        findings.push({
          id: `compression:${digestOf(key).slice(0, 16)}`,
          kind: "compression",
          url: largest[0].url,
          bytes,
          savedBytes: saved,
          estimate,
          title: `${list.length} ${contentType} file(s) from ${host} sent uncompressed: ${kb(bytes)}, brotli would send ${kb(brotli)} (saves ~${kb(saved)})`,
          fix: [
            `enable brotli (or gzip) for ${contentType} responses from ${host} at the server or CDN (nginx: \`brotli on; brotli_types ${contentType};\` or \`gzip on; gzip_types ${contentType};\`)`,
            `expected: ${kb(brotli)} per view for these files (brotli 11), from ${kb(bytes)}`,
          ],
          details: {
            host,
            contentType,
            files: list.length,
            bytes,
            brotliBytes: brotli,
            urls: largest.slice(0, MAX_URLS).map((m) => m.url),
          },
        });
      }
      return findings.sort((a, b) => b.savedBytes - a.savedBytes);
    } catch {
      return [];
    }
  },
};
