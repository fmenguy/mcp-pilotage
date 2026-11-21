/**
 * Lecture et agrégation de l'usage de l'API Claude.
 *
 * Source des données : le dossier `usage/` (voir `PILOTAGE_DOSSIER_USAGE`),
 * volontairement exclu de git (`.gitignore`). Trois familles de fichiers y
 * vivent : les exports mensuels de tokens (`claude_api_tokens_YYYY_MM.csv`),
 * les exports mensuels de coûts (`claude_api_cost_YYYY_MM.csv`, en dollars,
 * ce que la console exporte depuis l'automne 2026) et les factures, tenues à
 * la main (`factures.csv` pour claude.ai en euros, `factures_api_claude.csv`
 * pour les recharges de la console en dollars).
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

export interface LigneCout {
  mois: string;
  date: string;
  modele: string; // nom du modèle, ou le type de coût entre parenthèses quand il n'y en a pas
  projet: string;
  type: string; // cost_type : token, web_search, code_execution, session_runtime
  cout_usd: number;
}

export interface LigneFactureApi {
  date: string;
  numero: string;
  description: string;
  total_usd: number;
  statut: string;
}

const MOTIF_FICHIER_TOKENS = /^claude_api_tokens_(\d{4})_(\d{2})\.csv$/i;
const MOTIF_FICHIER_COUTS = /^claude_api_cost_(\d{4})_(\d{2})\.csv$/i;

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

/** Liste les fichiers d'export mensuel qui suivent un motif, triés chronologiquement. */
async function listerFichiersMensuels(dossier: string, motif: RegExp): Promise<string[]> {
  const entrees = await listerDossier(dossier);
  return entrees
    .filter((e) => e.isFile() && motif.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** Projet d'une ligne d'export : l'espace de travail s'il est nommé, sinon la clé d'API. */
function projetDe(rangee: Record<string, string>): string {
  const espace = rangee.workspace ?? "";
  const cleApi = rangee.api_key ?? "";
  return espace && espace !== "Default" ? espace : cleApi || "inconnu";
}

/** Lit et aplatit tous les exports mensuels de coûts présents sur le disque. */
export async function lireLignesCouts(
  dossier = config.dossierUsage
): Promise<LigneCout[]> {
  const fichiers = await listerFichiersMensuels(dossier, MOTIF_FICHIER_COUTS);
  const lignes: LigneCout[] = [];

  for (const nomFichier of fichiers) {
    const correspondance = nomFichier.match(MOTIF_FICHIER_COUTS);
    if (!correspondance) continue;
    const mois = `${correspondance[1]}-${correspondance[2]}`;

    const contenu = await lireTexte(path.join(dossier, nomFichier));
    if (contenu === null) continue;

    for (const rangee of parserCsv(contenu.replace(/^\u{FEFF}/u, ""))) {
      const type = rangee.cost_type && rangee.cost_type !== "--" ? rangee.cost_type : "inconnu";
      const modele = rangee.model && rangee.model !== "--" ? rangee.model : `(${type})`;
      lignes.push({
        mois,
        date: rangee.usage_date_utc ?? "",
        modele,
        projet: projetDe(rangee),
        type,
        cout_usd: nombre(rangee.cost_usd),
      });
    }
  }

  return lignes;
}

/** Lit et aplatit tous les exports mensuels de tokens présents sur le disque. */
export async function lireLignesTokens(
  dossier = config.dossierUsage
): Promise<LigneUsageToken[]> {
  const fichiers = await listerFichiersMensuels(dossier, MOTIF_FICHIER_TOKENS);
  const lignes: LigneUsageToken[] = [];

  for (const nomFichier of fichiers) {
    const correspondance = nomFichier.match(MOTIF_FICHIER_TOKENS);
    if (!correspondance) continue;
    const mois = `${correspondance[1]}-${correspondance[2]}`;

    const contenu = await lireTexte(path.join(dossier, nomFichier));
    if (contenu === null) continue;

    for (const rangee of parserCsv(contenu)) {
      lignes.push({
        mois,
        date: rangee.usage_date_utc ?? "",
        modele: rangee.model_version ?? "inconnu",
        projet: projetDe(rangee),
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

export interface Abonnement {
  nom: string;
  prix_eur: number;
  jour: number | null; // jour du prélèvement dans le mois
  depuis: string | null;
  fin: string | null; // abonnement résilié : accès conservé jusqu'à cette date, plus de prélèvement
  credit_api_usd: number | null;
  credit_associe: boolean;
  usage: string | null;
}

/** Lit les abonnements IA, tenus à la main dans `abonnements.csv` (colonne `fin` facultative). */
export async function lireAbonnements(
  dossier = config.dossierUsage
): Promise<Abonnement[]> {
  const contenu = await lireTexte(path.join(dossier, "abonnements.csv"));
  if (contenu === null) return [];
  return parserCsv(contenu.replace(/^\u{FEFF}/u, ""))
    .filter((r) => r.nom)
    .map((r) => ({
      nom: r.nom,
      prix_eur: nombre(r.prix_eur),
      jour: nombre(r.jour) || null,
      depuis: r.depuis || null,
      fin: r.fin || null,
      credit_api_usd: nombre(r.credit_api_usd) || null,
      credit_associe: ["oui", "o", "true", "1"].includes((r.credit_associe ?? "").toLowerCase()),
      usage: r.usage || null,
    }));
}

/** Lit un fichier de factures en euros (date, echeance, total_eur, statut), tenu à la main dans le dossier usage. */
export async function lireFactures(
  dossier = config.dossierUsage,
  nomFichier = "factures.csv"
): Promise<LigneFacture[]> {
  const chemin = path.join(dossier, nomFichier);
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

/** Lit le relevé des factures de la console API (recharges en dollars), tenu à la main. */
export async function lireFacturesApi(
  dossier = config.dossierUsage
): Promise<LigneFactureApi[]> {
  const chemin = path.join(dossier, "factures_api_claude.csv");
  if (!(await existe(chemin))) return [];
  const contenu = await lireTexte(chemin);
  if (contenu === null) return [];

  return parserCsv(contenu).map((rangee) => ({
    date: rangee.date ?? "",
    numero: rangee.numero ?? "",
    description: rangee.description ?? "",
    total_usd: nombre(rangee.total_usd),
    statut: rangee.statut ?? "inconnu",
  }));
}

/** Arrondit un montant au centime. */
export function centimes(montant: number): number {
  return Math.round(montant * 100) / 100;
}

function versObjetArrondi(carte: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...carte.entries()]
      .filter(([, v]) => v >= 0.005)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, centimes(v)])
  );
}

/** Agrège les coûts par mois, avec répartition par projet, par modèle et par type de coût. */
export function agregerCoutsParMois(lignes: LigneCout[]): Array<{
  mois: string;
  cout_usd: number;
  jours_actifs: number;
  par_projet: Record<string, number>;
  par_modele: Record<string, number>;
  par_type: Record<string, number>;
}> {
  const parMois = new Map<
    string,
    {
      total: number;
      jours: Set<string>;
      parProjet: Map<string, number>;
      parModele: Map<string, number>;
      parType: Map<string, number>;
    }
  >();

  for (const ligne of lignes) {
    if (!parMois.has(ligne.mois)) {
      parMois.set(ligne.mois, {
        total: 0,
        jours: new Set(),
        parProjet: new Map(),
        parModele: new Map(),
        parType: new Map(),
      });
    }
    const m = parMois.get(ligne.mois)!;
    m.total += ligne.cout_usd;
    if (ligne.cout_usd > 0) m.jours.add(ligne.date);
    m.parProjet.set(ligne.projet, (m.parProjet.get(ligne.projet) ?? 0) + ligne.cout_usd);
    m.parModele.set(ligne.modele, (m.parModele.get(ligne.modele) ?? 0) + ligne.cout_usd);
    m.parType.set(ligne.type, (m.parType.get(ligne.type) ?? 0) + ligne.cout_usd);
  }

  return [...parMois.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mois, m]) => ({
      mois,
      cout_usd: centimes(m.total),
      jours_actifs: m.jours.size,
      par_projet: versObjetArrondi(m.parProjet),
      par_modele: versObjetArrondi(m.parModele),
      par_type: versObjetArrondi(m.parType),
    }));
}

/** Classe les projets ou les modèles par coût total, du plus cher au moins cher. */
export function agregerCoutsPar(
  lignes: LigneCout[],
  cle: "projet" | "modele"
): Array<{ nom: string; cout_usd: number; part_pct: number }> {
  const totaux = new Map<string, number>();
  let grandTotal = 0;
  for (const ligne of lignes) {
    totaux.set(ligne[cle], (totaux.get(ligne[cle]) ?? 0) + ligne.cout_usd);
    grandTotal += ligne.cout_usd;
  }
  return [...totaux.entries()]
    .filter(([, v]) => v >= 0.005)
    .map(([nom, v]) => ({
      nom,
      cout_usd: centimes(v),
      part_pct: grandTotal > 0 ? Math.round((v / grandTotal) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.cout_usd - a.cout_usd);
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
