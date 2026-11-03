/**
 * Lecture et agrégation de l'usage de l'API Claude.
 *
 * Source des données : le dossier `usage/` (voir `PILOTAGE_DOSSIER_USAGE`),
 * volontairement exclu de git (`.gitignore`). Deux familles de fichiers y
 * vivent : les exports mensuels de tokens (`claude_api_tokens_YYYY_MM.csv`,
 * un par mois) et les factures (`factures.csv`, tenu à la main).
 *
 * Comme le reste du serveur : aucune exception ne remonte, un fichier absent
 * ou mal formé produit une liste vide plutôt qu'un plantage.
 */

import path from "node:path";
import { config } from "../config.js";
import { existe, lireTexte, listerDossier } from "./fichiers.js";

export interface LigneUsageToken {
  mois: string; // "2026-07"
  date: string; // usage_date_utc, "2026-07-03"
  modele: string;
  projet: string; // workspace si renseigné, sinon api_key
  entree: number; // tokens d'entrée, cache compris (nouveau + écriture cache + lecture cache)
  sortie: number;
  recherches_web: number;
}

export interface LigneFacture {
  date: string;
  echeance: string | null;
  total_eur: number;
  statut: string;
}

const MOTIF_FICHIER_TOKENS = /^claude_api_tokens_(\d{4})_(\d{2})\.csv$/i;

/** Découpe une ligne CSV simple, en tolérant des champs entre guillemets. */
function decouperLigneCsv(ligne: string): string[] {
  const champs: string[] = [];
  let courant = "";
  let dansGuillemets = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (c === '"') {
      dansGuillemets = !dansGuillemets;
    } else if (c === "," && !dansGuillemets) {
      champs.push(courant);
      courant = "";
    } else {
      courant += c;
    }
  }
  champs.push(courant);
  return champs;
}

function parserCsv(contenu: string): Record<string, string>[] {
  const lignes = contenu.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lignes.length === 0) return [];
  const entetes = decouperLigneCsv(lignes[0]).map((e) => e.trim());
  const resultats: Record<string, string>[] = [];
  for (const ligne of lignes.slice(1)) {
    const champs = decouperLigneCsv(ligne);
    const rangee: Record<string, string> = {};
    entetes.forEach((entete, i) => {
      rangee[entete] = (champs[i] ?? "").trim();
    });
    resultats.push(rangee);
  }
  return resultats;
}

function nombre(valeur: string | undefined): number {
  const n = Number.parseFloat(valeur ?? "");
  return Number.isFinite(n) ? n : 0;
}

/** Liste les fichiers d'export mensuel présents, triés chronologiquement. */
async function listerFichiersTokens(dossier: string): Promise<string[]> {
  const entrees = await listerDossier(dossier);
  return entrees
    .filter((e) => e.isFile() && MOTIF_FICHIER_TOKENS.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** Lit et aplatit tous les exports mensuels de tokens présents sur le disque. */
export async function lireLignesTokens(
  dossier = config.dossierUsage
): Promise<LigneUsageToken[]> {
  const fichiers = await listerFichiersTokens(dossier);
  const lignes: LigneUsageToken[] = [];

  for (const nomFichier of fichiers) {
    const correspondance = nomFichier.match(MOTIF_FICHIER_TOKENS);
    if (!correspondance) continue;
    const mois = `${correspondance[1]}-${correspondance[2]}`;

    const contenu = await lireTexte(path.join(dossier, nomFichier));
    if (contenu === null) continue;

    for (const rangee of parserCsv(contenu)) {
      const espace = rangee.workspace ?? "";
      const cleApi = rangee.api_key ?? "";
      lignes.push({
        mois,
        date: rangee.usage_date_utc ?? "",
        modele: rangee.model_version ?? "inconnu",
        projet: espace && espace !== "Default" ? espace : cleApi || "inconnu",
        entree:
          nombre(rangee.usage_input_tokens_no_cache) +
          nombre(rangee.usage_input_tokens_cache_write_5m) +
          nombre(rangee.usage_input_tokens_cache_write_1h) +
          nombre(rangee.usage_input_tokens_cache_read),
        sortie: nombre(rangee.usage_output_tokens),
        recherches_web: nombre(rangee.web_search_count),
      });
    }
  }

  return lignes;
}

/** Lit le fichier de factures, tenu à la main dans le dossier usage. */
export async function lireFactures(
  dossier = config.dossierUsage
): Promise<LigneFacture[]> {
  const chemin = path.join(dossier, "factures.csv");
  if (!(await existe(chemin))) return [];
  const contenu = await lireTexte(chemin);
  if (contenu === null) return [];

  return parserCsv(contenu).map((rangee) => ({
    date: rangee.date ?? "",
    echeance: rangee.echeance && rangee.echeance !== "" ? rangee.echeance : null,
    total_eur: nombre(rangee.total_eur),
    statut: rangee.statut ?? "inconnu",
  }));
}

export interface StatistiquesGroupe {
  entree: number;
  sortie: number;
  total: number;
  recherches_web: number;
}

function groupeVide(): StatistiquesGroupe {
  return { entree: 0, sortie: 0, total: 0, recherches_web: 0 };
}

function ajouter(groupe: StatistiquesGroupe, ligne: LigneUsageToken): void {
  groupe.entree += ligne.entree;
  groupe.sortie += ligne.sortie;
  groupe.total += ligne.entree + ligne.sortie;
  groupe.recherches_web += ligne.recherches_web;
}

/** Agrège une liste de lignes de tokens par mois, avec sous-répartition par projet et par modèle. */
export function agregerParMois(
  lignes: LigneUsageToken[]
): Array<
  StatistiquesGroupe & {
    mois: string;
    par_projet: Record<string, number>;
    par_modele: Record<string, number>;
  }
> {
  const parMois = new Map<
    string,
    { stats: StatistiquesGroupe; parProjet: Map<string, number>; parModele: Map<string, number> }
  >();

  for (const ligne of lignes) {
    if (!parMois.has(ligne.mois)) {
      parMois.set(ligne.mois, { stats: groupeVide(), parProjet: new Map(), parModele: new Map() });
    }
    const entree = parMois.get(ligne.mois)!;
    ajouter(entree.stats, ligne);
    const total = ligne.entree + ligne.sortie;
    entree.parProjet.set(ligne.projet, (entree.parProjet.get(ligne.projet) ?? 0) + total);
    entree.parModele.set(ligne.modele, (entree.parModele.get(ligne.modele) ?? 0) + total);
  }

  return [...parMois.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mois, v]) => ({
      mois,
      ...v.stats,
      par_projet: Object.fromEntries(v.parProjet),
      par_modele: Object.fromEntries(v.parModele),
    }));
}

/** Agrège une liste de lignes par une clé (projet ou modèle), triée du plus gros au plus petit. */
export function agregerPar(
  lignes: LigneUsageToken[],
  cle: "projet" | "modele"
): Array<{ nom: string; total: number; part_pct: number }> {
  const totaux = new Map<string, number>();
  let grandTotal = 0;

  for (const ligne of lignes) {
    const nom = ligne[cle];
    const total = ligne.entree + ligne.sortie;
    totaux.set(nom, (totaux.get(nom) ?? 0) + total);
    grandTotal += total;
  }

  return [...totaux.entries()]
    .map(([nom, total]) => ({
      nom,
      total,
      part_pct: grandTotal > 0 ? Math.round((total / grandTotal) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.total - a.total);
}
