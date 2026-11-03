/**
 * Client de test MCP en stdio.
 *
 * Démarre le serveur Pilotage compilé, appelle chaque outil avec des
 * paramètres réels et affiche un résumé vérifiable, temps de réponse inclus.
 * Le projet interrogé est ce dépôt lui-même, présent dans la racine scannée
 * par défaut (le dossier parent). Les variables PILOTAGE_* sont transmises.
 *
 * Usage : node tests/client-test.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racineProjet = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pointEntree = path.join(racineProjet, "dist", "index.js");
const ceProjet = path.basename(racineProjet);

function extraireTexte(resultat) {
  return (resultat.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function titre(texte) {
  console.log("\n" + "=".repeat(78));
  console.log(texte);
  console.log("=".repeat(78));
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [pointEntree],
    env: { ...process.env },
  });

  const client = new Client({ name: "test-pilotage", version: "1.0.0" });
  await client.connect(transport);

  titre("Outils exposes");
  const { tools } = await client.listTools();
  for (const t of tools) {
    console.log(`- ${t.name} : ${t.description.slice(0, 110)}...`);
    console.log(`  paramètres : ${Object.keys(t.inputSchema.properties ?? {}).join(", ") || "(aucun)"}`);
  }

  const appels = [
    ["diagnostic_pilotage", {}],
    ["lister_projets", { rafraichir: true }],
    ["lister_projets", { filtre: "astro" }],
    ["apercu_ecosysteme", { inclure_git: true }],
    ["decrire_projet", { projet: ceProjet, nb_commits: 3 }],
    ["lire_cerveau", { projet: ceProjet, max_caracteres: 900 }],
    ["lire_cerveau", { projet: ceProjet, lister_seulement: true }],
    ["lire_cerveau", { projet: "projet-qui-nexiste-pas" }],
    ["etat_git", {}],
    ["etat_git", { projet: ceProjet, nb_commits: 3 }],
    ["chercher_partout", { motif: "chercher_partout", max_resultats: 10 }],
    ["chercher_partout", { motif: "PILOTAGE_RACINES", filtre_fichiers: "*.md", max_resultats: 8 }],
    ["trouver_fichiers", { motif: "CLAUDE.md" }],
    ["trouver_fichiers", { motif: "**/*.mcp.json" }],
    ["usage_ia_claude", {}],
    ["usage_ia_claude", { mois: "2026-07" }],
    ["usage_ia_claude", { mois: "2099-01" }],
  ];

  const chronos = [];

  for (const [nom, args] of appels) {
    titre(`${nom}  ${JSON.stringify(args)}`);
    const debut = Date.now();
    let sortie;
    try {
      const resultat = await client.callTool({ name: nom, arguments: args });
      sortie = extraireTexte(resultat);
      if (resultat.isError) sortie = "[isError] " + sortie;
    } catch (err) {
      sortie = "[EXCEPTION] " + (err?.message ?? String(err));
    }
    const duree = Date.now() - debut;
    chronos.push([nom, JSON.stringify(args), duree]);
    const limite = Number(process.env.LIMITE_AFFICHAGE ?? 2200);
    console.log(sortie.length > limite ? sortie.slice(0, limite) + `\n[...] (${sortie.length} caractères au total)` : sortie);
    console.log(`\n-> ${duree} ms`);
  }

  titre("Temps de réponse");
  for (const [nom, args, duree] of chronos) {
    console.log(`${String(duree).padStart(6)} ms  ${nom} ${args}`);
  }

  await client.close();
}

main().catch((err) => {
  console.error("Échec du test :", err);
  process.exit(1);
});
