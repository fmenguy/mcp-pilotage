/**
 * Lecture de l'état git d'un dépôt.
 *
 * Toutes les commandes sont strictement en lecture. Aucune commande
 * d'écriture (add, commit, push, checkout, fetch) n'est utilisée ni
 * autorisée ici, c'est une garantie structurelle du serveur.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

/** Séparateur d'unités (0x1F) utilisé dans les formats git, absent de tout texte. */
const SEP = "\x1f";

/** Lance une commande git en lecture seule dans un dépôt. */
async function git(depot: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", depot, ...args], {
      timeout: config.timeoutGitMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
    });
    return stdout.replace(/\r\n/g, "\n").trimEnd();
  } catch {
    return null;
  }
}

export interface Commit {
  hash: string;
  auteur: string;
  date: string;
  sujet: string;
}

/**
 * Niveau d'activité d'un dépôt. Ces valeurs sont des libellés courts,
 * volontairement sans accent, car elles servent aussi de valeurs de filtre.
 */
export type NiveauActivite = "actif" | "ralenti" | "dormant" | "inconnu";

export interface EtatGit {
  /** Vrai si git a répondu, faux si le dépôt est illisible ou git absent. */
  disponible: boolean;
  branche: string | null;
  remoteOrigin: string | null;
  dernierCommit: Commit | null;
  /** Nombre de jours depuis le dernier commit. */
  joursDepuisDernierCommit: number | null;
  activite: NiveauActivite;
  /** Nombre de fichiers modifiés, ajoutés ou non suivis. */
  fichiersModifies: number;
  /** Échantillon des fichiers modifiés, tronqué. */
  apercuModifications: string[];
  /** Commits d'avance et de retard sur la branche distante suivie. */
  avance: number | null;
  retard: number | null;
  /** Message explicatif si quelque chose s'est mal passé. */
  probleme: string | null;
}

/** Traduit un nombre de jours en niveau d'activité lisible. */
export function niveauActivite(jours: number | null): NiveauActivite {
  if (jours === null) return "inconnu";
  if (jours <= 30) return "actif";
  if (jours <= 120) return "ralenti";
  return "dormant";
}

function parserCommit(ligne: string): Commit | null {
  const parts = ligne.split(SEP);
  if (parts.length < 4) return null;
  return {
    hash: parts[0].slice(0, 8),
    auteur: parts[1],
    date: parts[2],
    sujet: parts[3],
  };
}

/**
 * État git complet et instantané d'un dépôt.
 * Toutes les sous-commandes sont lancées en parallèle pour limiter la latence.
 */
export async function lireEtatGit(
  depot: string,
  options: { apercuModifications?: number } = {}
): Promise<EtatGit> {
  const limiteApercu = options.apercuModifications ?? 10;

  const [branche, commitBrut, statut, remote, suivi] = await Promise.all([
    git(depot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(depot, ["log", "-1", `--format=%H${SEP}%an${SEP}%aI${SEP}%s`]),
    git(depot, ["status", "--porcelain"]),
    git(depot, ["config", "--get", "remote.origin.url"]),
    git(depot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
  ]);

  const disponible = branche !== null || commitBrut !== null || statut !== null;

  const dernierCommit = commitBrut ? parserCommit(commitBrut) : null;
  let jours: number | null = null;
  if (dernierCommit) {
    const t = Date.parse(dernierCommit.date);
    if (Number.isFinite(t)) {
      jours = Math.floor((Date.now() - t) / 86_400_000);
    }
  }

  const lignesStatut = statut && statut !== "" ? statut.split("\n") : [];

  let avance: number | null = null;
  let retard: number | null = null;
  if (suivi) {
    const [r, a] = suivi.split(/\s+/);
    const nr = Number.parseInt(r ?? "", 10);
    const na = Number.parseInt(a ?? "", 10);
    if (Number.isFinite(nr)) retard = nr;
    if (Number.isFinite(na)) avance = na;
  }

  let probleme: string | null = null;
  if (!disponible) {
    probleme =
      "git n'a pas répondu pour ce dépôt (binaire absent, dépôt corrompu ou accès refusé)";
  } else if (dernierCommit === null) {
    probleme = "dépôt sans aucun commit";
  }

  return {
    disponible,
    branche: branche === "HEAD" ? "(détachée)" : branche,
    remoteOrigin: remote,
    dernierCommit,
    joursDepuisDernierCommit: jours,
    activite: niveauActivite(jours),
    fichiersModifies: lignesStatut.length,
    apercuModifications: lignesStatut.slice(0, limiteApercu).map((l) => l.trim()),
    avance,
    retard,
    probleme,
  };
}

/** Les N derniers commits d'un dépôt. */
export async function lireHistorique(
  depot: string,
  nb: number
): Promise<Commit[]> {
  const brut = await git(depot, [
    "log",
    `-${Math.max(1, Math.min(nb, 100))}`,
    `--format=%H${SEP}%an${SEP}%aI${SEP}%s`,
  ]);
  if (!brut) return [];
  return brut
    .split("\n")
    .map(parserCommit)
    .filter((c): c is Commit => c !== null);
}

/** Liste des branches locales du dépôt. */
export async function lireBranches(depot: string): Promise<string[]> {
  const brut = await git(depot, ["branch", "--format=%(refname:short)"]);
  if (!brut) return [];
  return brut.split("\n").map((b) => b.trim()).filter((b) => b !== "");
}
