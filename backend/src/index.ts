import dotenv from 'dotenv';
// Load environment variables first before any other imports.
dotenv.config();

// Validate required environment variables before starting the server.
function validateEnv(): void {
  const required: Record<string, string> = {
    SUPABASE_URL: process.env.SUPABASE_URL ?? '',
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    JWT_SECRET: process.env.JWT_SECRET ?? '',
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value || value.trim() === '')
    .map(([key]) => key);

  if (missing.length > 0) {
    console.error(`[startup] Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  const recommended = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'WEBHOOK_URL'];
  const missingRecommended = recommended.filter((k) => !process.env[k]);
  if (missingRecommended.length > 0) {
    console.warn(
      `[startup] Optional variables not set (Telegram will be disabled): ${missingRecommended.join(', ')}`
    );
  }
}

validateEnv();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth';
import chatRoutes from './routes/chat';
import adminRoutes from './routes/admin';
import telegramRoutes, { registerTelegramWebhook } from './routes/telegram';
import { validateRagSchema } from './services/schemaHealth';
import { authLimiter, rateLimitMiddleware } from './utils/rateLimiter';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', rateLimitMiddleware(authLimiter, (req) => req.ip || 'unknown'), authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/telegram', telegramRoutes);

app.use(errorHandler);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

async function bootstrap(): Promise<void> {
  await validateRagSchema();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

    if (process.env.TELEGRAM_BOT_TOKEN && process.env.WEBHOOK_URL) {
      registerTelegramWebhook().catch(console.error);
    } else {
      console.warn('TELEGRAM_BOT_TOKEN or WEBHOOK_URL not set - webhook registration skipped');
    }
  });
}

bootstrap().catch((error) => {
  console.error('Startup failed:', error);
  process.exit(1);
});

export default app;
