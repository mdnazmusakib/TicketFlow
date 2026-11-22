/** Minimal valid images built byte by byte (content checks only look at structure). */
export const images = {
  png: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    Buffer.alloc(17),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('IEND'),
    Buffer.alloc(4),
  ]),
  jpeg: Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0'),
    Buffer.alloc(40),
    Buffer.from([0xff, 0xd9]),
  ]),
  webp: (() => {
    const body = Buffer.concat([Buffer.from('WEBP'), Buffer.from('VP8 '), Buffer.alloc(20)]);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(body.length);
    return Buffer.concat([Buffer.from('RIFF'), size, body]);
  })(),
};
