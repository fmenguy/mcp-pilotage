/**
 * Utilitaires de système de fichiers, tolérants aux erreurs.
 *
 * Règle de base du serveur : rien ne doit jamais lever une exception qui
 * remonte jusqu'au transport MCP. Un dossier illisible, un fichier verrouillé
 * ou un lien cassé renvoie une valeur vide, pas un plantage.
 */

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/** Liste un dossier sans jamais lever d'exception. */
export async function listerDossier(chemin: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(chemin, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Teste l'existence d'un chemin. */
export async function existe(chemin: string): Promise<boolean> {
  try {
    await fs.access(chemin);
    return true;
  } catch {
    return false;
  }
}

/** Teste l'existence d'un dossier. */
export async function estDossier(chemin: string): Promise<boolean> {
  try {
    const s = await fs.stat(chemin);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** Lit un fichier texte, renvoie null en cas d'échec ou de taille excessive. */
export async function lireTexte(
  chemin: string,
  tailleMax = config.tailleMaxFichier
): Promise<string | null> {
  try {
    const s = await fs.stat(chemin);
    if (!s.isFile() || s.size > tailleMax) return null;
    return await fs.readFile(chemin, "utf8");
  } catch {
    return null;
  }
}

/** Lit un fichier JSON, renvoie null si absent ou invalide. */
export async function lireJson<T>(chemin: string): Promise<T | null> {
  const brut = await lireTexte(chemin);
  if (brut === null) return null;
  try {
    return JSON.parse(brut) as T;
  } catch {
    return null;
  }
}

/** Date de dernière modification d'un fichier, ou null. */
export async function dateModification(chemin: string): Promise<Date | null> {
  try {
    const s = await fs.stat(chemin);
    return s.mtime;
  } catch {
    return null;
  }
}

/** Vrai si le nom de dossier fait partie des exclusions de parcours. */
export function estExclu(nom: string): boolean {
  return config.dossiersExclus.has(nom.toLowerCase()) || nom.startsWith("$");
}

/**
 * Cherche un fichier à la racine d'un dossier sans tenir compte de la casse.
 * Indispensable ici : certains dépôts ont `Readme.md`, d'autres `README.md`.
 */
export async function trouverFichierRacine(
  dossier: string,
  nomRecherche: string
): Promise<string | null> {
  const entrees = await listerDossier(dossier);
  const cible = nomRecherche.toLowerCase();
  for (const e of entrees) {
    if (e.isFile() && e.name.toLowerCase() === cible) {
      return path.join(dossier, e.name);
    }
  }
  return null;
}

/**
 * Résout un chemin relatif segment par segment sans tenir compte de la casse.
 * Permet de trouver `.claude/CLAUDE.md` quelle que soit l'orthographe réelle.
 * Renvoie le chemin absolu réel, ou null si un segment manque.
 */
export async function resoudreCheminInsensible(
  racine: string,
  relatif: string
): Promise<string | null> {
  const segments = relatif.split(/[\\/]+/).filter((s) => s !== "");
  let courant = racine;
  for (let i = 0; i < segments.length; i++) {
    const entrees = await listerDossier(courant);
    const cible = segments[i].toLowerCase();
    const trouve = entrees.find((e) => e.name.toLowerCase() === cible);
    if (!trouve) return null;
    const dernier = i === segments.length - 1;
    if (dernier && !trouve.isFile()) return null;
    if (!dernier && !trouve.isDirectory()) return null;
    courant = path.join(courant, trouve.name);
  }
  return courant;
}

export interface OptionsParcours {
  /** Profondeur maximale, la racine valant 0. */
  profondeurMax?: number;
  /** Nombre maximal de fichiers renvoyés. */
  limiteFichiers?: number;
  /** Filtre appliqué à chaque fichier (chemin relatif, séparateurs `/`). */
  filtre?: (relatif: string) => boolean;
}

export interface FichierTrouve {
  /** Chemin absolu. */
  absolu: string;
  /** Chemin relatif à la racine du parcours, séparateurs `/`. */
  relatif: string;
  /** Taille en octets. */
  taille: number;
}

/**
 * Parcourt récursivement un dossier en ignorant les exclusions.
 * Le parcours s'arrête dès que la limite de fichiers est atteinte.
 */
export async function parcourir(
  racine: string,
  options: OptionsParcours = {}
): Promise<FichierTrouve[]> {
  const profondeurMax = options.profondeurMax ?? 12;
  const limite = options.limiteFichiers ?? 5000;
  const resultats: FichierTrouve[] = [];

  async function descendre(dossier: string, relatif: string, niveau: number): Promise<void> {
    if (resultats.length >= limite || niveau > profondeurMax) return;
    const entrees = await listerDossier(dossier);
    for (const e of entrees) {
      if (resultats.length >= limite) return;
      const rel = relatif === "" ? e.name : `${relatif}/${e.name}`;
      const abs = path.join(dossier, e.name);
      if (e.isDirectory()) {
        if (estExclu(e.name)) continue;
        await descendre(abs, rel, niveau + 1);
      } else if (e.isFile()) {
        if (options.filtre && !options.filtre(rel)) continue;
        let taille = 0;
        try {
          taille = (await fs.stat(abs)).size;
        } catch {
          continue;
        }
        resultats.push({ absolu: abs, relatif: rel, taille });
      }
    }
  }

  await descendre(racine, "", 0);
  return resultats;
}

/**
 * Compare un chemin relatif à un motif glob simple.
 * Gère `*` (un segment), `**` (plusieurs segments) et `?` (un caractère).
 * Comparaison insensible à la casse, comme le système de fichiers Windows.
 */
export function correspondGlob(relatif: string, motif: string): boolean {
  const regex = globVersRegex(motif);
  return regex.test(relatif);
}

const cacheGlob = new Map<string, RegExp>();

function globVersRegex(motif: string): RegExp {
  const enCache = cacheGlob.get(motif);
  if (enCache) return enCache;

  let source = "";
  let i = 0;
  while (i < motif.length) {
    const c = motif[i];
    if (c === "*") {
      if (motif[i + 1] === "*") {
        // `**/` avale zéro ou plusieurs segments, `**` seul avale tout.
        if (motif[i + 2] === "/") {
          source += "(?:[^/]*\\/)*";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
      } else {
        source += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      source += "[^/]";
      i += 1;
    } else if ("\\^$.|+()[]{}".includes(c)) {
      source += `\\${c}`;
      i += 1;
    } else {
      source += c;
      i += 1;
    }
  }

  const regex = new RegExp(`^${source}$`, "i");
  cacheGlob.set(motif, regex);
  return regex;
}

/**
 * Vérifie qu'un chemin relatif reste bien à l'intérieur d'un dépôt.
 * Garde-fou contre les remontées `..` dans les paramètres des outils.
 */
export function cheminSurDansDepot(
  racineDepot: string,
  relatif: string
): string | null {
  if (path.isAbsolute(relatif)) return null;
  const absolu = path.resolve(racineDepot, relatif);
  const racineNormalisee = path.resolve(racineDepot).toLowerCase();
  if (
    absolu.toLowerCase() !== racineNormalisee &&
    !absolu.toLowerCase().startsWith(racineNormalisee + path.sep)
  ) {
    return null;
  }
  return absolu;
}
