/**
 * Outil d'état git en direct, sur un projet ou sur tout l'écosystème.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inventorier, nomsDisponibles, resoudreDepot, type Depot } from "../core/depots.js";
import { lireEtatGit, lireHistorique } from "../core/git.js";
import { erreur, formaterAnciennete, json, protege } from "../utils/reponse.js";

export function enregistrerOutilsGit(server: McpServer): void {
  server.tool(
    "etat_git",
    [
      "État git en direct, lu au moment de l'appel : branche courante, dernier commit avec sa date et son auteur, nombre de fichiers modifiés non commités, avance et retard sur le dépôt distant, et niveau d'activité du projet (actif si moins de 30 jours, ralenti jusqu'à 120 jours, dormant au delà).",
      "Sans paramètre « projet », renvoie le tableau de bord de TOUS les dépôts d'un coup, trié du plus récemment touché au plus ancien : c'est la façon la plus rapide de savoir sur quoi François travaille en ce moment et ce qu'il a laissé en chantier.",
      "Avec un « projet », se concentre dessus et peut remonter l'historique des derniers commits.",
      "Strictement en lecture : cet outil n'exécute aucune commande git qui modifie quoi que ce soit, ni add, ni commit, ni push, ni checkout, ni fetch.",
    ].join(" "),
    {
      projet: z
        .string()
        .optional()
        .describe(
          "Nom ou chemin absolu d'un projet pour n'examiner que celui-là. Si absent, tous les dépôts git sont examinés."
        ),
      nb_commits: z
        .number()
        .int()
        .min(0)
        .max(50)
        .default(0)
        .describe(
          "Nombre de commits récents à détailler. Ignoré quand aucun « projet » n'est précisé, pour garder la réponse compacte."
        ),
      seulement_modifies: z
        .boolean()
        .default(false)
        .describe(
          "Ne garder que les dépôts qui ont des modifications non commitées. Pratique pour répondre à la question : qu'est-ce que j'ai laissé en cours ?"
        ),
    },
    protege("etat_git", async ({ projet, nb_commits, seulement_modifies }) => {
      const debut = Date.now();
      const depots = await inventorier();

      // --- Un seul projet ---
      if (projet) {
        const depot = await resoudreDepot(projet, depots);
        if (!depot) {
          return erreur(
            `Aucun projet ne correspond à « ${projet} ».`,
            `Projets disponibles : ${nomsDisponibles(depots).join(", ")}.`
          );
        }
        if (!depot.versionne) {
          return json({
            projet: depot.nom,
            chemin: depot.chemin,
            versionne: false,
            message:
              "Ce dossier n'est pas un dépôt git, il n'a donc ni branche ni historique.",
          });
        }

        const etat = await lireEtatGit(depot.chemin, { apercuModifications: 25 });
        const historique =
          nb_commits > 0 ? await lireHistorique(depot.chemin, nb_commits) : undefined;

        return json({
          projet: depot.nom,
          chemin: depot.chemin,
          versionne: true,
          branche: etat.branche,
          remote_origin: etat.remoteOrigin,
          dernier_commit: etat.dernierCommit,
          anciennete: formaterAnciennete(etat.joursDepuisDernierCommit),
          activite: etat.activite,
          fichiers_modifies: etat.fichiersModifies,
          detail_modifications: etat.apercuModifications,
          avance_sur_le_distant: etat.avance,
          retard_sur_le_distant: etat.retard,
          commits_recents: historique,
          probleme: etat.probleme,
          duree_ms: Date.now() - debut,
        });
      }

      // --- Tous les dépôts ---
      const versionnes = depots.filter((d: Depot) => d.versionne);
      const etats = await Promise.all(
        versionnes.map(async (d) => {
          const etat = await lireEtatGit(d.chemin, { apercuModifications: 5 });
          return {
            projet: d.nom,
            chemin: d.chemin,
            branche: etat.branche,
            dernier_commit: etat.dernierCommit
              ? {
                  date: etat.dernierCommit.date,
                  sujet: etat.dernierCommit.sujet,
                  hash: etat.dernierCommit.hash,
                }
              : null,
            anciennete: formaterAnciennete(etat.joursDepuisDernierCommit),
            jours: etat.joursDepuisDernierCommit,
            activite: etat.activite,
            fichiers_modifies: etat.fichiersModifies,
            detail_modifications:
              etat.fichiersModifies > 0 ? etat.apercuModifications : undefined,
            avance_sur_le_distant: etat.avance ?? undefined,
            probleme: etat.probleme ?? undefined,
          };
        })
      );

      const filtres = seulement_modifies
        ? etats.filter((e) => e.fichiers_modifies > 0)
        : etats;

      filtres.sort((a, b) => (a.jours ?? 99999) - (b.jours ?? 99999));

      return json({
        nombre_de_depots: filtres.length,
        depots_actifs: etats.filter((e) => e.activite === "actif").length,
        depots_dormants: etats.filter((e) => e.activite === "dormant").length,
        depots_avec_travaux_en_cours: etats.filter((e) => e.fichiers_modifies > 0).length,
        duree_ms: Date.now() - debut,
        depots: filtres.map(({ jours, ...reste }) => reste),
      });
    })
  );
}
