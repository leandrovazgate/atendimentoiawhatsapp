/**
 * Valida o token do TomTicket e mostra os IDs de departamento/categoria para o .env.
 *   npm run tomticket:check                      -> lista departamentos e categorias
 *   npm run tomticket:check -- fulano@empresa.com -> testa também a busca de um cliente
 * Somente leitura: não cria nem altera nada.
 */
import { existsSync } from "node:fs";
import { TomTicketClient } from "../src/integrations/tomticket.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const token = process.env.TOMTICKET_TOKEN?.trim();
if (!token) {
  console.error("Defina TOMTICKET_TOKEN no .env");
  process.exit(1);
}
const client = new TomTicketClient(
  (process.env.TOMTICKET_BASE_URL ?? "https://api.tomticket.com/v2.0").replace(/\/$/, ""),
  token,
);

const deps = await client.request("GET", "department/list", { show_nested_items: 1 });
console.log("Departamentos (use o id em TOMTICKET_DEPARTMENT_ID):");
for (const d of (Array.isArray(deps.data) ? deps.data : []) as Array<Record<string, any>>) {
  console.log(`- ${d.id}  ${d.name}`);
  for (const c of (d.categories ?? []) as Array<Record<string, any>>) console.log(`    categoria ${c.id}  ${c.name}`);
}

const email = process.argv[2];
if (email) {
  const customer = await client.findCustomerByEmail(email);
  console.log(customer ? { ...customer, raw: undefined } : `Cliente ${email} não encontrado.`);
  if (customer) {
    const tickets = await client.listCustomerTickets(customer.email, { onlyOpen: true });
    console.log(`Chamados em aberto: ${tickets.length}`, tickets.slice(0, 5));
  }
}
