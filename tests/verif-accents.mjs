/**
 * Vérification de l'accentuation et de l'encodage.
 *
 * 1. Vérifie que les fichiers source sont en UTF-8 valide, sans BOM.
 * 2. Affiche en entier les descriptions des outils et de leurs paramètres,
 *    telles qu'un modèle appelant les reçoit à travers le transport stdio.
 * 3. Compte les caractères accentués de chaque description.
 * 4. Contrôle les points de code réels du markdown généré, pour prouver que
 *    les accents traversent le transport intacts et ne dégénèrent pas en
 *    mojibake sur Windows.
 *
 * Les motifs de mojibake sont écrits en séquences d'échappement et non en
 * clair, sinon ce fichier de test se détecterait lui-même comme fautif.
 *
 * Usage : node tests/verif-accents.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racineProjet = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pointEntree = path.join(racineProjet, "dist", "index.js");

const ACCENTUES = /[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]/g;

/**
 * Un texte UTF-8 relu à tort en Latin-1 produit U+00C3 ou U+00C2 suivis d'un
 * caractère de la plage U+0080 à U+00BF. C'est la signature du mojibake.
 */
const MOJIBAKE = new RegExp(
  "[\u00C2\u00C3][\u0080-\u00BF]" + // UTF-8 relu en Latin-1
    "|\u00E2\u20AC" +                     // guillemets et tirets mal décodés
    "|\uFEFF"                                // marque d'ordre des octets égarée
);

/** Caractère de remplacement U+FFFD, signe d'un décodage UTF-8 raté. */
const REMPLACEMENT = String.fromCodePoint(0xfffd);

function compterAccents(texte) {
  return (texte.match(ACCENTUES) ?? []).length;
}

function titre(t) {
  console.log("\n" + "=".repeat(78));
  console.log(t);
  console.log("=".repeat(78));
}

let echecs = 0;
function verifier(condition, libelle) {
  console.log(`${condition ? "OK   " : "ECHEC"} ${libelle}`);
  if (!condition) echecs++;
}

async function main() {
  // ---------------------------------------------------------------
  titre("1. Encodage des fichiers source sur le disque");

  const fichiers = [];
  (function collecter(dossier) {
    for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const p = path.join(dossier, e.name);
      if (e.isDirectory()) collecter(p);
      else if (/\.(ts|mjs|md|json)$/.test(e.name)) fichiers.push(p);
    }
  })(racineProjet);

  let avecBom = 0;
  let invalides = 0;
  let mojibakeDisque = 0;
  for (const f of fichiers) {
    const brut = fs.readFileSync(f);
    if (brut[0] === 0xef && brut[1] === 0xbb && brut[2] === 0xbf) {
      avecBom++;
      console.log(`     BOM détecté : ${f}`);
    }
    const texte = brut.toString("utf8");
    if (texte.includes(REMPLACEMENT)) {
      invalides++;
      console.log(`     sequence UTF-8 invalide : ${f}`);
    }
    if (MOJIBAKE.test(texte)) {
      mojibakeDisque++;
      console.log(`     mojibake sur disque : ${f}`);
    }
  }
  console.log(`     ${fichiers.length} fichiers inspectés.`);
  verifier(avecBom === 0, "aucun fichier avec BOM");
  verifier(invalides === 0, "tous les fichiers sont de l'UTF-8 valide");
  verifier(mojibakeDisque === 0, "aucun mojibake dans les sources");

  // ---------------------------------------------------------------
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [pointEntree],
    env: { ...process.env },
  });
  const client = new Client({ name: "verif-accents", version: "1.0.0" });
  await client.connect(transport);

  titre("2. Descriptions des outils, en entier, telles que reçues en stdio");

  const { tools } = await client.listTools();
  let minAccents = Infinity;
  let mojibakeProtocole = 0;

  for (const t of tools) {
    const n = compterAccents(t.description);
    minAccents = Math.min(minAccents, n);
    if (MOJIBAKE.test(t.description)) mojibakeProtocole++;

    console.log(`\n--- ${t.name}  (${n} caractères accentués) ---`);
    console.log(t.description);

    const props = t.inputSchema.properties ?? {};
    for (const [nomParam, schema] of Object.entries(props)) {
      const d = schema.description ?? "(sans description)";
      if (MOJIBAKE.test(d)) mojibakeProtocole++;
      console.log(`  - ${nomParam} : ${d}`);
    }
  }

  console.log("");
  verifier(tools.length === 9, `9 outils déclarés (trouvés : ${tools.length})`);
  verifier(
    minAccents >= 5,
    `chaque description a au moins 5 caractères accentués (minimum observé : ${minAccents})`
  );
  verifier(mojibakeProtocole === 0, "aucun mojibake dans les descriptions reçues en stdio");

  // ---------------------------------------------------------------
  titre("3. Markdown généré par apercu_ecosysteme");

  const res = await client.callTool({
    name: "apercu_ecosysteme",
    arguments: { inclure_git: true },
  });
  const md = res.content.map((c) => c.text).join("\n");

  const attendus = [
    "# Écosystème de François",
    "dépôts git",
    "dossiers hors git",
    "scannés dans",
    "| Projet | Chemin | Pile | Rôle | Git |",
    "hors git",
    "Scan réalisé en",
    "lecture seule",
  ];
  for (const a of attendus) {
    verifier(md.includes(a), `le markdown contient « ${a} »`);
  }
  verifier(!MOJIBAKE.test(md), "aucun mojibake dans le markdown généré");
  verifier(!md.includes(REMPLACEMENT), "aucun caractère de remplacement dans le markdown");
  console.log(
    `     ${compterAccents(md)} caractères accentués dans ${md.length} caractères de markdown.`
  );

  // Contrôle des points de code réels, pas seulement de l'affichage terminal.
  const debut = md.indexOf("Écosystème");
  verifier(debut !== -1, "le titre « Écosystème » est présent");
  if (debut !== -1) {
    const mot = md.slice(debut, debut + 10);
    const points = [...mot].map((c) => c.codePointAt(0));
    console.log(`     points de code de « ${mot} » : ${points.join(", ")}`);
    verifier(points[0] === 0x00c9, "le É initial est bien U+00C9, un seul caractère");
    verifier(points[7] === 0x00e8, "le è est bien U+00E8, un seul caractère");
    verifier(points.length === 10, "le mot fait bien 10 caractères, pas 12 (donc pas de double encodage)");
  }

  // ---------------------------------------------------------------
  titre("4. Valeurs de repli, messages d'erreur et clés JSON");

  verifier(md.includes("rôle non documenté"), "la valeur de repli « rôle non documenté » est accentuée");

  const err = await client.callTool({
    name: "lire_cerveau",
    arguments: { projet: "projet-qui-nexiste-pas" },
  });
  const texteErr = err.content.map((c) => c.text).join("\n");
  console.log(texteErr);
  verifier(texteErr.includes("correspond à"), "le message d'erreur est accentué");
  verifier(!MOJIBAKE.test(texteErr), "aucun mojibake dans le message d'erreur");

  const diag = await client.callTool({ name: "diagnostic_pilotage", arguments: {} });
  const texteDiag = diag.content.map((c) => c.text).join("\n");
  verifier(texteDiag.includes("racines_scannees"), "les clés JSON restent en ASCII");
  verifier(texteDiag.includes("séparés par des points-virgules"), "les valeurs textuelles sont accentuées");
  verifier(texteDiag.includes("Aucun accès réseau."), "les garanties sont accentuées");

  // Seule famille accentuée : la vérification n'a de sens que si les racines
  // scannées contiennent au moins un projet d'écriture.
  const tous = await client.callTool({ name: "lister_projets", arguments: {} });
  const ecriture = tous.content.map((c) => c.text).join("\n").includes("Écriture et romans");
  if (!ecriture) {
    console.log("(filtre sans accent non vérifié : aucun projet « Écriture et romans » dans les racines scannées)");
  } else {
    const liste = await client.callTool({
      name: "lister_projets",
      arguments: { famille: "Ecriture et romans" },
    });
    const texteListe = liste.content.map((c) => c.text).join("\n");
    const nb = JSON.parse(texteListe).nombre_de_projets;
    verifier(
      nb > 0,
      `le filtre famille accepte la forme sans accent « Ecriture et romans » (${nb} projets)`
    );
    verifier(
      texteListe.includes("Écriture et romans"),
      "mais la valeur renvoyée reste accentuée"
    );
  }

  await client.close();

  titre(echecs === 0 ? "TOUTES LES VÉRIFICATIONS PASSENT" : `${echecs} VÉRIFICATION(S) EN ÉCHEC`);
  process.exit(echecs === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Échec du test :", err);
  process.exit(1);
});
