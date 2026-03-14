// lib/socketClient.ts
import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

export function getSocket(): Socket | null {
  if (typeof window === "undefined") return null;

  if (!socket) {
    socket = io({
      path: "/api/socket/io",      // MUST match server
      transports: ["websocket"],   // avoid polling weirdness
      withCredentials: true,      // send cookies for handshake auth
    });
  }

  return socket;
}
