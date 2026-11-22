import type { Request, Response } from 'express';
import type { z } from 'zod';
import { getAuth } from '../middlewares/auth';
import { getValidated } from '../middlewares/validate';
import type { idParamsSchema } from '../schemas/event.schemas';
import type { EventBannerService } from '../services/events/EventBannerService';
import { BadRequestError } from '../shared/errors/AppError';
import { sendSuccess } from '../shared/http/apiResponse';

type IdParams = z.output<typeof idParamsSchema>;

/** Event banner upload/removal and public image delivery (HTTP only). */
export class UploadController {
  constructor(private readonly banners: EventBannerService) {}

  setBanner = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    if (!req.file) throw new BadRequestError('An image file is required');
    const result = await this.banners.setBanner(getAuth(req).actor, params.id, {
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });
    sendSuccess(res, result, 201);
  };

  removeBanner = async (req: Request, res: Response) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    await this.banners.removeBanner(getAuth(req).actor, params.id);
    res.status(204).end();
  };

  serve = async (req: Request, res: Response) => {
    const key = String(req.params.key ?? '');
    const { data, contentType } = await this.banners.read(key);
    res.set({
      'Content-Type': contentType,
      'Content-Length': String(data.length),
      'X-Content-Type-Options': 'nosniff',
      // Rendered as an image only; nothing in it can run as a document.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
      // The web app on another origin must be able to display banners.
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'public, max-age=86400, immutable',
    });
    res.status(200).end(data);
  };
}
