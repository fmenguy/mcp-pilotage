/**
 * Outils d'inventaire : savoir quels projets existent, où ils vivent
 * et à quoi ils servent.
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inventorier, nomsDisponibles, resoudreDepot, type Depot } from "../core/depots.js";
import { recenserCerveau } from "../core/cerveau.js";
import { lireEtatGit, lireHistorique, lireBranches, type EtatGit } from "../core/git.js";
import { listerDossier, estExclu } from "../core/fichiers.js";
import { FAMILLES } from "../core/stack.js";
import {
  erreur,
  formaterAnciennete,
  json,
  protege,
  sansAccents,
  texte,
} from "../utils/reponse.js";

/**
 * Vue compacte d'un projet, destinée aux listes.
 * Les clés restent en ASCII, c'est la convention de sérialisation du serveur.
 */
function fiche(d: Depot) {
  return {
    nom: d.nom,
    chemin: d.chemin,
    versionne: d.versionne,
    famille: d.stack.famille,
    stack: d.stack.principale,
    technologies: d.stack.technologies,
    role: d.role.resume,
    source_du_role: d.role.source,
    documents_de_contexte: d.documentsPrioritaires,
    serveurs_mcp_declares: d.serveursMcp.length > 0 ? d.serveursMcp : undefined,
    probleme: d.probleme ?? undefined,
  };
}

function correspondFiltre(d: Depot, filtre: string): boolean {
  const terme = sansAccents(filtre);
  return (
    sansAccents(d.nom).includes(terme) ||
    sansAccents(d.chemin).includes(terme) ||
    sansAccents(d.role.resume ?? "").includes(terme) ||
    sansAccents(d.stack.principale).includes(terme) ||
    sansAccents(d.stack.famille).includes(terme) ||
    d.stack.technologies.some((t) => sansAccents(t).includes(terme))
  );
}

export function enregistrerOutilsInventaire(server: McpServer): void {
  // ------------------------------------------------------------------
  server.tool(
    "lister_projets",
    [
      "Inventaire de TOUS les projets de François présents sur cette machine, obtenu par un scan du disque en direct (aucun fichier de configuration, donc jamais périmé).",
      "Renvoie pour chaque projet : son nom, son chemin absolu, s'il est versionné sous git, sa pile technique détectée, son rôle résumé en une phrase (extrait de son CLAUDE.md, sinon de son README) et la liste de ses documents de contexte.",
      "Appelle cet outil en premier dès que tu as besoin de savoir ce qui existe en dehors du dépôt courant : l'utilisateur mentionne un projet que tu ne connais pas, tu cherches où vit une fonctionnalité, tu veux vérifier qu'un projet existe encore.",
      "N'inclut volontairement ni l'état git (voir etat_git) ni le contenu des documents (voir lire_cerveau), pour rester léger.",
    ].join(" "),
    {
      filtre: z
        .string()
        .optional()
        .describe(
          "Terme libre pour ne garder que les projets dont le nom, le chemin, le rôle ou la pile technique le contiennent. Exemple : « astro », « roman », « mcp ». La comparaison ignore la casse et les accents."
        ),
      famille: z
        .string()
        .optional()
        .describe(
          `Ne garder qu'une famille fonctionnelle. Valeurs possibles : « ${Object.values(FAMILLES).join(" », « ")} ». La comparaison ignore la casse et les accents.`
        ),
      inclure_non_versionnes: z
        .boolean()
        .default(true)
        .describe(
          "Inclure les dossiers de premier niveau qui ne sont pas des dépôts git. Certains projets réels de François vivent hors git (monorepo non initialisé, dossiers de stockage d'images), les ignorer donnerait une vision fausse."
        ),
      rafraichir: z
        .boolean()
        .default(false)
        .describe(
          "Forcer un nouveau scan du disque en ignorant le cache interne (60 secondes). À utiliser si un projet vient d'être créé ou supprimé."
        ),
    },
    protege("lister_projets", async ({ filtre, famille, inclure_non_versionnes, rafraichir }) => {
      const debut = Date.now();
      let depots = await inventorier(rafraichir);

      if (!inclure_non_versionnes) depots = depots.filter((d) => d.versionne);
      if (famille) {
        const f = sansAccents(famille);
        depots = depots.filter((d) => sansAccents(d.stack.famille) === f);
      }
      if (filtre) depots = depots.filter((d) => correspondFiltre(d, filtre));

      return json({
        nombre_de_projets: depots.length,
        depots_git: depots.filter((d) => d.versionne).length,
        dossiers_hors_git: depots.filter((d) => !d.versionne).length,
        duree_scan_ms: Date.now() - debut,
        lecture_seule: true,
        projets: depots.map(fiche),
      });
    })
  );

  // ------------------------------------------------------------------
  server.tool(
    "apercu_ecosysteme",
    [
      "Briefing de démarrage à froid : une synthèse markdown compacte de tout l'écosystème de François, projets regroupés par famille, avec pour chacun son rôle, sa pile, sa branche courante et sa dernière activité git.",
      "C'est l'outil à appeler au tout début d'une session quand tu arrives dans un dépôt sans contexte et que tu veux comprendre en un seul appel ce que François fabrique, combien de projets il a, lesquels sont vivants et lesquels dorment.",
      "Plus dense que lister_projets et déjà mis en forme. Si tu as besoin des données brutes pour les filtrer toi-même, utilise plutôt lister_projets.",
    ].join(" "),
    {
      inclure_git: z
        .boolean()
        .default(true)
        .describe(
          "Interroger git pour chaque dépôt (branche, date du dernier commit, niveau d'activité). Mettre à false rend la réponse quasi instantanée mais sans l'information de fraîcheur."
        ),
      rafraichir: z
        .boolean()
        .default(false)
        .describe("Forcer un nouveau scan du disque en ignorant le cache interne."),
    },
    protege("apercu_ecosysteme", async ({ inclure_git, rafraichir }) => {
      const debut = Date.now();
      const depots = await inventorier(rafraichir);

      const etats = new Map<string, EtatGit>();
      if (inclure_git) {
        const versionnes = depots.filter((d) => d.versionne);
        const resultats = await Promise.all(
          versionnes.map(async (d) => [d.chemin, await lireEtatGit(d.chemin, { apercuModifications: 0 })] as const)
        );
        for (const [chemin, etat] of resultats) etats.set(chemin, etat);
      }

      const familles = new Map<string, Depot[]>();
      for (const d of depots) {
        const cle = d.stack.famille;
        if (!familles.has(cle)) familles.set(cle, []);
        familles.get(cle)!.push(d);
      }

      const lignes: string[] = [];
      lignes.push("# Écosystème de François");
      lignes.push("");
      lignes.push(
        `${depots.filter((d) => d.versionne).length} dépôts git et ${depots.filter((d) => !d.versionne).length} dossiers hors git, scannés dans : ${[
          ...new Set(depots.map((d) => d.racine)),
        ].join(", ")}.`
      );
      lignes.push("");

      const ordreFamilles = [...familles.keys()].sort((a, b) => {
        if (a === FAMILLES.autre) return 1;
        if (b === FAMILLES.autre) return -1;
        return a.localeCompare(b, "fr");
      });

      for (const famille of ordreFamilles) {
        lignes.push(`## ${famille}`);
        lignes.push("");
        lignes.push("| Projet | Chemin | Pile | Rôle | Git |");
        lignes.push("|---|---|---|---|---|");
        for (const d of familles.get(famille)!.sort((a, b) => a.nom.localeCompare(b.nom, "fr"))) {
          const etat = etats.get(d.chemin);
          let colonneGit = d.versionne ? "(non interrogé)" : "hors git";
          if (d.versionne && etat) {
            if (!etat.disponible) {
              colonneGit = "illisible";
            } else {
              const modif =
                etat.fichiersModifies > 0
                  ? `, ${etat.fichiersModifies} fichier(s) modifié(s)`
                  : "";
              colonneGit = `${etat.branche ?? "?"}, ${etat.activite}, ${formaterAnciennete(etat.joursDepuisDernierCommit)}${modif}`;
            }
          }
          const role = (d.role.resume ?? "rôle non documenté").replace(/\|/g, "/");
          lignes.push(
            `| **${d.nom}** | \`${d.chemin}\` | ${d.stack.principale} | ${role} | ${colonneGit} |`
          );
        }
        lignes.push("");
      }

      const sansRole = depots.filter((d) => d.role.resume === null).map((d) => d.nom);
      if (sansRole.length > 0) {
        lignes.push(
          `Projets sans CLAUDE.md ni README exploitable, rôle à confirmer auprès de François : ${sansRole.join(", ")}.`
        );
        lignes.push("");
      }

      lignes.push(
        `Scan réalisé en ${Date.now() - debut} ms. Le serveur Pilotage est strictement en lecture seule, il ne modifie jamais ces dépôts.`
      );

      return texte(lignes.join("\n"));
    })
  );

  // ------------------------------------------------------------------
  server.tool(
    "decrire_projet",
    [
      "Fiche complète d'UN projet : chemin, dépôt distant, pile technique et dépendances marquantes, rôle déduit, état git détaillé, derniers commits, branches, documents de contexte disponibles et arborescence de surface.",
      "Utilise cet outil quand tu sais déjà de quel projet tu parles et que tu veux tout savoir dessus d'un coup, avant d'aller lire ses fichiers ou de conseiller François sur ce projet.",
      "Pour lire vraiment le contenu de son CLAUDE.md ou de son README, enchaîne avec lire_cerveau.",
    ].join(" "),
    {
      projet: z
        .string()
        .describe(
          "Nom du dossier du projet (par exemple « mon-api ») ou son chemin absolu. La correspondance est insensible à la casse et accepte un nom partiel s'il n'est pas ambigu."
        ),
      nb_commits: z
        .number()
        .int()
        .min(0)
        .max(50)
        .default(5)
        .describe("Nombre de commits récents à inclure dans la fiche."),
      inclure_arborescence: z
        .boolean()
        .default(true)
        .describe(
          "Inclure la liste des dossiers et fichiers de premier niveau, pour situer l'organisation du projet."
        ),
    },
    protege("decrire_projet", async ({ projet, nb_commits, inclure_arborescence }) => {
      const depots = await inventorier();
      const depot = await resoudreDepot(projet, depots);
      if (!depot) {
        return erreur(
          `Aucun projet ne correspond à « ${projet} ».`,
          `Projets disponibles : ${nomsDisponibles(depots).join(", ")}.`
        );
      }

      const [etat, historique, branches, documents] = await Promise.all([
        depot.versionne ? lireEtatGit(depot.chemin) : Promise.resolve(null),
        depot.versionne && nb_commits > 0
          ? lireHistorique(depot.chemin, nb_commits)
          : Promise.resolve([]),
        depot.versionne ? lireBranches(depot.chemin) : Promise.resolve([]),
        recenserCerveau(depot.chemin),
      ]);

      const arborescence = inclure_arborescence
        ? await listerSurface(depot.chemin)
        : undefined;

      return json({
        nom: depot.nom,
        chemin: depot.chemin,
        versionne: depot.versionne,
        famille: depot.stack.famille,
        pile: {
          principale: depot.stack.principale,
          technologies: depot.stack.technologies,
          manifestes: depot.stack.manifestes,
          nom_du_paquet: depot.stack.nomPaquet,
          description_du_paquet: depot.stack.descriptionPaquet,
        },
        role: depot.role.resume,
        source_du_role: depot.role.source,
        git: etat
          ? {
              branche: etat.branche,
              branches_locales: branches,
              remote_origin: etat.remoteOrigin,
              dernier_commit: etat.dernierCommit,
              anciennete: formaterAnciennete(etat.joursDepuisDernierCommit),
              activite: etat.activite,
              fichiers_modifies: etat.fichiersModifies,
              apercu_modifications: etat.apercuModifications,
              avance_sur_le_distant: etat.avance,
              retard_sur_le_distant: etat.retard,
              probleme: etat.probleme,
              commits_recents: historique,
            }
          : "projet hors git",
        documents_de_contexte: {
          prioritaires: documents.filter((d) => d.prioritaire).map((d) => d.chemin),
          autres: documents.filter((d) => !d.prioritaire).map((d) => d.chemin),
        },
        serveurs_mcp_declares: depot.serveursMcp,
        arborescence,
        prochaine_etape:
          "Pour lire le contenu des documents de contexte, appelle lire_cerveau avec ce même nom de projet.",
      });
    })
  );
}

/** Liste les entrées de premier niveau d'un projet, dossiers puis fichiers. */
async function listerSurface(racine: string): Promise<{ dossiers: string[]; fichiers: string[] }> {
  const entrees = await listerDossier(racine);
  const dossiers: string[] = [];
  const fichiers: string[] = [];
  for (const e of entrees) {
    if (e.isDirectory()) {
      if (estExclu(e.name)) continue;
      dossiers.push(e.name + "/");
    } else if (e.isFile()) {
      fichiers.push(e.name);
    }
  }
  return {
    dossiers: dossiers.sort((a, b) => a.localeCompare(b, "fr")).slice(0, 40),
    fichiers: fichiers.sort((a, b) => a.localeCompare(b, "fr")).slice(0, 40),
  };
}

/** Réexport pratique pour les tests. */
export const _internes = { listerSurface, fiche, correspondFiltre, path };
