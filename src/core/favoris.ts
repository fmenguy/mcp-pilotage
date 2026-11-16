/**
 * Lecture des favoris de l'extension VS Code Project Manager
 * (alefragnani.project-manager), fichier `projects.json`.
 *
 * Les favoris donnent ce que le scan du disque ne peut pas deviner : le
 * classement choisi par l'utilisateur (étiquettes « Android », « Blog »...) et
 * le nom sous lequel il désigne un projet. Le fichier est seulement lu, jamais
 * modifié. Sans ce fichier, tout fonctionne comme avant : les projets restent
 * regroupés par famille déduite de leur pile technique.
 */

import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { lireTexte } from "./fichiers.js";

/** Un favori tel que déclaré dans Project Manager. */
export interface Favori {
  /** Nom affiché dans la barre latérale de Project Manager. */
  nom: string;
  /** Chemin absolu du dossier, normalisé. */
  chemin: string;
  /** Étiquettes (« tags ») du favori, dans l'ordre du fichier. */
  etiquettes: string[];
}

export interface LectureFavoris {
  /** Fichier lu, ou null si la lecture des favoris est désactivée. */
  fichier: string | null;
  /** Vrai si le fichier a été lu et compris. */
  disponible: boolean;
  favoris: Favori[];
  /** Raison pour laquelle aucun favori n'a été lu, le cas échéant. */
  probleme: string | null;
}

/** Entrée brute du `projects.json` de Project Manager. */
interface EntreeBrute {
  name?: unknown;
  rootPath?: unknown;
  tags?: unknown;
  enabled?: unknown;
}

/** Clé de comparaison de chemins, insensible à la casse et aux séparateurs. */
export function cleChemin(chemin: string): string {
  return path.resolve(chemin).replace(/[\\/]+$/, "").toLowerCase();
}

/** Remplace `$home` et `~` en tête de chemin, comme le fait Project Manager. */
function developperChemin(brut: string): string {
  const s = brut.trim();
  if (s.startsWith("$home")) return path.join(os.homedir(), s.slice("$home".length));
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(1));
  return s;
}

/** Lit les favoris. Ne lève jamais d'exception : un échec est décrit dans `probleme`. */
export async function lireFavoris(fichier = config.fichierFavoris): Promise<LectureFavoris> {
  if (fichier === null) {
    return { fichier: null, disponible: false, favoris: [], probleme: "lecture des favoris désactivée (PILOTAGE_FAVORIS=aucun)" };
  }

  const brut = await lireTexte(fichier);
  if (brut === null) {
    return { fichier, disponible: false, favoris: [], probleme: "fichier de favoris introuvable ou illisible" };
  }

  let donnees: unknown;
  try {
    donnees = JSON.parse(brut.replace(/^\uFEFF/, ""));
  } catch {
    return { fichier, disponible: false, favoris: [], probleme: "fichier de favoris au JSON invalide" };
  }
  if (!Array.isArray(donnees)) {
    return { fichier, disponible: false, favoris: [], probleme: "fichier de favoris inattendu (une liste était attendue)" };
  }

  const favoris: Favori[] = [];
  for (const e of donnees as EntreeBrute[]) {
    if (!e || typeof e.rootPath !== "string" || e.rootPath.trim() === "") continue;
    if (e.enabled === false) continue;
    const chemin = path.resolve(developperChemin(e.rootPath));
    const etiquettes = Array.isArray(e.tags)
      ? e.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim())
      : [];
    favoris.push({
      nom: typeof e.name === "string" && e.name.trim() !== "" ? e.name.trim() : path.basename(chemin),
      chemin,
      etiquettes,
    });
  }

  return { fichier, disponible: true, favoris, probleme: null };
}
