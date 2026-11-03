import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { env } from './config/env';

export function configureApp(app: INestApplication) {
  const express = app as NestExpressApplication;
  express.set('trust proxy', 1);
  express.disable('x-powered-by');
  app.setGlobalPrefix('api');
  // Los workers envían transcripciones completas: límite mayor sólo en la API interna.
  app.use('/api/internal', json({ limit: '64mb' }));
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  app.useLogger(app.get(Logger));
  configureApp(app);

  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('ClipMaster AI API')
      .setDescription('API REST de ClipMaster AI. Autenticación por cookie de sesión (cm_session) o Bearer.')
      .setVersion('0.1.0')
      .addCookieAuth('cm_session')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('api/docs', app, doc, { jsonDocumentUrl: 'api/docs/openapi.json' });

  await app.listen(env().PORT, '0.0.0.0');
}

if (require.main === module) {
  void bootstrap();
}
