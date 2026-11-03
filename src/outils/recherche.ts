/**
 * Outils de recherche transverse : trouver un texte ou un fichier
 * à travers tous les dépôts d'un coup.
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inventorier, nomsDisponibles, resoudreDepot, type Depot } from "../core/depots.js";
import { chercher, detecterRipgrep } from "../core/recherche.js";
import { correspondGlob, parcourir } from "../core/fichiers.js";
import { erreur, json, protege } from "../utils/reponse.js";

/** Résout la liste des projets à fouiller à partir du paramètre « projets ». */
async function resoudreCibles(
  demandes: string[] | undefined,
  depots: Depot[]
): Promise<{ cibles: Array<{ projet: string; chemin: string }>; inconnus: string[] }> {
  if (!demandes || demandes.length === 0) {
    return {
      cibles: depots.map((d) => ({ projet: d.nom, chemin: d.chemin })),
      inconnus: [],
    };
  }
  const cibles: Array<{ projet: string; chemin: string }> = [];
  const inconnus: string[] = [];
  for (const demande of demandes) {
    const depot = await resoudreDepot(demande, depots);
    if (depot) cibles.push({ projet: depot.nom, chemin: depot.chemin });
    else inconnus.push(demande);
  }
  return { cibles, inconnus };
}

export function enregistrerOutilsRecherche(server: McpServer): void {
  // ------------------------------------------------------------------
  server.tool(
    "chercher_partout",
    [
      "Cherche un texte ou une expression régulière dans le CONTENU des fichiers de tous les projets à la fois, et renvoie les correspondances groupées par projet avec le fichier et le numéro de ligne.",
      "C'est l'outil qui répond aux questions du type : où est-ce que j'ai déjà écrit ce personnage, dans quel projet se trouve cette clé d'API, quels dépôts utilisent cette dépendance, où ai-je documenté cette décision.",
      "Utilise ripgrep quand il est installé sur la machine, sinon un parcours interne équivalent. Les dossiers lourds (node_modules, dist, build, .astro, venv, __pycache__, .git) sont toujours exclus.",
      "Restreins la recherche avec « projets » et « filtre_fichiers » dès que tu peux : c'est plus rapide et le résultat est plus lisible.",
    ].join(" "),
    {
      motif: z
        .string()
        .min(2)
        .describe(
          "Texte à chercher. Interprété littéralement par défaut, ou comme une expression régulière si « regex » vaut true."
        ),
      regex: z
        .boolean()
        .default(false)
        .describe(
          "Interpréter « motif » comme une expression régulière plutôt que comme du texte littéral."
        ),
      sensible_casse: z
        .boolean()
        .default(false)
        .describe("Respecter la casse. Par défaut la recherche l'ignore."),
      projets: z
        .array(z.string())
        .optional()
        .describe(
          "Noms ou chemins des projets à fouiller. Si absent, tous les projets de l'inventaire sont fouillés."
        ),
      filtre_fichiers: z
        .string()
        .optional()
        .describe(
          "Motif glob sur le chemin des fichiers, par exemple « *.md », « **/*.ts » ou « src/**/*.py ». Réduit fortement le temps de réponse."
        ),
      max_resultats: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(60)
        .describe("Nombre total de correspondances renvoyées au maximum."),
      max_par_fichier: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(5)
        .describe(
          "Nombre maximal de correspondances conservées par fichier, pour éviter qu'un seul fichier ne monopolise le résultat."
        ),
    },
    protege(
      "chercher_partout",
      async ({
        motif,
        regex,
        sensible_casse,
        projets,
        filtre_fichiers,
        max_resultats,
        max_par_fichier,
      }) => {
        const debut = Date.now();
        const depots = await inventorier();
        const { cibles, inconnus } = await resoudreCibles(projets, depots);

        if (cibles.length === 0) {
          return erreur(
            "Aucun projet à fouiller.",
            `Projets disponibles : ${nomsDisponibles(depots).join(", ")}.`
          );
        }

        const resultat = await chercher(cibles, {
          motif,
          regex,
          sensibleCasse: sensible_casse,
          filtreFichiers: filtre_fichiers ?? null,
          maxResultats: max_resultats,
          maxParFichier: max_par_fichier,
          longueurLigne: 220,
        });

        // Regroupement par projet pour une lecture directe par le modèle.
        const parProjet = new Map<string, Array<{ fichier: string; ligne: number; texte: string }>>();
        for (const c of resultat.correspondances) {
          if (!parProjet.has(c.projet)) parProjet.set(c.projet, []);
          parProjet.get(c.projet)!.push({
            fichier: c.fichier,
            ligne: c.ligne,
            texte: c.texte,
          });
        }

        return json({
          motif,
          moteur: resultat.moteur,
          projets_fouilles: cibles.length,
          projets_inconnus: inconnus.length > 0 ? inconnus : undefined,
          total_correspondances: resultat.correspondances.length,
          resultat_tronque: resultat.tronque,
          duree_ms: Date.now() - debut,
          problemes: resultat.problemes.length > 0 ? resultat.problemes : undefined,
          resultats: [...parProjet.entries()].map(([projet, occurrences]) => ({
            projet,
            chemin: cibles.find((c) => c.projet === projet)?.chemin,
            occurrences,
          })),
        });
      }
    )
  );

  // ------------------------------------------------------------------
  server.tool(
    "trouver_fichiers",
    [
      "Cherche des fichiers par leur NOM ou leur chemin à travers tous les projets, via un motif glob.",
      "Complémentaire de chercher_partout qui fouille le contenu : ici tu réponds à des questions de localisation, par exemple où sont tous les CLAUDE.md, quels projets ont un fichier .mcp.json, où vivent les chapitres du roman, quels dépôts contiennent un Dockerfile.",
      "Les dossiers lourds (node_modules, dist, build, .astro, venv, __pycache__, .git) sont toujours ignorés.",
    ].join(" "),
    {
      motif: z
        .string()
        .min(1)
        .describe(
          "Motif glob appliqué au chemin relatif dans chaque projet. Exemples : « CLAUDE.md », « **/*.astro », « src/**/*.py », « **/Dockerfile ». Le « * » couvre un segment, le « ** » plusieurs."
        ),
      projets: z
        .array(z.string())
        .optional()
        .describe(
          "Noms ou chemins des projets à explorer. Si absent, tous les projets de l'inventaire sont explorés."
        ),
      max_resultats: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(150)
        .describe("Nombre total de fichiers renvoyés au maximum."),
      profondeur: z
        .number()
        .int()
        .min(1)
        .max(12)
        .default(8)
        .describe(
          "Profondeur maximale de descente dans l'arborescence de chaque projet."
        ),
    },
    protege("trouver_fichiers", async ({ motif, projets, max_resultats, profondeur }) => {
      const debut = Date.now();
      const depots = await inventorier();
      const { cibles, inconnus } = await resoudreCibles(projets, depots);

      if (cibles.length === 0) {
        return erreur(
          "Aucun projet à explorer.",
          `Projets disponibles : ${nomsDisponibles(depots).join(", ")}.`
        );
      }

      const resultats: Array<{ projet: string; fichiers: string[] }> = [];
      let total = 0;
      let tronque = false;

      for (const cible of cibles) {
        if (total >= max_resultats) {
          tronque = true;
          break;
        }
        const trouves = await parcourir(cible.chemin, {
          profondeurMax: profondeur,
          limiteFichiers: Math.max(50, max_resultats - total) * 20,
          filtre: (rel) =>
            correspondGlob(rel, motif) ||
            correspondGlob(path.basename(rel), motif),
        });
        if (trouves.length === 0) continue;
        const restant = max_resultats - total;
        const gardes = trouves.slice(0, restant).map((f) => f.relatif);
        if (trouves.length > gardes.length) tronque = true;
        total += gardes.length;
        resultats.push({ projet: cible.projet, fichiers: gardes });
      }

      return json({
        motif,
        projets_explores: cibles.length,
        projets_inconnus: inconnus.length > 0 ? inconnus : undefined,
        total_fichiers: total,
        resultat_tronque: tronque,
        duree_ms: Date.now() - debut,
        resultats,
      });
    })
  );

  // ------------------------------------------------------------------
  server.tool(
    "diagnostic_pilotage",
    [
      "Renvoie la configuration effective du serveur Pilotage : racines scannées, dossiers exclus, profondeur de scan, présence de ripgrep, durée du cache, et rappel des garanties de sécurité.",
      "Appelle cet outil quand un résultat te surprend (un projet manquant, une recherche vide, une lenteur) pour comprendre ce que le serveur voit réellement du disque avant de conclure.",
    ].join(" "),
    {},
    protege("diagnostic_pilotage", async () => {
      const { config } = await import("../config.js");
      const debut = Date.now();
      const depots = await inventorier(true);
      const dureeScan = Date.now() - debut;
      const rg = await detecterRipgrep();

      return json({
        version: "1.0.0",
        racines_scannees: config.racines,
        profondeur_de_scan: config.profondeur,
        dossiers_exclus: [...config.dossiersExclus].sort(),
        cache_ms: config.ttlCacheMs,
        taille_max_fichier_octets: config.tailleMaxFichier,
        timeout_git_ms: config.timeoutGitMs,
        moteur_de_recherche: rg
          ? `ripgrep (${rg})`
          : "parcours Node interne (ripgrep introuvable sur cette machine)",
        projets_detectes: depots.length,
        duree_scan_complet_ms: dureeScan,
        variables_environnement_reconnues: [
          "PILOTAGE_RACINES (chemins séparés par des points-virgules)",
          "PILOTAGE_PROFONDEUR",
          "PILOTAGE_EXCLUSIONS",
          "PILOTAGE_CACHE_MS",
          "PILOTAGE_RIPGREP",
          "PILOTAGE_TIMEOUT_GIT_MS",
          "PILOTAGE_TAILLE_MAX_FICHIER",
        ],
        garanties: [
          "Lecture seule stricte : aucun outil n'écrit, ne crée, ne supprime ni ne renomme de fichier.",
          "Aucune commande git modifiante n'est utilisée (ni add, ni commit, ni push, ni checkout, ni fetch, ni reset).",
          "Aucun accès réseau.",
          "Les lectures sont confinées aux racines configurées et à l'intérieur des projets détectés.",
        ],
      });
    })
  );
}
