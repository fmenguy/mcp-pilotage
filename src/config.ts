/**
 * Configuration du serveur MCP Pilotage.
 *
 * Tout est pilotable par variables d'environnement. Sans réglage, le serveur
 * scanne le dossier qui contient son propre dépôt (par exemple `D:\git` s'il
 * est installé dans `D:\git\mcp-pilotage`). Aucun fichier de configuration
 * à maintenir à la main : l'inventaire vient toujours d'un scan du disque.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** Racine de ce dépôt : `dist/` (ou `src/` avec tsx) est un niveau en dessous. */
const RACINE_DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Dossier `usage/` par défaut : à la racine de ce dépôt, ignoré par git. */
const DOSSIER_USAGE_DEFAUT = path.join(RACINE_DEPOT, "usage");

/** Racine scannée par défaut : le dossier qui contient ce dépôt, là où vivent en général les autres. */
const RACINES_DEFAUT = [path.dirname(RACINE_DEPOT)];

/**
 * Fichiers de secrets jamais fouillés par `chercher_partout`, même hors d'un
 * dépôt git ou sans ripgrep (qui, lui, respecte déjà les `.gitignore`).
 */
export const GLOBS_SECRETS = [".env", ".env.*", "*.env", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*"];

/** Vrai si le nom de fichier correspond à l'un des motifs de `GLOBS_SECRETS`. */
export function estFichierSecret(nom: string): boolean {
  const n = nom.toLowerCase();
  return (
    n === ".env" ||
    n.startsWith(".env.") ||
    n.endsWith(".env") ||
    [".pem", ".key", ".p12", ".pfx"].some((ext) => n.endsWith(ext)) ||
    n.startsWith("id_rsa") ||
    n.startsWith("id_ed25519")
  );
}

/** Dossiers dans lesquels on ne descend jamais, pour la vitesse. */
const EXCLUSIONS_DEFAUT = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".astro",
  "venv",
  ".venv",
  "env",
  "__pycache__",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",
  "obj",
  "bin",
  ".idea",
  ".vs",
  ".gradle",
  ".terraform",
  "vendor",
];

/** Extensions considérées comme du texte pour la recherche de repli. */
export const EXTENSIONS_TEXTE = new Set([
  ".md", ".mdx", ".txt", ".markdown", ".rst", ".adoc",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro", ".svelte", ".vue",
  ".py", ".pyi", ".rb", ".go", ".rs", ".java", ".kt", ".cs", ".c", ".h",
  ".cpp", ".hpp", ".php", ".lua", ".sql", ".sh", ".bash", ".ps1", ".psm1",
  ".bat", ".cmd", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini",
  ".cfg", ".conf", ".properties", ".xml", ".html", ".htm", ".css",
  ".scss", ".sass", ".less", ".csv", ".tsv", ".gitignore", ".editorconfig",
]);

export interface ConfigPilotage {
  /** Dossiers parents dans lesquels chercher les dépôts. */
  racines: string[];
  /** Profondeur maximale de descente pour trouver un dossier `.git`. */
  profondeur: number;
  /** Noms de dossiers ignorés lors de tout parcours. */
  dossiersExclus: Set<string>;
  /** Durée de vie du cache de scan disque, en millisecondes. */
  ttlCacheMs: number;
  /** Chemin forcé vers ripgrep, sinon détection automatique. */
  ripgrepForce: string | null;
  /** Délai maximal d'une commande git, en millisecondes. */
  timeoutGitMs: number;
  /** Taille maximale d'un fichier lu ou fouillé, en octets. */
  tailleMaxFichier: number;
  /** Dossier contenant les exports d'usage de l'API Claude et les factures. */
  dossierUsage: string;
}

function lireListe(valeur: string | undefined, defaut: string[]): string[] {
  if (!valeur || valeur.trim() === "") return defaut;
  return valeur
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function lireEntier(valeur: string | undefined, defaut: number): number {
  const n = Number.parseInt(valeur ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : defaut;
}

/** Construit la configuration à partir de l'environnement. */
export function chargerConfig(env: NodeJS.ProcessEnv = process.env): ConfigPilotage {
  const racines = lireListe(env.PILOTAGE_RACINES, RACINES_DEFAUT).map((r) =>
    path.resolve(r)
  );

  const exclusionsSupplementaires = lireListe(env.PILOTAGE_EXCLUSIONS, []);

  return {
    racines,
    profondeur: lireEntier(env.PILOTAGE_PROFONDEUR, 2),
    dossiersExclus: new Set(
      [...EXCLUSIONS_DEFAUT, ...exclusionsSupplementaires].map((d) =>
        d.toLowerCase()
      )
    ),
    ttlCacheMs: lireEntier(env.PILOTAGE_CACHE_MS, 60_000),
    ripgrepForce: env.PILOTAGE_RIPGREP && env.PILOTAGE_RIPGREP.trim() !== ""
      ? env.PILOTAGE_RIPGREP.trim()
      : null,
    timeoutGitMs: lireEntier(env.PILOTAGE_TIMEOUT_GIT_MS, 15_000),
    tailleMaxFichier: lireEntier(env.PILOTAGE_TAILLE_MAX_FICHIER, 1_048_576),
    dossierUsage:
      env.PILOTAGE_DOSSIER_USAGE && env.PILOTAGE_DOSSIER_USAGE.trim() !== ""
        ? path.resolve(env.PILOTAGE_DOSSIER_USAGE.trim())
        : DOSSIER_USAGE_DEFAUT,
  };
}

/** Configuration globale, lue une seule fois au démarrage. */
export const config: ConfigPilotage = chargerConfig();
