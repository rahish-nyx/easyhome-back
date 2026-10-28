import { app } from "./app.js";
import { env } from "./config/env.js";
import { connectDb } from "./config/db.js";
import { startTrackingWatchdog } from "./lib/tracking.js";

connectDb().catch((error) => {
  console.error("MongoDB is not available at startup:", error.message);
});

const server = app.listen(env.port, () => {
  console.log("");
  console.log("  EasyHome API v2");
  console.log(`  http://localhost:${env.port}`);
  console.log(`  env: ${env.nodeEnv} (MongoDB Atlas)`);
  console.log("");
});

// Lightweight in-process accountability watchdog. The worker PWA also runs a
// local watchdog so the buzzer fires immediately even on a slow connection.
startTrackingWatchdog();

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — closing server…`);

  const force = setTimeout(() => {
    console.error("Forced shutdown after 10s");
    process.exit(1);
  }, 10_000);
  force.unref();

  server.close(() => {
    console.log("Server closed cleanly.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  shutdown("uncaughtException");
});

export default server;
