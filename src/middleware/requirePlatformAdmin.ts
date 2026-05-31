import type { Request, RequestHandler, Response } from 'express';
import { resolveIsPlatformAdmin } from '../platformAdmin.js';

export const requirePlatformAdmin: RequestHandler = (req: Request, res: Response, next) => {
  if (!resolveIsPlatformAdmin(req)) {
    res.status(403).json({ success: false, error: 'Platform admin required' });
    return;
  }
  next();
};
