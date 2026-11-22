import type { RequestHandler } from 'express';
import multer from 'multer';
import { ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_BYTES } from '../domain/uploads/images';
import { AppError, BadRequestError, PayloadTooLargeError } from '../shared/errors/AppError';

/**
 * Single image upload (multipart field `image`) kept in memory (≤ 2 MB), so
 * nothing touches the disk before the content check in the service. The
 * client file name is ignored entirely.
 */
export function imageUpload(field = 'image'): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 1, headerPairs: 50 },
    fileFilter: (_req, file, callback) => {
      if (ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) callback(null, true);
      else
        callback(
          new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only JPEG, PNG and WebP images are allowed'),
        );
    },
  }).single(field);

  return (req, res, next) => {
    if (!req.is('multipart/form-data')) {
      next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the image as multipart/form-data'));
      return;
    }
    upload(req, res, (error: unknown) => {
      if (!error) {
        if (!req.file) next(new BadRequestError(`An image file is required in field "${field}"`));
        else next();
        return;
      }
      if (error instanceof multer.MulterError) {
        next(
          error.code === 'LIMIT_FILE_SIZE'
            ? new PayloadTooLargeError('Image must be 2 MB or smaller')
            : new BadRequestError(`Invalid upload: ${error.message}`),
        );
        return;
      }
      next(error);
    });
  };
}
