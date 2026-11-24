/**
 * Entry point: `npm start`
 * Configuration comes from environment variables / .env (see .env.example).
 */
import { loadConfig } from './config.js';
import { createGameServer } from './app.js';

const gameServer = createGameServer(loadConfig());
await gameServer.start();

async function shutDown(signal) {
  console.log(`\n${signal} received, stopping the server...`);
  await gameServer.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutDown('SIGINT'));
process.on('SIGTERM', () => shutDown('SIGTERM'));
