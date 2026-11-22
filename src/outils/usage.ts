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
  lireAbonnements,
  lireFactures,
  lireFacturesApi,
  lireLignesCouts,
  lireLignesTokens,
} from "../core/usage.js";
import { lireTokensAgents } from "../core/tokens.js";
import { erreur, json, lectureSeule, protege, sansAccents } from "../utils/reponse.js";

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
      "Renvoie aussi les abonnements IA (abonnements.csv : prix, jour de prélèvement, crédit API inclus, date de fin si résilié) et les factures OpenAI (factures_openai.csv), pour savoir quels forfaits courent encore.",
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
    lectureSeule("Usage et factures de l'IA"),
    protege("usage_ia_claude", async ({ mois }) => {
      const debut = Date.now();
      const lignes = await lireLignesTokens();
      const lignesCouts = await lireLignesCouts();
      const factures = await lireFactures();
      const facturesApi = await lireFacturesApi();
      const abonnements = await lireAbonnements();
      const facturesOpenai = await lireFactures(undefined, "factures_openai.csv");
      const aujourdhui = new Date().toISOString().slice(0, 10);
      const enCours = abonnements.filter((a) => !a.fin || a.fin > aujourdhui);
      const blocAbonnements = {
        total_mensuel_eur: centimes(enCours.filter((a) => !a.fin).reduce((s, a) => s + a.prix_eur, 0)),
        note: "Un abonnement avec une date de fin est résilié : plus de prélèvement, accès conservé jusqu'à cette date. Il sort du total mensuel.",
        lignes: enCours,
        termines: abonnements.filter((a) => a.fin && a.fin <= aujourdhui),
      };
      const blocFacturesOpenai = {
        net_eur: centimes(facturesOpenai.reduce((s, f) => s + f.total_eur, 0)),
        nombre: facturesOpenai.length,
        lignes: facturesOpenai,
      };

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
          abonnements: blocAbonnements,
          factures_openai: blocFacturesOpenai,
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
        abonnements: blocAbonnements,
        factures_openai: blocFacturesOpenai,
        chemin_donnees: config.dossierUsage,
        duree_ms: Date.now() - debut,
      });
    })
  );

  server.tool(
    "tokens_agents",
    [
      "Tokens réellement consommés par les trois agents de code de l'utilisateur (Claude Code, Codex, Mistral Vibe), lus dans leurs journaux de session locaux, sur une fenêtre glissante de N jours.",
      "Complète usage_ia_claude, qui ne couvre que l'API Claude exportée de la console : ici on voit l'usage des abonnements, agent par agent, projet par projet, modèle par modèle et jour par jour.",
      "Convention commune aux trois agents : entree (entrée plein tarif, écriture du cache comprise), entree_cache (entrée relue depuis le cache, bien moins chère), sortie (raisonnement compris). Le total additionne les trois, comme le rapport de session de Claude Code.",
      "Le projet est le dépôt qui contient le dossier de travail de la session ; un worktree est rattaché à son dépôt principal tant qu'il existe encore, sinon il garde le nom de son dossier.",
      "Premier appel lent (plusieurs Go de journaux), les suivants sont rapides grâce au cache par fichier. Strictement en lecture.",
    ].join(" "),
    {
      jours: z.number().int().min(1).max(365).default(30).describe("Fenêtre en jours, aujourd'hui compris. 30 par défaut."),
      agent: z.enum(["Claude Code", "Codex", "Mistral Vibe"]).optional().describe("Limiter à un seul agent."),
      projet: z.string().optional().describe("Limiter à un projet (nom de dépôt, sans tenir compte de la casse ni des accents)."),
    },
    lectureSeule("Tokens des agents de code"),
    protege("tokens_agents", async ({ jours, agent, projet }) => {
      const debut = Date.now();
      const depuis = new Date();
      depuis.setHours(0, 0, 0, 0);
      depuis.setDate(depuis.getDate() - (jours - 1));
      const { lignes: toutes, sources } = await lireTokensAgents(depuis.getTime());
      const filtreProjet = projet ? sansAccents(projet) : null;
      const lignes = toutes.filter(
        (l) => (!agent || l.agent === agent) && (!filtreProjet || sansAccents(l.projet) === filtreProjet)
      );
      if (lignes.length === 0) {
        return erreur(
          "Aucun usage trouvé sur cette période avec ces filtres.",
          `Journaux lus : ${Object.values(sources).flat().join(" ; ")}.`
        );
      }

      const totalDe = (l: { entree: number; entree_cache: number; sortie: number }) => l.entree + l.entree_cache + l.sortie;
      const grandTotal = lignes.reduce((s, l) => s + totalDe(l), 0);
      const part = (v: number) => (grandTotal > 0 ? Math.round((v / grandTotal) * 1000) / 10 : 0);
      const somme = (ls: typeof lignes) => {
        const entree = ls.reduce((s, l) => s + l.entree, 0);
        const entree_cache = ls.reduce((s, l) => s + l.entree_cache, 0);
        const sortie = ls.reduce((s, l) => s + l.sortie, 0);
        const total = entree + entree_cache + sortie;
        return {
          total,
          part_pct: part(total),
          entree,
          entree_cache,
          sortie,
          cache_pct: entree + entree_cache > 0 ? Math.round((entree_cache / (entree + entree_cache)) * 1000) / 10 : 0,
          appels: ls.reduce((s, l) => s + l.appels, 0),
          sessions: new Set(ls.map((l) => l.session)).size,
          jours_actifs: new Set(ls.map((l) => l.jour)).size,
        };
      };
      const grouper = <K extends string>(cle: (l: (typeof lignes)[number]) => K) => {
        const m = new Map<K, typeof lignes>();
        for (const l of lignes) {
          const k = cle(l);
          if (!m.has(k)) m.set(k, []);
          m.get(k)!.push(l);
        }
        return m;
      };
      const agents = ["Claude Code", "Codex", "Mistral Vibe"] as const;

      const parAgent = [...grouper((l) => l.agent).entries()]
        .map(([nom, ls]) => ({ agent: nom, ...somme(ls) }))
        .sort((a, b) => b.total - a.total);
      const parProjet = [...grouper((l) => l.projet).entries()]
        .map(([nom, ls]) => {
          const s = somme(ls);
          const detail: Record<string, number> = {};
          for (const a of agents) {
            const t = ls.filter((l) => l.agent === a).reduce((x, l) => x + totalDe(l), 0);
            if (t > 0) detail[a] = t;
          }
          return { projet: nom, total: s.total, part_pct: s.part_pct, sessions: s.sessions, par_agent: detail };
        })
        .sort((a, b) => b.total - a.total);
      const parModele = [...grouper((l) => `${l.agent}|${l.modele}`).entries()]
        .map(([cle, ls]) => {
          const [nomAgent, modele] = cle.split("|");
          const s = somme(ls);
          return { agent: nomAgent, modele, total: s.total, part_pct: s.part_pct, appels: s.appels };
        })
        .sort((a, b) => b.total - a.total);
      const parJour = [...grouper((l) => l.jour).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([jour, ls]) => {
          const ligne: Record<string, string | number> = { jour, total: 0 };
          for (const a of agents) {
            const t = ls.filter((l) => l.agent === a).reduce((x, l) => x + totalDe(l), 0);
            if (t > 0) ligne[a] = t;
            ligne.total = (ligne.total as number) + t;
          }
          return ligne;
        });

      return json({
        periode: { du: parJour[0]?.jour, au: parJour[parJour.length - 1]?.jour, fenetre_jours: jours },
        filtres: { agent: agent ?? null, projet: projet ?? null },
        convention:
          "total = entree + entree_cache + sortie. entree : plein tarif, écriture du cache comprise. entree_cache : relue depuis le cache. sortie : raisonnement compris. Codex et Vibe comptent le cache dans leur entrée brute, il en est retiré ici pour aligner les trois agents.",
        total: somme(lignes),
        par_agent: parAgent,
        par_projet: parProjet.slice(0, 30),
        par_modele: parModele,
        par_jour: parJour,
        sources,
        duree_ms: Date.now() - debut,
      });
    })
  );
}
