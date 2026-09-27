import { createServer } from "node:http";
import { parseArgs } from "node:util";
import next from "next";
import { createRoomServer } from "./rooms.mjs";

const { values } = parseArgs({ options: { port: { type: "string", short: "p" }, hostname: { type: "string", short: "H" }, dev: { type: "boolean", default: false } } });
const port = Number(values.port ?? process.env.PORT ?? 3000);
const hostname = values.hostname ?? "0.0.0.0";
const app = next({ dev: values.dev, hostname, port });
await app.prepare();
const handler = app.getRequestHandler();
const server = createServer((req, res) => handler(req, res));
const socketPath = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/socket.io`;
const rooms = createRoomServer(server, { path: socketPath });
const upgrade = app.getUpgradeHandler();
server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith(socketPath)) upgrade(req, socket, head);
});
server.listen(port, hostname, () => console.log(`Larchmere + multiplayer ready on ${hostname}:${port}${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, async () => {
  await rooms.close();
  await app.close();
  process.exit(0);
});
