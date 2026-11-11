/**
 * Outil d'usage de l'API Claude : tokens consommés, coûts en dollars et factures.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import {
  agregerCoutsPar,
  agregerCoutsParMois,
  agregerPar,
  agregerParMois,
  centimes,
  lireFactures,
  lireFacturesApi,
  lireLignesCouts,
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
      "Usage de l'API Claude de l'utilisateur : tokens consommés, coûts en dollars et factures, lus en direct depuis le dossier usage/ (réglable par PILOTAGE_DOSSIER_USAGE).",
      "Deux sources d'usage, exportées de la console Claude et déposées à la main, un fichier par mois : les tokens (un token compte pour de l'entrée, cache compris, ou de la sortie) et les coûts en dollars (par projet, modèle et type : jetons, recherche web, exécution de code, session d'agent). Les mois couverts ne sont pas forcément les mêmes pour les deux.",
      "Factures, tenues à la main et indépendantes de l'usage : celles de claude.ai en euros (elles mélangent abonnement et usage mesuré) et celles des recharges de la console en dollars.",
      "Sans paramètre, renvoie la période complète : totaux, détail mois par mois avec répartition par projet et par modèle, classements sur toute la période, et les factures.",
      "Avec « mois », se concentre sur un seul mois ; les factures restent toujours renvoyées en entier car leurs dates ne correspondent pas forcément au mois d'usage.",
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
      const lignesCouts = await lireLignesCouts();
      const factures = await lireFactures();
      const facturesApi = await lireFacturesApi();

      const blocFactures = {
        net_eur: centimes(factures.reduce((s, f) => s + f.total_eur, 0)),
        nombre: factures.length,
        lignes: factures,
      };
      const blocFacturesApi = {
        total_usd: centimes(facturesApi.reduce((s, f) => s + f.total_usd, 0)),
        nombre: facturesApi.length,
        lignes: facturesApi,
      };

      if (lignes.length === 0 && lignesCouts.length === 0) {
        return erreur(
          "Aucun export d'usage trouvé.",
          `Dossier attendu : ${config.dossierUsage}, fichiers nommés claude_api_tokens_AAAA_MM.csv ou claude_api_cost_AAAA_MM.csv.`
        );
      }

      const parMois = agregerParMois(lignes);
      const coutsParMois = agregerCoutsParMois(lignesCouts);
      const moisTokens = parMois.map((m) => m.mois);
      const moisCouts = coutsParMois.map((m) => m.mois);

      if (mois) {
        const tokensDuMois = parMois.find((m) => m.mois === mois);
        const coutsDuMois = coutsParMois.find((m) => m.mois === mois);
        if (!tokensDuMois && !coutsDuMois) {
          return erreur(
            `Aucune donnée pour le mois « ${mois} ».`,
            `Mois disponibles : tokens ${moisTokens.join(", ") || "aucun"} ; coûts ${moisCouts.join(", ") || "aucun"}.`
          );
        }
        return json({
          mois,
          libelle: libelleMois(mois),
          tokens: tokensDuMois
            ? {
                entree: tokensDuMois.entree,
                sortie: tokensDuMois.sortie,
                total: tokensDuMois.total,
                recherches_web: tokensDuMois.recherches_web,
                par_projet: tokensDuMois.par_projet,
                par_modele: tokensDuMois.par_modele,
              }
            : null,
          couts: coutsDuMois ?? null,
          factures: {
            ...blocFactures,
            note: "Liste complète, non filtrée sur ce mois : voir la remarque sur les factures dans la description de l'outil.",
          },
          factures_api: blocFacturesApi,
          duree_ms: Date.now() - debut,
        });
      }

      const totalEntree = parMois.reduce((s, m) => s + m.entree, 0);
      const totalSortie = parMois.reduce((s, m) => s + m.sortie, 0);
      const totalRecherches = parMois.reduce((s, m) => s + m.recherches_web, 0);

      return json({
        tokens:
          lignes.length > 0
            ? {
                periode: { debut: moisTokens[0], fin: moisTokens[moisTokens.length - 1] },
                entree: totalEntree,
                sortie: totalSortie,
                total: totalEntree + totalSortie,
                recherches_web: totalRecherches,
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
              }
            : null,
        couts:
          lignesCouts.length > 0
            ? {
                periode: { debut: moisCouts[0], fin: moisCouts[moisCouts.length - 1] },
                total_usd: centimes(lignesCouts.reduce((s, l) => s + l.cout_usd, 0)),
                par_mois: coutsParMois.map((m) => ({ libelle: libelleMois(m.mois), ...m })),
                par_projet: agregerCoutsPar(lignesCouts, "projet").map((p) => ({
                  projet: p.nom,
                  cout_usd: p.cout_usd,
                  part_pct: p.part_pct,
                })),
                par_modele: agregerCoutsPar(lignesCouts, "modele").map((m) => ({
                  modele: m.nom,
                  cout_usd: m.cout_usd,
                  part_pct: m.part_pct,
                })),
              }
            : null,
        factures: blocFactures,
        factures_api: blocFacturesApi,
        chemin_donnees: config.dossierUsage,
        duree_ms: Date.now() - debut,
      });
    })
  );
}
