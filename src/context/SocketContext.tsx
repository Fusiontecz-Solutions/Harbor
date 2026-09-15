import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
}

const SocketContext = createContext<SocketContextType>({
  socket: null,
  isConnected: false,
});

export const useSocket = () => useContext(SocketContext);

interface SocketProviderProps {
  children: ReactNode;
}

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:4000';

/**
 * Split VITE_SOCKET_URL into an origin and an engine.io `path`.
 *
 * socket.io-client reads any path in the connection URL as a NAMESPACE, not as
 * a prefix for the engine.io endpoint. In production VITE_SOCKET_URL is
 * `https://…/backend`, so the client was asking for `/socket.io/` at the site
 * root — which nginx answers with the SPA's index.html — instead of
 * `/backend/socket.io/`. The handshake never parsed, the socket never
 * connected, and the inbox sat on its REST polling fallback forever.
 */
function resolveSocketTarget(raw: string): { origin: string; path: string } {
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : undefined;
    const url = new URL(raw, base);
    const prefix = url.pathname.replace(/\/+$/, '');
    return { origin: url.origin, path: `${prefix}/socket.io` };
  } catch {
    return { origin: raw, path: '/socket.io' };
  }
}

const { origin: SOCKET_ORIGIN, path: SOCKET_PATH } = resolveSocketTarget(SOCKET_URL);

export const SocketProvider = ({ children }: SocketProviderProps) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const path =
      typeof window !== 'undefined' ? window.location.pathname : '';
    if (path === '/decision-logic' || path.startsWith('/decision-logic/')) {
      return;
    }

    // Get token from localStorage or sessionStorage
    const token = localStorage.getItem('token') || sessionStorage.getItem('token');

    if (!token) {
      return;
    }

    // Initialize Socket.IO connection (polling first, then upgrade to websocket for better compatibility)
    const newSocket = io(SOCKET_ORIGIN, {
      path: SOCKET_PATH,
      auth: {
        token,
      },
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 10,
      timeout: 25000,
      forceNew: false,
      withCredentials: false,
    });

    newSocket.on('connect', () => {
      console.log('✅ Socket.IO connected');
      setIsConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.log('❌ Socket.IO disconnected');
      setIsConnected(false);
    });

    newSocket.on('connect_error', (error) => {
      console.error('Socket.IO connection error:', error.message);
      setIsConnected(false);
    });

    setSocket(newSocket);

    // Cleanup on unmount
    return () => {
      newSocket.close();
    };
  }, []);

  return (
    <SocketContext.Provider value={{ socket, isConnected }}>
      {children}
    </SocketContext.Provider>
  );
};
