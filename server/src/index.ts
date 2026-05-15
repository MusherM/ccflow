import http from "node:http";
import { createApp, attachWebSocket } from "./api.js";
import { GitService } from "./git.js";
import { Store } from "./storage.js";
import { TmuxRuntime } from "./tmux.js";

const services = {
  store: new Store(),
  git: new GitService(),
  tmux: new TmuxRuntime()
};

const app = createApp(services);
const server = http.createServer(app);
const wss = attachWebSocket(server, services);

const port = Number(process.env.PORT ?? 4389);
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.log(`CCFlow daemon already appears to be running on http://127.0.0.1:${port}`);
    process.exit(0);
  }
  throw error;
});

wss.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.log(`CCFlow websocket already appears to be running on http://127.0.0.1:${port}`);
    process.exit(0);
  }
  throw error;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`CCFlow daemon listening on http://127.0.0.1:${port}`);
});
