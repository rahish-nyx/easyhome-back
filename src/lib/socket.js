import { Server } from "socket.io";

let io = null;

/**
 * Attach Socket.io to the Express HTTP server.
 * CORS is open so the Capacitor Android / iOS shells and any web client
 * can connect from the EasyHome frontend and worker apps.
 */
export function initSocket(httpServer) {
  if (io) return io;
  io = new Server(httpServer, {
    path: "/socket.io",
    cors: {
      origin: "*",
      methods: ["GET", "POST", "OPTIONS"],
    },
  });

  io.on("connection", (socket) => {
    console.log(`[socket] client connected: ${socket.id}`);
    socket.on("join", (payload = {}) => {
      const userId = String(payload?.userId || payload?.uid || "");
      const role = String(payload?.role || "");
      if (userId) socket.join(`user_${userId}`);
      if (role === "worker") socket.join("workers");
      socket.data.userId = userId;
      socket.data.role = role;
    });
    socket.on("disconnect", (reason) => {
      console.log(`[socket] client disconnected: ${socket.id} (${reason})`);
    });
  });

  return io;
}

export function getIO() {
  return io;
}

export const realtimeRooms = {
  user: (userId) => `user_${userId}`,
  workers: "workers",
};

export function emitToUser(userId, event, payload) {
  if (!io || !userId) return;
  io.to(realtimeRooms.user(String(userId))).emit(event, payload);
}

export function emitToWorkers(event, payload) {
  if (!io) return;
  io.to(realtimeRooms.workers).emit(event, payload);
}

/**
 * Broadcast a booking lifecycle change to the customer and / or the worker
 * that owns the job, so both mobile dashboards can refresh instantly.
 */
export function emitBookingStatusUpdate({ bookingId, status, workerId, customerId, ...rest } = {}) {
  const payload = { bookingId, status, ...rest };
  if (workerId) emitToUser(workerId, "bookingStatusUpdate", payload);
  if (customerId) emitToUser(customerId, "bookingStatusUpdate", payload);
}
