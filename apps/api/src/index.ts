import { apiPort } from "./config.js";
import { buildServer } from "./server.js";

const app = buildServer();

await app.listen({ host: "127.0.0.1", port: apiPort });
