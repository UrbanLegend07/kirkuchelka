/**
 * Server configuration, read from environment variables (and from a .env file if it exists).
 * See .env.example for all variables. Every value has a default that works for local development.
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readString(name, defaultValue) {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? defaultValue : value.trim();
}

function readNumber(name, defaultValue) {
  const rawValue = readString(name, null);
  if (rawValue === null) {
    return defaultValue;
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative number, got "${rawValue}".`);
  }
  return value;
}

function readBoolean(name, defaultValue) {
  const rawValue = readString(name, null);
  if (rawValue === null) {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(rawValue.toLowerCase());
}

/**
 * Builds the configuration. `overrides` is used by tests and by dev/start-dev.js
 * to change single values without touching environment variables.
 */
export function loadConfig(overrides = {}) {
  const dataDirectory = readString('DATA_DIR', path.join(PROJECT_ROOT, 'data'));

  const config = {
    port: readNumber('PORT', 3000),
    publicDirectory: path.join(PROJECT_ROOT, 'public'),
    sharedDirectory: path.join(PROJECT_ROOT, 'shared'),
    docsDirectory: path.join(PROJECT_ROOT, 'docs'),
    dataDirectory: path.resolve(PROJECT_ROOT, dataDirectory),

    defaultRating: 1000,
    /** Offline players without a running game are forgotten after this time (their reconnect token expires). */
    offlinePlayerTtlMs: readNumber('OFFLINE_PLAYER_TTL_SECONDS', 600) * 1000,

    matchmaking: {
      initialTolerance: 100,
      tolerancePerSecond: 20,
      maxTolerance: 400,
      tickIntervalMs: 1000,
    },

    bot: {
      enabled: readBoolean('BOT_ENABLED', false),
      joinAfterSeconds: readNumber('BOT_JOIN_AFTER_SECONDS', 8),
    },

    stats: {
      baseUrl: readString('STATS_API_URL', 'http://localhost:4000'),
      apiKey: readString('STATS_API_KEY', 'dev-api-key'),
      webhookSecret: readString('STATS_WEBHOOK_SECRET', 'dev-webhook-secret'),
      timeoutMs: readNumber('STATS_TIMEOUT_MS', 2500),
      /** After this many failed calls in a row we stop calling the partner for `cooldownMs`. */
      failureThreshold: 3,
      cooldownMs: readNumber('STATS_COOLDOWN_SECONDS', 10) * 1000,
      /** Public URL of our webhook endpoint. When set, the server subscribes itself at the partner on start. */
      publicWebhookUrl: readString('PUBLIC_WEBHOOK_URL', null),
      outboxIntervalMs: 5000,
    },

  };

  // Overrides are merged one level deep, so { stats: { baseUrl } } keeps the other stats values.
  for (const [key, value] of Object.entries(overrides)) {
    const isSection = value && typeof value === 'object' && !Array.isArray(value);
    config[key] = isSection ? { ...config[key], ...value } : value;
  }
  return config;
}
