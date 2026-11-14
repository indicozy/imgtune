// Type declarations for untyped packages used by the font analyzer (src/resources/font.ts, sfnt.ts).

declare module "subset-font" {
  export interface SubsetOptions {
    targetFormat?: "sfnt" | "woff" | "woff2";
    noHinting?: boolean;
    dropTables?: string[];
  }
  /** harfbuzz WASM subsetter: keeps the glyphs for `text` and re-encodes to the target format. */
  export default function subsetFont(buffer: Buffer, text: string | null, options?: SubsetOptions): Promise<Buffer>;
}

declare module "wawoff2" {
  /** Google's WOFF2 codec (WASM): TTF/OTF to WOFF2 at brotli quality 11, and back. */
  export function compress(buffer: Buffer): Promise<Buffer>;
  export function decompress(buffer: Buffer): Promise<Buffer>;
}
