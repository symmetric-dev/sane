const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});

/** Store already-compressed images/videos without recompression. The media
 * contract bounds the collection well below ZIP32 size and entry limits. */
export async function mediaShareArchive(files: File[], name: string, signal: AbortSignal): Promise<File> {
  const parts: BlobPart[] = [], directory: Uint8Array<ArrayBuffer>[] = [];
  const names = new Set<string>();
  let offset = 0;
  for (const file of files) {
    signal.throwIfAborted();
    let filename = file.name;
    const dot = filename.lastIndexOf("."), stem = dot > 0 ? filename.slice(0, dot) : filename, extension = dot > 0 ? filename.slice(dot) : "";
    for (let suffix = 2; names.has(filename.toLowerCase()); suffix++) filename = `${stem} (${suffix})${extension}`;
    names.add(filename.toLowerCase());
    const encoded = new TextEncoder().encode(filename);
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal.throwIfAborted();
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
    crc = (crc ^ 0xffffffff) >>> 0;

    const local = new Uint8Array(30 + encoded.length), localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 filenames; compression method is Store (0).
    localView.setUint16(12, 33, true); // 1980-01-01, the earliest DOS date.
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.size, true);
    localView.setUint32(22, file.size, true);
    localView.setUint16(26, encoded.length, true);
    local.set(encoded, 30);
    parts.push(local, file);

    const central = new Uint8Array(46 + encoded.length), centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(14, 33, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.size, true);
    centralView.setUint32(24, file.size, true);
    centralView.setUint16(28, encoded.length, true);
    centralView.setUint32(42, offset, true);
    central.set(encoded, 46);
    directory.push(central);
    offset += local.length + file.size;
  }
  signal.throwIfAborted();
  const end = new Uint8Array(22), endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, directory.reduce((size, entry) => size + entry.length, 0), true);
  endView.setUint32(16, offset, true);
  return new File([...parts, ...directory, end], name, { type: "application/zip" });
}
