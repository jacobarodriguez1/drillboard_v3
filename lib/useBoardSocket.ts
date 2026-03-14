import { useEffect, useMemo, useState } from "react";
import { io, Socket } from "socket.io-client";
import type { BoardState } from "@/lib/state";

type UseBoardSocket = {
  socket: Socket | null;
  state: BoardState | null;
  connected: boolean;
};

export function useBoardSocket(): UseBoardSocket {
  const [state, setState] = useState<BoardState | null>(null);
  const [connected, setConnected] = useState(false);

  const socket = useMemo(() => {
    // prevent SSR socket creation
    if (typeof window === "undefined") return null;
    return io({
      path: "/api/socket/io",
      transports: ["websocket"],
      withCredentials: true, // send cookies for handshake auth
    });
  }, []);

  useEffect(() => {
    if (!socket) return;

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);

    // If your server event is "boardState" or similar, rename here:
    socket.on("state", (next: BoardState) => setState(next));

    // Ask for current state if your server supports it:
    socket.emit("getState");

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("state");
      socket.disconnect();
    };
  }, [socket]);

  return { socket, state, connected };
}
