import type { FileHandle } from "node:fs/promises";
import { extname } from "node:path";
import { MEDIA_SHARE_LIMITS as LIMITS, type MediaShareMimeType } from "../shared/media-share-contract";

/** Deliberately conservative v1 allowlist; no decoder, subprocess or transcode. */
export function mediaFormat(path: string): { kind: "image" | "video"; mimeType: MediaShareMimeType; maxBytes: number } {
  const extension = extname(path).toLowerCase();
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4" } as const;
  if (!Object.hasOwn(mime, extension)) throw new Error("Only PNG, JPEG, WebP and MP4 files are supported");
  const mimeType = mime[extension as keyof typeof mime], kind = mimeType === "video/mp4" ? "video" : "image";
  return { kind, mimeType, maxBytes: kind === "image" ? LIMITS.imageBytes : LIMITS.videoBytes };
}
function requireFormat(ok: unknown): asserts ok { if (!ok) throw new Error("Invalid or unsupported media structure"); }
function dimensions(width: number, height: number) {
  requireFormat(width > 0 && height > 0 && width <= LIMITS.dimension && height <= LIMITS.dimension && width * height <= LIMITS.pixels);
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc(bytes: Buffer) { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function png(b: Buffer) {
  requireFormat(b.length >= 45 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  let at = 8, header = false, data = false, dataBytes = 0, endedData = false, palette = false, color = -1, chunks = 0;
  while (at < b.length) {
    requireFormat(++chunks <= 65536 && at + 12 <= b.length);
    const size = b.readUInt32BE(at), end = at + 12 + size, type = b.toString("latin1", at + 4, at + 8);
    requireFormat(end <= b.length && /^[A-Za-z]{4}$/.test(type) && crc(b.subarray(at + 4, end - 4)) === b.readUInt32BE(end - 4));
    if (!header) {
      requireFormat(type === "IHDR" && size === 13);
      dimensions(b.readUInt32BE(at + 8), b.readUInt32BE(at + 12));
      const depth = b[at + 16]!; color = b[at + 17]!;
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      requireFormat(depths[color]?.includes(depth) && b[at + 18] === 0 && b[at + 19] === 0 && b[at + 20]! <= 1); header = true;
    } else if (type === "IDAT") { requireFormat(!endedData && (color !== 3 || palette)); data = true; dataBytes += size; }
    else if (type === "IEND") { requireFormat(size === 0 && data && dataBytes > 0 && end === b.length); return; }
    else {
      if (data) endedData = true;
      requireFormat(type !== "IHDR" && !["acTL", "fcTL", "fdAT"].includes(type)); // no animation in v1
      if (type === "PLTE") { requireFormat(!palette && !data && size > 0 && size <= 768 && size % 3 === 0 && color !== 0 && color !== 4); palette = true; }
      else requireFormat(type[0] === type[0]!.toLowerCase()); // reject unknown critical chunks
    }
    at = end;
  }
  requireFormat(false);
}
function jpeg(b: Buffer) {
  requireFormat(b.length >= 4 && b[0] === 255 && b[1] === 216);
  let at = 2, frame = false, scan = false, markers = 0, components = 0;
  while (at < b.length) {
    requireFormat(++markers < 100000 && b[at++] === 255);
    while (b[at] === 255) at++;
    const marker = b[at++];
    if (marker === 217) { requireFormat(frame && scan && at === b.length); return; }
    requireFormat(marker !== undefined && marker !== 0 && marker !== 216 && marker !== 1 && !(marker >= 208 && marker <= 215) && at + 2 <= b.length);
    const length = b.readUInt16BE(at), end = at + length;
    requireFormat(length >= 2 && end <= b.length);
    if ([192, 193, 194].includes(marker)) {
      requireFormat(!frame && length >= 8 && b[at + 2] === 8);
      dimensions(b.readUInt16BE(at + 5), b.readUInt16BE(at + 3));
      components = b[at + 7]!; requireFormat([1, 3, 4].includes(components) && length === 8 + 3 * components); frame = true;
    } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) requireFormat(false);
    if (marker === 218) {
      const count = b[at + 2]!; requireFormat(frame && count > 0 && count <= components && length === 6 + 2 * count); scan = true; at = end;
      // Scan entropy without decoding; FF00 is escaped data, RSTn is in-band.
      while (at < b.length) {
        if (b[at] !== 255) { at++; continue; }
        const start = at++; while (b[at] === 255) at++;
        if (b[at] === 0 || b[at]! >= 208 && b[at]! <= 215) { at++; continue; }
        at = start; break;
      }
    } else at = end;
  }
  requireFormat(false);
}
function webp(b: Buffer) {
  requireFormat(b.length >= 20 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" && b.readUInt32LE(4) + 8 === b.length);
  let at = 12, image = false, extended = false, canvas: number[] | undefined, chunks = 0;
  while (at < b.length) {
    requireFormat(++chunks <= 1024 && at + 8 <= b.length);
    const type = b.toString("latin1", at, at + 4), length = b.readUInt32LE(at + 4), start = at + 8, end = start + length;
    requireFormat(end + (length & 1) <= b.length && (!(length & 1) || b[end] === 0));
    if (type === "VP8X") {
      requireFormat(at === 12 && length === 10 && !(b[start]! & 0xc3) && !(b[start]! & 2) && b.readUIntBE(start + 1, 3) === 0);
      canvas = [1 + b.readUIntLE(start + 4, 3), 1 + b.readUIntLE(start + 7, 3)]; dimensions(canvas[0]!, canvas[1]!); extended = true;
    } else if (type === "VP8 " || type === "VP8L") {
      requireFormat(!image); image = true; let w: number, h: number;
      if (type === "VP8 ") {
        requireFormat(length >= 10 && !(b[start]! & 1) && b[start + 3] === 0x9d && b[start + 4] === 1 && b[start + 5] === 0x2a);
        w = b.readUInt16LE(start + 6) & 0x3fff; h = b.readUInt16LE(start + 8) & 0x3fff;
      } else {
        requireFormat(length >= 5 && b[start] === 0x2f && !(b[start + 4]! & 0xe0));
        const bits = b.readUInt32LE(start + 1); w = (bits & 0x3fff) + 1; h = ((bits >>> 14) & 0x3fff) + 1;
      }
      dimensions(w, h); requireFormat(!canvas || canvas[0] === w && canvas[1] === h);
    } else requireFormat(extended && ["ALPH", "ICCP", "EXIF", "XMP "].includes(type));
    at = end + (length & 1);
  }
  requireFormat(image && at === b.length);
}

/** Static, nonfragmented ISO BMFF with self-contained video/audio tracks only.
 * Codec configuration boxes remain opaque: this validates container/sample
 * structure and byte containment, not whether a browser can decode the codec.
 * All large tables are scanned in bounded pages; sample payloads are not read. */
async function mp4(read: (at: number, bytes: number) => Promise<Buffer>, size: number, check: () => void) {
  type Box = { type: string; start: number; payload: number; end: number; children: Box[] };
  const MAX_SAMPLES = 10_000_000, MAX_ROWS = 1_000_000, PAGE = 64 * 1024;
  let boxes = 0, tableRows = 0, samples = 0;
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf", "edts"]);
  const parents: Record<string, string> = {
    ftyp: "", mdat: "", moov: "", mvhd: "moov", trak: "moov", tkhd: "trak", edts: "trak", elst: "edts", mdia: "trak",
    mdhd: "mdia", hdlr: "mdia", minf: "mdia", vmhd: "minf", smhd: "minf", nmhd: "minf", hmhd: "minf", dinf: "minf", dref: "dinf", stbl: "minf",
    stsd: "stbl", stts: "stbl", ctts: "stbl", stsc: "stbl", stsz: "stbl", stz2: "stbl", stco: "stbl", co64: "stbl", stss: "stbl",
  };
  const children = async (start: number, end: number, parent: string, depth: number): Promise<Box[]> => {
    requireFormat(depth <= 10); let at = start; const result: Box[] = [];
    while (at < end) {
      check(); requireFormat(++boxes <= 32768 && at + 8 <= end);
      const header = await read(at, Math.min(16, end - at));
      let length = header.readUInt32BE(0), head = 8; const type = header.toString("latin1", 4, 8);
      if (length === 1) { requireFormat(header.length >= 16); const n = header.readBigUInt64BE(8); requireFormat(n >= 16n && n <= BigInt(Number.MAX_SAFE_INTEGER)); length = Number(n); head = 16; }
      if (!length) { requireFormat(parent === "" && type === "mdat"); length = end - at; }
      if (type === "uuid") head += 16;
      const next = at + length, payload = at + head;
      requireFormat(length >= head && next <= end && /^[ -~]{4}$/.test(type));
      requireFormat(!["moof", "mvex", "traf", "tfhd", "tfdt", "trun", "mfra"].includes(type));
      if (Object.hasOwn(parents, type)) requireFormat(parents[type] === parent);
      result.push({ type, start: at, payload, end: next, children: containers.has(type) ? await children(payload, next, type, depth + 1) : [] });
      at = next;
    }
    requireFormat(at === end); return result;
  };
  const one = (list: Box[], type: string): Box => { const found = list.filter(b => b.type === type); requireFormat(found.length === 1); return found[0]!; };
  const optional = (list: Box[], type: string): Box | undefined => { const found = list.filter(b => b.type === type); requireFormat(found.length <= 1); return found[0]; };
  const either = (list: Box[], a: string, b: string): Box => { const first = optional(list, a), second = optional(list, b); requireFormat(!!first !== !!second); return (first ?? second)!; };
  const full = async (box: Box, versions = [0], allowedFlags = 0) => {
    requireFormat(box.end - box.payload >= 4); const b = await read(box.payload, 4), version = b[0]!, flags = b.readUIntBE(1, 3);
    requireFormat(versions.includes(version) && !(flags & ~allowedFlags)); return { version, flags };
  };
  const fixed = async (box: Box, sizes: number[], allowedFlags = 0) => {
    const { version, flags } = await full(box, sizes.map((_, i) => i), allowedFlags);
    requireFormat(box.end - box.payload === sizes[version]);
    return { bytes: await read(box.payload, sizes[version]!), version, flags };
  };
  const table = async (box: Box, stride: number, versions = [0]) => {
    await full(box, versions); requireFormat(box.end - box.payload >= 8);
    const n = (await read(box.payload + 4, 4)).readUInt32BE();
    tableRows += n; requireFormat(n <= MAX_ROWS && tableRows <= 4 * MAX_ROWS && box.end - box.payload === 8 + n * stride); return n;
  };
  const scan = async (box: Box, n: number, stride: number, visit: (bytes: Buffer, at: number, index: number) => void) => {
    const perPage = Math.floor(PAGE / stride);
    for (let i = 0; i < n; i += perPage) {
      check(); const part = await read(box.payload + 8 + i * stride, Math.min(perPage, n - i) * stride);
      for (let at = 0; at < part.length; at += stride) visit(part, at, i + at / stride);
    }
  };
  const root = await children(0, size, "", 0), ftyp = one(root, "ftyp"), movie = one(root, "moov");
  const brandBytes = ftyp.end - ftyp.payload, brands = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "avc1", "mp41", "mp42", "M4V "]);
  requireFormat(ftyp.start === 0 && brandBytes >= 8 && brandBytes <= 4096 && brandBytes % 4 === 0);
  const brand = await read(ftyp.payload, brandBytes); requireFormat(brands.has(brand.toString("latin1", 0, 4)));
  for (let p = 8; p < brand.length; p += 4) requireFormat(brands.has(brand.toString("latin1", p, p + 4)));
  const media = root.filter(b => b.type === "mdat"); requireFormat(media.length > 0 && media.every(b => b.end > b.payload));
  const contained = (start: number, bytes: number) => {
    requireFormat(Number.isSafeInteger(start) && Number.isSafeInteger(bytes) && start >= 0 && bytes >= 0);
    let low = 0, high = media.length - 1;
    while (low <= high) { const mid = (low + high) >>> 1, box = media[mid]!; if (start < box.payload) high = mid - 1; else if (start >= box.end) low = mid + 1; else { requireFormat(bytes <= box.end - start); return; } }
    requireFormat(false);
  };
  const mvhd = await fixed(one(movie.children, "mvhd"), [100, 112]);
  requireFormat(mvhd.bytes.readUInt32BE(mvhd.version ? 20 : 12) > 0);
  const tracks = movie.children.filter(b => b.type === "trak"), ids = new Set<number>();
  requireFormat(tracks.length > 0 && tracks.length <= 64); let video = false;
  for (const track of tracks) {
    check();
    const tkhd = await fixed(one(track.children, "tkhd"), [84, 96], 15), id = tkhd.bytes.readUInt32BE(tkhd.version ? 20 : 12), shift = tkhd.version ? 12 : 0;
    requireFormat(id > 0 && !ids.has(id)); ids.add(id);
    requireFormat(tkhd.bytes.readUInt32BE(tkhd.version ? 24 : 16) === 0 && tkhd.bytes.subarray(24 + shift, 32 + shift).every(b => b === 0) && tkhd.bytes.readUInt16BE(38 + shift) === 0);
    const mdia = one(track.children, "mdia"), mdhd = await fixed(one(mdia.children, "mdhd"), [24, 36]);
    requireFormat(mdhd.bytes.readUInt32BE(mdhd.version ? 20 : 12) > 0 && !(mdhd.bytes.readUInt16BE(mdhd.version ? 32 : 20) & 0x8000) && mdhd.bytes.readUInt16BE(mdhd.version ? 34 : 22) === 0);
    const hdlr = one(mdia.children, "hdlr"); await full(hdlr); requireFormat(hdlr.end - hdlr.payload >= 24);
    const handlerBytes = await read(hdlr.payload, 24), handler = handlerBytes.toString("latin1", 8, 12);
    requireFormat(handlerBytes.readUInt32BE(4) === 0 && handlerBytes.subarray(12).every(b => b === 0) && ["vide", "soun"].includes(handler));
    const isVideo = handler === "vide", width = tkhd.bytes.readUInt32BE(76 + shift), height = tkhd.bytes.readUInt32BE(80 + shift);
    requireFormat(isVideo ? width > 0 && height > 0 : width === 0 && height === 0);
    const minf = one(mdia.children, "minf");
    requireFormat(!minf.children.some(b => ["vmhd", "smhd", "nmhd", "hmhd"].includes(b.type) && b.type !== (isVideo ? "vmhd" : "smhd")));
    const mediaHeader = await fixed(one(minf.children, isVideo ? "vmhd" : "smhd"), [isVideo ? 12 : 8], isVideo ? 1 : 0);
    requireFormat(mediaHeader.flags === (isVideo ? 1 : 0));
    if (!isVideo) requireFormat(mediaHeader.bytes.readUInt16BE(6) === 0);
    const dinf = one(minf.children, "dinf"), dref = one(dinf.children, "dref"); await full(dref);
    requireFormat(dref.end - dref.payload >= 8 && dref.end - dref.payload <= 4096);
    const references = (await read(dref.payload + 4, 4)).readUInt32BE(), urls = await children(dref.payload + 8, dref.end, "dref", 6);
    requireFormat(references > 0 && references <= 16 && urls.length === references);
    for (const url of urls) { requireFormat(url.type === "url " && url.end - url.payload === 4); const value = await full(url, [0], 1); requireFormat(value.flags === 1); }
    const stbl = one(minf.children, "stbl"), stsd = one(stbl.children, "stsd"); await full(stsd); requireFormat(stsd.end - stsd.payload >= 8);
    const descriptions = (await read(stsd.payload + 4, 4)).readUInt32BE(), entries = await children(stsd.payload + 8, stsd.end, "stsd", 6);
    requireFormat(descriptions > 0 && descriptions <= 64 && entries.length === descriptions);
    for (const entry of entries) {
      const base = isVideo ? 78 : 28; requireFormat(entry.type !== "uuid" && entry.end - entry.payload >= base);
      const b = await read(entry.payload, base), reference = b.readUInt16BE(6);
      requireFormat(b.subarray(0, 6).every(value => value === 0) && reference > 0 && reference <= references);
      let extension = entry.payload + base;
      if (isVideo) {
        requireFormat(b.subarray(8, 24).every(value => value === 0) && b.readUInt16BE(24) > 0 && b.readUInt16BE(26) > 0 && b.readUInt32BE(28) > 0 && b.readUInt32BE(32) > 0 && b.readUInt32BE(36) === 0 && b.readUInt16BE(40) === 1 && b[42]! <= 31 && b.readUInt16BE(74) > 0 && b.readUInt16BE(76) === 0xffff);
      } else {
        // ISO audio entries (v0) and common QuickTime audio extensions (v1/v2)
        // are structural variants, not codec allowlists.
        const version = b.readUInt16BE(8); requireFormat(version <= 2);
        if (version < 2) requireFormat(b.readUInt16BE(16) > 0 && b.readUInt16BE(18) > 0 && b.readUInt32BE(24) > 0);
        const extra = version === 1 ? 16 : version === 2 ? 36 : 0;
        requireFormat(extension + extra <= entry.end);
        if (version === 2) { const v2 = await read(extension, extra); requireFormat(v2.readUInt32BE(0) === 72 && Number.isFinite(v2.readDoubleBE(4)) && v2.readDoubleBE(4) > 0 && v2.readUInt32BE(12) > 0 && v2.readUInt32BE(16) === 0x7f000000); }
        extension += extra;
      }
      await children(extension, entry.end, "sample-entry", 7);
    }
    const edts = optional(track.children, "edts");
    if (edts) {
      const elst = one(edts.children, "elst"), { version } = await full(elst, [0, 1]), stride = version ? 20 : 12;
      await scan(elst, await table(elst, stride, [0, 1]), stride, (b, at) => {
        const time = version ? b.readBigInt64BE(at + 8) : BigInt(b.readInt32BE(at + 4)), rate = at + (version ? 16 : 8);
        requireFormat(time >= -1n && [0, 1].includes(b.readInt16BE(rate)) && b.readUInt16BE(rate + 2) === 0);
      });
    }
    const sizes = either(stbl.children, "stsz", "stz2"); await full(sizes); requireFormat(sizes.end - sizes.payload >= 12);
    const sizeHeader = await read(sizes.payload, 12), sampleCount = sizeHeader.readUInt32BE(8);
    samples += sampleCount; requireFormat(sampleCount <= MAX_SAMPLES && samples <= MAX_SAMPLES);
    const constant = sizes.type === "stsz" ? sizeHeader.readUInt32BE(4) : 0, bits = sizes.type === "stsz" ? 32 : sizeHeader[7]!;
    if (sizes.type === "stz2") requireFormat(sizeHeader.readUIntBE(4, 3) === 0 && [4, 8, 16].includes(bits));
    requireFormat(sizes.end - sizes.payload === 12 + (constant ? 0 : Math.ceil(sampleCount * bits / 8)));
    let sizeIndex = 0, pageStart = -1;
    let page: Buffer = Buffer.alloc(0);
    const sampleBytes = async (n: number) => {
      requireFormat(sizeIndex + n <= sampleCount);
      if (constant) { sizeIndex += n; return n * constant; }
      let total = 0;
      while (n > 0) {
        check(); const byte = Math.floor(sizeIndex * bits / 8);
        if (byte < pageStart || byte >= pageStart + page.length) { pageStart = byte; page = await read(sizes.payload + 12 + byte, Math.min(PAGE, sizes.end - sizes.payload - 12 - byte)); }
        const available = Math.min(n, Math.floor((pageStart + page.length) * 8 / bits) - sizeIndex);
        requireFormat(available > 0);
        for (let i = 0; i < available; i++, sizeIndex++) {
          const at = Math.floor(sizeIndex * bits / 8) - pageStart;
          total += bits === 32 ? page.readUInt32BE(at) : bits === 16 ? page.readUInt16BE(at) : bits === 8 ? page[at]! : (page[at]! >>> (sizeIndex % 2 ? 0 : 4)) & 15;
        }
        n -= available;
      }
      return total;
    };
    const stts = one(stbl.children, "stts"); let timedSamples = 0;
    await scan(stts, await table(stts, 8), 8, (b, at) => { const n = b.readUInt32BE(at); requireFormat(n > 0 && b.readUInt32BE(at + 4) > 0); timedSamples += n; requireFormat(timedSamples <= sampleCount); });
    requireFormat(timedSamples === sampleCount);
    const ctts = optional(stbl.children, "ctts");
    if (ctts) { let composed = 0; await scan(ctts, await table(ctts, 8, [0, 1]), 8, (b, at) => { const n = b.readUInt32BE(at); requireFormat(n > 0); composed += n; requireFormat(composed <= sampleCount); }); requireFormat(composed === sampleCount); }
    const stss = optional(stbl.children, "stss");
    if (stss) { let previous = 0; await scan(stss, await table(stss, 4), 4, (b, at) => { const n = b.readUInt32BE(at); requireFormat(n > previous && n <= sampleCount); previous = n; }); }
    const offsets = either(stbl.children, "stco", "co64"), offsetStride = offsets.type === "stco" ? 4 : 8, chunkCount = await table(offsets, offsetStride);
    const stsc = one(stbl.children, "stsc"), mappings = await table(stsc, 12), map = new Uint32Array(mappings * 3);
    await scan(stsc, mappings, 12, (b, at, index) => {
      const first = b.readUInt32BE(at), count = b.readUInt32BE(at + 4), description = b.readUInt32BE(at + 8);
      requireFormat(first > 0 && first <= chunkCount && (index ? first > map[(index - 1) * 3]! : first === 1) && count > 0 && count <= sampleCount && description > 0 && description <= descriptions);
      map[index * 3] = first; map[index * 3 + 1] = count; map[index * 3 + 2] = description;
    });
    requireFormat(chunkCount ? mappings > 0 : mappings === 0 && sampleCount === 0);
    let mapping = 0, dataBytes = 0;
    // Offset pages and size pages advance monotonically. No video-sized buffer
    // or attacker-controlled samples-by-chunks nested scan is needed.
    const perPage = Math.floor(PAGE / offsetStride);
    for (let first = 0; first < chunkCount; first += perPage) {
      check(); const count = Math.min(perPage, chunkCount - first), b = await read(offsets.payload + 8 + first * offsetStride, count * offsetStride);
      for (let i = 0; i < count; i++) {
        check(); const chunk = first + i + 1;
        while (mapping + 1 < mappings && map[(mapping + 1) * 3]! <= chunk) mapping++;
        const offset = offsetStride === 4 ? b.readUInt32BE(i * offsetStride) : Number(b.readBigUInt64BE(i * offsetStride));
        const bytes = await sampleBytes(map[mapping * 3 + 1]!); contained(offset, bytes); dataBytes += bytes;
      }
    }
    requireFormat(sizeIndex === sampleCount);
    if (sizes.type === "stz2" && bits === 4 && sampleCount % 2) requireFormat(!((await read(sizes.end - 1, 1))[0]! & 15));
    if (isVideo && sampleCount > 0 && dataBytes > 0) video = true;
  }
  requireFormat(video); check();
}
export async function validateMedia(handle: FileHandle, size: number, path: string, check: () => void): Promise<ReturnType<typeof mediaFormat>> {
  const format = mediaFormat(path); requireFormat(size > 0 && size <= format.maxBytes);
  const read = async (at: number, length: number) => {
    check(); requireFormat(at >= 0 && length >= 0 && at + length <= size && length <= LIMITS.imageBytes);
    const b = Buffer.alloc(length); let used = 0;
    while (used < length) { check(); const n = await handle.read(b, used, length - used, at + used); requireFormat(n.bytesRead > 0); used += n.bytesRead; }
    check(); return b;
  };
  if (format.kind === "video") await mp4(read, size, check);
  else {
    const bytes = await read(0, size);
    if (format.mimeType === "image/png") png(bytes);
    else if (format.mimeType === "image/jpeg") jpeg(bytes);
    else webp(bytes);
  }
  check(); return format;
}
