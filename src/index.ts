#!/usr/bin/env node

/**
 * Pilotage, serveur MCP de cartographie des projets de François.
 *
 * Point d'entrée du serveur. Il expose, en lecture seule et via le transport
 * stdio, tout ce qu'un agent doit savoir pour comprendre l'écosystème :
 * l'inventaire des dépôts scanné en direct sur le disque, le contenu de leurs
 * fichiers de contexte, leur état git et une recherche transverse.
 *
 * Usage :
 *   node dist/index.js
 *
 * Configuration facultative par variables d'environnement, voir src/config.ts.
 *
 * @author François
 * @license MIT
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { config } from "./config.js";
import { enregistrerOutilsInventaire } from "./outils/inventaire.js";
import { enregistrerOutilsCerveau } from "./outils/cerveau.js";
import { enregistrerOutilsGit } from "./outils/git.js";
import { enregistrerOutilsRecherche } from "./outils/recherche.js";
import { enregistrerOutilsUsage } from "./outils/usage.js";
import { enregistrerOutilsAgents } from "./outils/agents.js";

const VERSION = "1.0.0";

async function main(): Promise<void> {
  const server = new McpServer(
    {
      name: "pilotage",
      version: VERSION,
    },
    {
      instructions: [
        "Ce serveur cartographie tous les projets de l'utilisateur présents sur sa machine.",
        "Il est conçu pour être branché dans n'importe lequel de ses dépôts : il te permet de découvrir seul l'écosystème complet, sans que l'utilisateur ait à te le décrire.",
        "Ordre d'usage conseillé quand tu démarres sans contexte : apercu_ecosysteme pour la vue d'ensemble, puis decrire_projet et lire_cerveau sur le projet qui t'intéresse, etat_git pour savoir ce qui bouge, chercher_partout et trouver_fichiers pour localiser un sujet à travers les dépôts.",
        "usage_ia_claude donne les tokens consommés et les factures de l'API Claude de l'utilisateur, utile par exemple pour sourcer un article de blog avec des chiffres réels.",
        "L'inventaire vient d'un scan du disque à chaque appel, il n'y a aucun fichier de configuration à maintenir, donc l'information n'est jamais périmée.",
        "suivi_agents dit où en est chaque agent de code actif (Codex, Claude Code, Mistral Vibe) et signale les suites de tests orphelines ou en doublon.",
        "Tous les outils sont strictement en lecture seule : ils n'écrivent, ne commitent et ne poussent jamais rien.",
      ].join(" "),
    }
  );

  enregistrerOutilsInventaire(server);
  enregistrerOutilsCerveau(server);
  enregistrerOutilsGit(server);
  enregistrerOutilsRecherche(server);
  enregistrerOutilsUsage(server);
  enregistrerOutilsAgents(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Les logs passent par stderr : stdout est réservé au protocole MCP.
  console.error(
    `[pilotage] serveur MCP v${VERSION} démarré, racines scannées : ${config.racines.join(" ; ")}`
  );
}

main().catch((err) => {
  console.error("[pilotage] erreur fatale :", err);
  process.exit(1);
});

// Un rejet non géré ne doit jamais tuer le serveur en pleine session.
process.on("unhandledRejection", (raison) => {
  console.error("[pilotage] promesse rejetée non gérée :", raison);
});
