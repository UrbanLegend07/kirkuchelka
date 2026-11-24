/**
 * WebSocket test client: collects every message from the server and lets a test
 * wait for the next message of a given type.
 */
import { once } from 'node:events';
import { WebSocket } from 'ws';

export async function connectClient(port) {
  const socket = new WebSocket(`ws://localhost:${port}/ws`);
  const unreadMessages = [];
  socket.on('message', (rawData) => unreadMessages.push(JSON.parse(rawData.toString())));
  await once(socket, 'open');

  return {
    socket,

    send(type, payload) {
      socket.send(JSON.stringify(payload === undefined ? { type } : { type, payload }));
    },

    sendRaw(text) {
      socket.send(text);
    },

    /** Waits for (and removes) the first unread message of `type` that matches `predicate`. */
    async next(type, predicate = () => true, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const index = unreadMessages.findIndex((message) => message.type === type && predicate(message.payload ?? {}));
        if (index !== -1) {
          return unreadMessages.splice(index, 1)[0].payload ?? {};
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`No "${type}" message within ${timeoutMs} ms. Unread: ${JSON.stringify(unreadMessages.map((message) => message.type))}`);
    },

    hasUnread(type) {
      return unreadMessages.some((message) => message.type === type);
    },

    async close() {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
        await once(socket, 'close');
      }
    },
  };
}

/** Logs in and returns the auth.ok payload. */
export async function login(client, name) {
  client.send('auth', { name });
  return client.next('auth.ok');
}
