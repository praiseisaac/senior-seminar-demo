// Peer-to-peer TCP messenger (Bun + TypeScript + Node 'net').
// - Starts a local TCP server so you can RECEIVE messages.
// - Provides a REPL so you can SEND messages to classmates.
// Protocol: NDJSON (one JSON per line)
//
// Usage (run your listener + REPL):
//   npm run peer -- --name "Alice" --port 5050
//
// Send one-off (no REPL, good for scripting):
//   npm run send -- --name "Alice" --to 10.0.0.42 --port 5050 --text "Hello!"
//
// In the REPL, type:
//   /send 10.0.0.42 Hello from Alice!
//   /help
//   /quit

import net from "node:net";

type Msg = { type: "msg"; from: string; text: string };
type Ack = { type: "ack"; ok: boolean; receivedAt?: number; error?: string };

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

const SEND_MODE = has("--send");              // one-off send and exit
const NAME = arg("--name") || "Anonymous";
const PORT = Number(arg("--port", "5050"));
const TO = arg("--to");                       // target IP for send-mode or REPL /send
const TEXT = arg("--text");                   // message text for send-mode

if (Number.isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error("Invalid --port. Use 1..65535");
  process.exit(1);
}

function sendMessage(opts: { host: string; port: number; from: string; text: string; jsonOnly?: boolean }): Promise<Ack | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: opts.host, port: opts.port }, () => {
      const payload: Msg = { type: "msg", from: opts.from, text: opts.text };
      socket.write(JSON.stringify(payload) + "\n");
    });

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        const line = buf.slice(0, idx);
        try {
          const ack = JSON.parse(line) as Ack;
          resolve(ack);
        } catch {
          resolve(null);
        }
        socket.end();
      }
    });

    socket.on("error", (e) => {
      console.error(`Connection error to ${opts.host}:${opts.port} ->`, (e as Error).message);
      resolve(null);
    });

    socket.on("close", () => {
      // no-op; resolve happens on first ack or error
    });
  });
}

function startServer(port: number) {
  const server = net.createServer((socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    let buf = "";

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line) as Partial<Msg>;
          if (msg?.type === "msg" && typeof msg.from === "string" && typeof msg.text === "string") {
            // Print incoming message
            const ts = new Date().toLocaleTimeString();
            console.log(`[${ts}] <- ${msg.from}@${remote}: ${msg.text}`);
            const ack: Ack = { type: "ack", ok: true, receivedAt: Math.floor(Date.now() / 1000) };
            socket.write(JSON.stringify(ack) + "\n");
          } else {
            const err: Ack = { type: "ack", ok: false, error: "unknown_type_or_shape" };
            socket.write(JSON.stringify(err) + "\n");
          }
        } catch {
          const err: Ack = { type: "ack", ok: false, error: "bad_json" };
          socket.write(JSON.stringify(err) + "\n");
        }
      }
    });

    socket.on("error", (e) => console.error("Socket error:", (e as Error).message));
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Listening for peers on port ${port}`);
    console.log(`Commands: /send <ip> <message...> | /help | /quit`);
  });

  return server;
}

// --- One-off send mode (no REPL) ---
if (SEND_MODE) {
  if (!TO || !TEXT) {
    console.error("Usage: bun run src/peer.ts --send --name <you> --to <peer_ip> --port <peer_port> --text <msg>");
    process.exit(1);
  }
  sendMessage({ host: TO, port: PORT, from: NAME, text: TEXT }).then((ack) => {
    if (ack) {
      console.log(ack);
      process.exit(ack.ok ? 0 : 1);
    } else {
      console.error("No ack / invalid response");
      process.exit(1);
    }
  });
} else {
  // --- Combined listener + REPL ---
  startServer(PORT);

  // Simple REPL for sending messages
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (raw) => {
    const line = raw.trim();
    if (!line) return;

    if (line === "/help") {
      console.log("Commands:\n  /send <ip> <message...>\n  /quit\n  /help");
      return;
    }
    if (line === "/quit") {
      console.log("Goodbye!");
      process.exit(0);
    }
    if (line.startsWith("/send ")) {
      const parts = line.split(" ").slice(1);
      const host = parts.shift();
      const text = parts.join(" ").trim();
      if (!host || !text) {
        console.log("Usage: /send <ip> <message...>");
        return;
      }
      const ack = await sendMessage({ host, port: PORT, from: NAME, text });
      if (ack) {
        const ts = new Date().toLocaleTimeString();
        console.log(`[${ts}] -> ack from ${host}:${PORT}: ${JSON.stringify(ack)}`);
      } else {
        console.log(`No ack from ${host}:${PORT}`);
      }
      return;
    }

    console.log('Unknown command. Try "/help".');
  });

  console.log(`Your name: ${NAME}`);
  console.log(`Start typing to send:\n  /send <peer_ip> <message...>\n  e.g. /send 10.0.0.42 Hello there!`);
}
