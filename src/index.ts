import { buildApp } from './server.js';

const { app, services } = await buildApp();

try {
  await app.listen({ port: services.config.port, host: services.config.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
