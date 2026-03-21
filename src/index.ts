import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';

import { authRouter } from './routes/auth';
import { foldersRouter } from './routes/folders';
import { filesRouter } from './routes/files';
import { sharesRouter } from './routes/shares';
import { linkSharesRouter, publicLinkRouter, searchRouter, starsRouter, trashRouter } from './routes/linkShares';
import { errorHandler } from './middleware/errorHandler';
import { rateLimiter } from './middleware/rateLimiter';

const app = express();
const PORT = process.env.PORT || 8080;

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: function (_origin, callback) {
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
}));

// Handle preflight requests
app.options('*', cors());

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// ── General middleware ────────────────────────────────────────────────────────
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '600mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.raw({ type: '*/*', limit: '600mb' }));
app.use(cookieParser());

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api/', rateLimiter.general);
app.use('/api/auth/', rateLimiter.auth);
app.use('/api/files/init', rateLimiter.upload);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/folders', foldersRouter);
app.use('/api/files', filesRouter);
app.use('/api/shares', sharesRouter);
app.use('/api/link-shares', linkSharesRouter);
app.use('/api/link', publicLinkRouter);
app.use('/api/search', searchRouter);
app.use('/api/trash', trashRouter);
app.use('/api/stars', starsRouter);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Route not found' }
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 NimbusCloud API running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
