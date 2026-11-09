import { createServer } from "node:http";
import { app } from "../src/app.js";
import { initSocket } from "../src/lib/socket.js";

const server = createServer(app);
initSocket(server);

export default server;
