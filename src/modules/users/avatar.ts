// Neonfi backend — Users module: avatar image sniff (retrofit-90).
//
// Never trust the multipart Content-Type — sniff magic bytes and map to an allowed
// MIME type + file extension. Allowed: PNG, JPEG, WEBP, GIF. Returns null for
// anything else (the caller rejects with 400 UNSUPPORTED_MEDIA_TYPE).

const SIGS: { type: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { type: 'image/png', ext: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', ext: 'gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  {
    type: 'image/webp',
    ext: 'webp',
    // "RIFF"...."WEBP" — bytes 0-3 = RIFF, bytes 8-11 = WEBP.
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

export function sniffImage(bytes: Uint8Array): { type: string; ext: string } | null {
  return SIGS.find((s) => s.test(bytes)) ?? null;
}
