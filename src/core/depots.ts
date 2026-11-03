/**
 * Scan du disque et construction de l'inventaire des projets.
 *
 * Un dépôt est un dossier contenant `.git`. Les dossiers des racines qui n'en
 * sont pas sont tout de même signalés : chez François, certains projets réels
 * (monorepo non initialisé, dossier de stockage d'images) vivent hors git et
 * un agent a besoin de savoir qu'ils existent.
 */

import path from "node:path";
import { config } from "../config.js";
import { estDossier, estExclu, listerDossier } from "./fichiers.js";
import { deduireRole, recenserCerveau, type RoleDeduit } from "./cerveau.js";
import { detecterStack, lireConfigMcp, FAMILLES, type InfosStack } from "./stack.js";

export interface Depot {
  /** Nom du dossier. */
  nom: string;
  /** Chemin absolu. */
  chemin: string;
  /** Racine de scan dont il provient. */
  racine: string;
  /** Vrai si le dossier contient un `.git`. */
  versionne: boolean;
  stack: InfosStack;
  role: RoleDeduit;
  /** Documents de contexte disponibles, chemins relatifs. */
  documentsCerveau: string[];
  /** Documents de contexte prioritaires (CLAUDE.md, README, etc.). */
  documentsPrioritaires: string[];
  /** Serveurs MCP déclarés dans le `.mcp.json` du dépôt. */
  serveursMcp: string[];
  /** Problème rencontré pendant l'analyse, s'il y en a un. */
  probleme: string | null;
}

interface EntreeCache {
  horodatage: number;
  depots: Depot[];
}

let cache: EntreeCache | null = null;

/** Vide le cache de scan. */
export function viderCache(): void {
  cache = null;
}

/**
 * Renvoie l'inventaire complet des projets.
 * Le résultat est mis en cache pendant `PILOTAGE_CACHE_MS` (60 s par défaut)
 * pour éviter de relire le disque à chaque outil enchaîné par un agent.
 */
export async function inventorier(forcerRafraichissement = false): Promise<Depot[]> {
  if (
    !forcerRafraichissement &&
    cache !== null &&
    Date.now() - cache.horodatage < config.ttlCacheMs
  ) {
    return cache.depots;
  }

  const candidats = await collecterCandidats();
  const depots = await analyserEnParallele(candidats, 8);

  depots.sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
  cache = { horodatage: Date.now(), depots };
  return depots;
}

interface Candidat {
  chemin: string;
  racine: string;
  versionne: boolean;
}

/**
 * Parcourt les racines à la recherche de dossiers `.git`.
 * La descente s'arrête dès qu'un dépôt est trouvé : on n'entre jamais dans
 * les sous-modules ni dans l'arborescence interne d'un projet.
 */
async function collecterCandidats(): Promise<Candidat[]> {
  const candidats: Candidat[] = [];

  for (const racine of config.racines) {
    if (!(await estDossier(racine))) continue;

    async function descendre(dossier: string, niveau: number): Promise<void> {
      const entrees = await listerDossier(dossier);
      for (const e of entrees) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        if (estExclu(e.name)) continue;
        const abs = path.join(dossier, e.name);
        if (await estDossier(path.join(abs, ".git"))) {
          candidats.push({ chemin: abs, racine, versionne: true });
          continue;
        }
        if (niveau === 1) {
          // Dossier de premier niveau sans git : projet ou stockage à signaler.
          candidats.push({ chemin: abs, racine, versionne: false });
        }
        if (niveau < config.profondeur) {
          await descendre(abs, niveau + 1);
        }
      }
    }

    await descendre(racine, 1);
  }

  // Un dossier non versionné qui contient lui-même des dépôts ne doit pas
  // apparaître en double avec ses enfants versionnés : on ne le retire pas,
  // mais on évite les doublons de chemin exact.
  const vus = new Set<string>();
  return candidats.filter((c) => {
    const cle = c.chemin.toLowerCase();
    if (vus.has(cle)) return false;
    vus.add(cle);
    return true;
  });
}

/** Analyse les candidats avec une concurrence bornée. */
async function analyserEnParallele(
  candidats: Candidat[],
  concurrence: number
): Promise<Depot[]> {
  const resultats: Depot[] = [];
  let index = 0;

  async function travailleur(): Promise<void> {
    while (index < candidats.length) {
      const candidat = candidats[index++];
      resultats.push(await analyserDepot(candidat));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrence, candidats.length) }, travailleur)
  );
  return resultats;
}

/** Analyse un dossier candidat et le transforme en fiche projet. */
async function analyserDepot(candidat: Candidat): Promise<Depot> {
  const nom = path.basename(candidat.chemin);
  try {
    const [stack, documents, serveursMcp] = await Promise.all([
      detecterStack(candidat.chemin),
      recenserCerveau(candidat.chemin),
      lireConfigMcp(candidat.chemin),
    ]);
    const role = await deduireRole(candidat.chemin, stack.descriptionPaquet);

    return {
      nom,
      chemin: candidat.chemin,
      racine: candidat.racine,
      versionne: candidat.versionne,
      stack,
      role,
      documentsCerveau: documents.map((d) => d.chemin),
      documentsPrioritaires: documents.filter((d) => d.prioritaire).map((d) => d.chemin),
      serveursMcp,
      probleme: null,
    };
  } catch (err) {
    return {
      nom,
      chemin: candidat.chemin,
      racine: candidat.racine,
      versionne: candidat.versionne,
      stack: {
        principale: "indéterminée",
        technologies: [],
        famille: FAMILLES.autre,
        nomPaquet: null,
        descriptionPaquet: null,
        manifestes: [],
      },
      role: { resume: null, source: null },
      documentsCerveau: [],
      documentsPrioritaires: [],
      serveursMcp: [],
      probleme: `analyse impossible : ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Retrouve un projet à partir d'un nom ou d'un chemin.
 * La correspondance est insensible à la casse et tolérante : nom exact,
 * puis chemin exact, puis nom contenant le terme.
 */
export async function resoudreDepot(
  reference: string,
  depots?: Depot[]
): Promise<Depot | null> {
  const liste = depots ?? (await inventorier());
  const ref = reference.trim().toLowerCase().replace(/[\\/]+$/, "");

  const parNom = liste.find((d) => d.nom.toLowerCase() === ref);
  if (parNom) return parNom;

  const parChemin = liste.find(
    (d) => d.chemin.toLowerCase().replace(/[\\/]+$/, "") === ref.replace(/\//g, "\\")
  );
  if (parChemin) return parChemin;

  const parPaquet = liste.find((d) => d.stack.nomPaquet?.toLowerCase() === ref);
  if (parPaquet) return parPaquet;

  const partiels = liste.filter((d) => d.nom.toLowerCase().includes(ref));
  if (partiels.length === 1) return partiels[0];

  return null;
}

/** Liste des noms de projets, pour les messages d'erreur exploitables. */
export function nomsDisponibles(depots: Depot[]): string[] {
  return depots.map((d) => d.nom);
}
