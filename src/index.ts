import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { ChannelRegistry } from "./channels/registry.js";
import { WhatsAppClient } from "./channels/whatsapp.js";
import { Store } from "./store/db.js";
import { TomTicketClient } from "./integrations/tomticket.js";
import { SupportAgent } from "./agent/agent.js";
import { MessageProcessor } from "./conversation/processor.js";
import { buildServer } from "./server.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig();
const channels = ChannelRegistry.fromEnv();
const store = new Store(config.databasePath);
const tomticket = new TomTicketClient(config.tomticket.baseUrl, config.tomticket.token);
const whatsapp = new WhatsAppClient(config.whatsapp.graphApiVersion);
const agent = new SupportAgent(new Anthropic(), config);

let app: ReturnType<typeof buildServer>;
const log = (msg: string, data?: unknown) => app.log.info({ data }, msg);

const processor = new MessageProcessor({ config, channels, whatsapp, store, tomticket, agent, log });
app = buildServer({ config, store, processor });

await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info(`Canais ativos: ${channels.list().map((c) => `${c.label} (${c.phoneNumberId})`).join(", ")}`);
app.log.info(`Modelo: ${config.anthropic.model} (effort ${config.anthropic.effort})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info("Encerrando: aguardando conversas em andamento...");
    await app.close();
    await processor.drain();
    process.exit(0);
  });
}
