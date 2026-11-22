import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApiHarness, signUp, type ApiHarness } from '../../helpers/apiHarness';
import { setupPublishedEvent } from '../../helpers/bookingFixtures';
import { newCustomer } from '../../helpers/bookingFixtures';
import { images } from '../../helpers/imageFixtures';

describe('Event banner uploads', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ otpBypass: true });
  });

  afterAll(async () => {
    await h.close();
  });

  const upload = (
    agent: ReturnType<typeof request.agent>,
    eventId: string,
    data: Buffer,
    filename: string,
    contentType: string,
  ) =>
    agent
      .post(`/api/organizer/events/${eventId}/banner`)
      .attach('image', data, { filename, contentType });

  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ] as const)(
    'accepts a real %s, stores it under a random name and serves it safely',
    async (kind, mime) => {
      const { organizer, eventId } = await setupPublishedEvent(h);
      const res = await upload(
        organizer,
        eventId,
        images[kind],
        '../../etc/passwd.png',
        mime,
      ).expect(201);
      const url = new URL(res.body.data.bannerUrl as string);
      const key = path.basename(url.pathname);
      expect(url.pathname).toMatch(/^\/uploads\/[0-9a-f-]{36}\.(jpg|png|webp)$/);
      expect(key).not.toContain('passwd');
      expect(readdirSync(h.uploadDir)).toContain(key);

      const served = await request(h.app).get(url.pathname).expect(200);
      expect(served.headers['content-type']).toBe(mime);
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['content-security-policy']).toContain('sandbox');
      expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(Buffer.compare(served.body as Buffer, images[kind])).toBe(0);

      const details = await request(h.app).get(`/api/events/${eventId}`).expect(200);
      expect(details.body.data.bannerUrl).toBe(res.body.data.bannerUrl);
    },
  );

  it('replacing a banner deletes the old file; removing clears it', async () => {
    const { organizer, eventId } = await setupPublishedEvent(h);
    const first = await upload(organizer, eventId, images.png, 'a.png', 'image/png').expect(201);
    const firstKey = path.basename(new URL(first.body.data.bannerUrl).pathname);
    await upload(organizer, eventId, images.jpeg, 'b.jpg', 'image/jpeg').expect(201);
    expect(existsSync(path.join(h.uploadDir, firstKey))).toBe(false);
    await request(h.app).get(`/uploads/${firstKey}`).expect(404);

    await organizer.delete(`/api/organizer/events/${eventId}/banner`).expect(204);
    const event = await organizer.get(`/api/organizer/events/${eventId}`).expect(200);
    expect(event.body.data.bannerUrl).toBeNull();
  });

  it('rejects disguised files, wrong types, oversize files and malformed requests', async () => {
    const { organizer, eventId } = await setupPublishedEvent(h);
    const before = readdirSync(h.uploadDir).length;

    // HTML/script renamed to .png with an image MIME type: content check fails.
    const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64, ' '));
    const disguised = await upload(organizer, eventId, html, 'x.png', 'image/png').expect(415);
    expect(disguised.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    // Real PNG declared as JPEG: declared and detected types must agree.
    await upload(organizer, eventId, images.png, 'x.jpg', 'image/jpeg').expect(415);
    // Disallowed types (SVG can carry script, GIF is not on the list).
    await upload(organizer, eventId, Buffer.from('<svg/>'), 'x.svg', 'image/svg+xml').expect(415);
    await upload(
      organizer,
      eventId,
      Buffer.from('GIF89a'.padEnd(32, '\0')),
      'x.gif',
      'image/gif',
    ).expect(415);
    // Over 2 MB (valid header, padded).
    const big = Buffer.concat([images.png, Buffer.alloc(2 * 1024 * 1024)]);
    await upload(organizer, eventId, big, 'big.png', 'image/png').expect(413);
    // No file / JSON body / wrong field / two files.
    await organizer
      .post(`/api/organizer/events/${eventId}/banner`)
      .send({ image: 'x' })
      .expect(415);
    await organizer
      .post(`/api/organizer/events/${eventId}/banner`)
      .attach('photo', images.png, { filename: 'a.png', contentType: 'image/png' })
      .expect(400);
    await organizer
      .post(`/api/organizer/events/${eventId}/banner`)
      .attach('image', images.png, { filename: 'a.png', contentType: 'image/png' })
      .attach('image', images.png, { filename: 'b.png', contentType: 'image/png' })
      .expect(400);

    expect(readdirSync(h.uploadDir).length).toBe(before);
  });

  it('enforces RBAC and ownership (IDOR) and leaves no orphan file', async () => {
    const { eventId } = await setupPublishedEvent(h);
    const before = readdirSync(h.uploadDir).length;
    const { agent: otherOrganizer } = await signUp(h, 'ORGANIZER');
    await upload(otherOrganizer, eventId, images.png, 'a.png', 'image/png').expect(404);
    await otherOrganizer.delete(`/api/organizer/events/${eventId}/banner`).expect(404);
    const { agent: customer } = await newCustomer(h);
    await upload(customer, eventId, images.png, 'a.png', 'image/png').expect(403);
    await request(h.app)
      .post(`/api/organizer/events/${eventId}/banner`)
      .attach('image', images.png, { filename: 'a.png', contentType: 'image/png' })
      .expect(401);
    expect(readdirSync(h.uploadDir).length).toBe(before);
  });

  it('never serves anything outside the upload directory', async () => {
    for (const probe of [
      '/uploads/..%2F..%2Fpackage.json',
      '/uploads/%2e%2e%2fsecret',
      '/uploads/not-a-uuid.png',
      '/uploads/00000000-0000-4000-8000-000000000000.png',
      '/uploads/00000000-0000-4000-8000-000000000000.svg',
    ]) {
      const res = await request(h.app).get(probe);
      expect(res.status).toBe(404);
    }
  });
});
