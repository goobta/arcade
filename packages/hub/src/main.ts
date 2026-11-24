import { loadConfig } from "./config.ts";
import { createHub } from "./hub.ts";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`arcade: ${(error as Error).message}`);
  process.exit(1);
}

const hub = createHub(config);
hub.server.listen(config.port, config.host, () => {
  console.log(`arcade hub listening on ${config.host}:${config.port} (${config.publicUrl.origin})`);
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`arcade: ${signal}, stopping games`);
  // Never hang a container stop on a slow close.
  setTimeout(() => process.exit(0), 8000).unref();
  await hub.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
