/**
 * Outil d'usage de l'API Claude : tokens consommés et factures.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import {
  agregerPar,
  agregerParMois,
  lireFactures,
  lireLignesTokens,
} from "../core/usage.js";
import { erreur, json, protege } from "../utils/reponse.js";

const NOMS_MOIS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

function libelleMois(mois: string): string {
  const [annee, m] = mois.split("-");
  const index = Number.parseInt(m, 10) - 1;
  return NOMS_MOIS[index] ? `${NOMS_MOIS[index]} ${annee}` : mois;
}

export function enregistrerOutilsUsage(server: McpServer): void {
  server.tool(
    "usage_ia_claude",
    [
      "Usage de l'API Claude de l'utilisateur : tokens consommés et factures, lus en direct depuis le dossier usage/ (réglable par PILOTAGE_DOSSIER_USAGE).",
      "Source des tokens : un export CSV par mois (un token compte pour de l'entrée, cache compris, ou de la sortie), déposé à la main par l'utilisateur. Source des factures : un tableau tenu à la main, indépendant des exports de tokens (il mélange abonnement et usage mesuré, les montants ne se déduisent pas des tokens).",
      "Sans paramètre, renvoie la période complète : totaux, détail mois par mois avec répartition par projet et par modèle, classement des projets et des modèles sur toute la période, et la liste des factures.",
      "Avec « mois », se concentre sur un seul mois (répartition par projet et par modèle de ce mois-là uniquement) ; les factures restent toujours renvoyées en entier car leurs dates ne correspondent pas forcément au mois d'usage.",
      "Utile pour écrire un article de blog transparent sur le coût ou l'usage de l'IA : les chiffres sont prêts à citer, avec leurs libellés en clair.",
      "Strictement en lecture : ne modifie jamais les fichiers du dossier usage/.",
    ].join(" "),
    {
      mois: z
        .string()
        .regex(/^\d{4}-\d{2}$/, "Format attendu : AAAA-MM, par exemple 2026-07")
        .optional()
        .describe(
          "Mois précis à isoler, au format AAAA-MM. Si absent, toute la période disponible est renvoyée."
        ),
    },
    protege("usage_ia_claude", async ({ mois }) => {
      const debut = Date.now();
      const lignes = await lireLignesTokens();
      const factures = await lireFactures();

      const factureNette = Math.round(factures.reduce((s, f) => s + f.total_eur, 0) * 100) / 100;

      if (lignes.length === 0) {
        return erreur(
          "Aucun export de tokens trouvé.",
          `Dossier attendu : ${config.dossierUsage}, fichiers nommés claude_api_tokens_AAAA_MM.csv.`
        );
      }

      const parMois = agregerParMois(lignes);
      const moisDisponibles = parMois.map((m) => m.mois);

      if (mois) {
        const trouve = parMois.find((m) => m.mois === mois);
        if (!trouve) {
          return erreur(
            `Aucune donnée pour le mois « ${mois} ».`,
            `Mois disponibles : ${moisDisponibles.join(", ")}.`
          );
        }
        return json({
          mois: trouve.mois,
          libelle: libelleMois(trouve.mois),
          entree: trouve.entree,
          sortie: trouve.sortie,
          total: trouve.total,
          recherches_web: trouve.recherches_web,
          par_projet: trouve.par_projet,
          par_modele: trouve.par_modele,
          factures: {
            net_eur: factureNette,
            nombre: factures.length,
            note: "Liste complète, non filtrée sur ce mois : voir la remarque sur les factures dans la description de l'outil.",
            lignes: factures,
          },
          duree_ms: Date.now() - debut,
        });
      }

      const totalEntree = parMois.reduce((s, m) => s + m.entree, 0);
      const totalSortie = parMois.reduce((s, m) => s + m.sortie, 0);
      const totalRecherches = parMois.reduce((s, m) => s + m.recherches_web, 0);

      return json({
        periode: { debut: moisDisponibles[0], fin: moisDisponibles[moisDisponibles.length - 1] },
        tokens: {
          entree: totalEntree,
          sortie: totalSortie,
          total: totalEntree + totalSortie,
          recherches_web: totalRecherches,
        },
        par_mois: parMois.map((m) => ({
          mois: m.mois,
          libelle: libelleMois(m.mois),
          entree: m.entree,
          sortie: m.sortie,
          total: m.total,
          recherches_web: m.recherches_web,
          par_projet: m.par_projet,
          par_modele: m.par_modele,
        })),
        par_projet: agregerPar(lignes, "projet").map((p) => ({
          projet: p.nom,
          total: p.total,
          part_pct: p.part_pct,
        })),
        par_modele: agregerPar(lignes, "modele").map((m) => ({
          modele: m.nom,
          total: m.total,
          part_pct: m.part_pct,
        })),
        factures: {
          net_eur: factureNette,
          nombre: factures.length,
          lignes: factures,
        },
        chemin_donnees: config.dossierUsage,
        duree_ms: Date.now() - debut,
      });
    })
  );
}
