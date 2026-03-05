import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';

export function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const base64Credentials = authHeader.slice(6);
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
  const [username, password] = credentials.split(':');

  const expectedUsername = config.qnBasicAuthUsername;
  const expectedPassword = config.qnBasicAuthPassword;

  const usernameBuffer = Buffer.from(username || '');
  const expectedUsernameBuffer = Buffer.from(expectedUsername);
  const passwordBuffer = Buffer.from(password || '');
  const expectedPasswordBuffer = Buffer.from(expectedPassword);

  const usernameMatch =
    usernameBuffer.length === expectedUsernameBuffer.length &&
    crypto.timingSafeEqual(usernameBuffer, expectedUsernameBuffer);

  const passwordMatch =
    passwordBuffer.length === expectedPasswordBuffer.length &&
    crypto.timingSafeEqual(passwordBuffer, expectedPasswordBuffer);

  if (!usernameMatch || !passwordMatch) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  next();
}
