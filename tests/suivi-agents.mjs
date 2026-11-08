/**
 * Appelle uniquement l'outil suivi_agents sur les vrais journaux de la machine.
 *
 * Usage : node tests/suivi-agents.mjs [fenetre_minutes] [filtre_session] [detail]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racineProjet = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [fenetre, session, detail] = process.argv.slice(2);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(racineProjet, "dist", "index.js")],
  env: { ...process.env },
});
const client = new Client({ name: "test-suivi-agents", version: "1.0.0" });
await client.connect(transport);

const args = {};
if (fenetre) args.fenetre_minutes = Number(fenetre);
if (session) args.session = session;
if (detail) args.detail = Number(detail);

const debut = Date.now();
const resultat = await client.callTool({ name: "suivi_agents", arguments: args });
console.log((resultat.content ?? []).map((c) => c.text).join("\n"));
console.log(`\n-> ${Date.now() - debut} ms${resultat.isError ? " (erreur)" : ""}`);
await client.close();
