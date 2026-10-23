import { app } from "./app.js";
import { env } from "./config/env.js";

const server = app.listen(env.port, () => {
  console.log("");
  console.log("  EasyHome API v2");
  console.log(`  http://localhost:${env.port}`);
  console.log(`  env: ${env.nodeEnv}${env.emulator ? " (Firebase emulators)" : ""}`);
  console.log("");
});

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
