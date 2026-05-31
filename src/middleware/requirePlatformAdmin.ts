import { RequestHandler } from 'express';
import { resolveIsPlatformAdmin } from '../platformAdmin.js';

export const requirePlatformAdmin: RequestHandler = (req, res, next) => {
  if (!resolveIsPlatformAdmin(req)) {
    res.status(403).json({ success: false, error: 'Platform admin required' });
    return;
  }
  next();
};
