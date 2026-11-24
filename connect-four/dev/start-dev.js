/**
 * `npm run dev` — starts everything needed for local development in one process:
 *   - the mock partner stats API on http://localhost:4000
 *   - our game server on http://localhost:3000 (bot enabled, so you can play alone)
 *
 * Works the same on Windows, macOS and Linux.
 */
import { loadConfig } from '../server/config.js';
import { createGameServer } from '../server/app.js';
import { createMockStatsApi } from './mock-stats-api.js';

const MOCK_STATS_PORT = 4000;

const config = loadConfig({
  stats: { baseUrl: `http://localhost:${MOCK_STATS_PORT}` },
  bot: { enabled: process.env.BOT_ENABLED !== 'false' },
});

const mockStatsApi = createMockStatsApi({
  apiKey: config.stats.apiKey,
  webhookSecret: config.stats.webhookSecret,
  defaultWebhookUrls: [`http://localhost:${config.port}/webhooks/stats`],
});
await mockStatsApi.start(MOCK_STATS_PORT);
console.log(`Mock stats API running: http://localhost:${MOCK_STATS_PORT}  (outage test: POST /dev/outage {"down":true})`);

const gameServer = createGameServer(config);
await gameServer.start();
console.log(`Open http://localhost:${config.port} in two browser windows. A bot joins after ${config.bot.joinAfterSeconds} s of waiting alone.`);

process.on('SIGINT', async () => {
  await gameServer.stop();
  await mockStatsApi.stop();
  process.exit(0);
});
