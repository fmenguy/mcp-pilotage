/**
 * Recherche de texte à travers plusieurs dépôts.
 *
 * ripgrep est utilisé s'il est présent sur la machine, car il est nettement
 * plus rapide. Sinon un parcours Node prend le relais avec les mêmes règles
 * d'exclusion, plus lent mais toujours fonctionnel.
 */

import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { config, estFichierSecret, EXTENSIONS_TEXTE, GLOBS_SECRETS } from "../config.js";
import { correspondGlob, lireTexte, parcourir } from "./fichiers.js";

const execFileAsync = promisify(execFile);

export interface OptionsRecherche {
  motif: string;
  regex: boolean;
  sensibleCasse: boolean;
  /** Motif glob appliqué au chemin relatif, par exemple `**\/*.md`. */
  filtreFichiers: string | null;
  maxResultats: number;
  maxParFichier: number;
  /** Nombre de caractères conservés par ligne trouvée. */
  longueurLigne: number;
}

export interface Correspondance {
  projet: string;
  fichier: string;
  ligne: number;
  texte: string;
}

export interface ResultatRecherche {
  correspondances: Correspondance[];
  moteur: "ripgrep" | "node";
  tronque: boolean;
  /** Dépôts que le moteur n'a pas pu explorer. */
  problemes: string[];
}

// --- Détection de ripgrep -------------------------------------------------

let cheminRipgrep: string | null | undefined;

/**
 * Emplacements relatifs du ripgrep embarqué par VS Code, toutes variantes
 * d'empaquetage confondues. VS Code n'expose pas ce binaire dans le PATH,
 * mais il est presque toujours présent sur une machine de développeur.
 */
const SOUS_CHEMINS_VSCODE = [
  "resources/app/node_modules/@vscode/ripgrep/bin/rg.exe",
  "resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg.exe",
  "resources/app/node_modules/@vscode/ripgrep-universal/bin/win32-x64/rg.exe",
  "resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/win32-x64/rg.exe",
];

/** Dossiers d'installation habituels de VS Code. */
function racinesVsCode(): string[] {
  const racines = new Set<string>();
  const local = process.env.LOCALAPPDATA;
  if (local) racines.add(path.join(local, "Programs", "Microsoft VS Code"));
  racines.add("C:\\Program Files\\Microsoft VS Code");
  racines.add("D:\\Microsoft VS Code");

  // Une entrée du PATH du type `...\VS Code\bin` désigne l'installation.
  for (const entree of (process.env.PATH ?? "").split(path.delimiter)) {
    if (/vs ?code/i.test(entree)) {
      racines.add(entree.replace(/[\\/]bin[\\/]?$/i, ""));
    }
  }
  return [...racines];
}

/** Construit la liste ordonnée des chemins de ripgrep à essayer. */
async function candidatsRipgrep(): Promise<string[]> {
  const { listerDossier } = await import("./fichiers.js");
  const candidats: string[] = [];
  if (config.ripgrepForce) candidats.push(config.ripgrepForce);
  candidats.push("rg");

  for (const racine of racinesVsCode()) {
    for (const sous of SOUS_CHEMINS_VSCODE) {
      candidats.push(path.join(racine, ...sous.split("/")));
    }
    // Certaines installations rangent tout sous un dossier de version.
    // Un seul niveau suffit, la liste reste courte.
    for (const entree of await listerDossier(racine)) {
      if (!entree.isDirectory()) continue;
      for (const sous of SOUS_CHEMINS_VSCODE) {
        candidats.push(path.join(racine, entree.name, ...sous.split("/")));
      }
    }
  }
  return candidats;
}

/** Renvoie le chemin d'un ripgrep utilisable, ou null si aucun n'existe. */
export async function detecterRipgrep(): Promise<string | null> {
  if (cheminRipgrep !== undefined) return cheminRipgrep;

  const { existe } = await import("./fichiers.js");

  for (const candidat of await candidatsRipgrep()) {
    // Un chemin absolu inexistant est écarté sans lancer de processus.
    if (path.isAbsolute(candidat) && !(await existe(candidat))) continue;
    try {
      await execFileAsync(candidat, ["--version"], {
        timeout: 5000,
        windowsHide: true,
      });
      cheminRipgrep = candidat;
      return candidat;
    } catch {
      // candidat suivant
    }
  }

  cheminRipgrep = null;
  return null;
}

// --- Recherche ------------------------------------------------------------

interface CibleRecherche {
  projet: string;
  chemin: string;
}

/** Lance la recherche sur une liste de dépôts. */
export async function chercher(
  cibles: CibleRecherche[],
  options: OptionsRecherche
): Promise<ResultatRecherche> {
  const rg = await detecterRipgrep();
  if (rg) {
    try {
      return await chercherAvecRipgrep(rg, cibles, options);
    } catch (err) {
      // Repli silencieux : mieux vaut un résultat lent qu'aucun résultat.
      const repli = await chercherAvecNode(cibles, options);
      repli.problemes.push(
        `ripgrep a échoué (${err instanceof Error ? err.message : String(err)}), repli sur le parcours Node interne`
      );
      return repli;
    }
  }
  return chercherAvecNode(cibles, options);
}

interface LigneJsonRipgrep {
  type: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

async function chercherAvecRipgrep(
  rg: string,
  cibles: CibleRecherche[],
  options: OptionsRecherche
): Promise<ResultatRecherche> {
  const args: string[] = [
    "--json",
    "--hidden",
    "--max-filesize",
    String(config.tailleMaxFichier),
    "--max-count",
    String(options.maxParFichier),
  ];

  for (const exclu of config.dossiersExclus) {
    args.push("--glob", `!${exclu}/`);
  }
  for (const secret of GLOBS_SECRETS) {
    args.push("--glob", `!${secret}`);
  }
  if (options.filtreFichiers) {
    args.push("--glob", options.filtreFichiers);
  }
  if (!options.sensibleCasse) args.push("-i");
  if (!options.regex) args.push("--fixed-strings");

  args.push("-e", options.motif, "--");
  for (const c of cibles) args.push(c.chemin);

  const sortie = await lancerRipgrep(rg, args, options.maxResultats);

  const correspondances: Correspondance[] = [];
  for (const ligne of sortie.lignes) {
    if (ligne.trim() === "") continue;
    let objet: LigneJsonRipgrep;
    try {
      objet = JSON.parse(ligne) as LigneJsonRipgrep;
    } catch {
      continue;
    }
    if (objet.type !== "match" || !objet.data?.path?.text) continue;

    const absolu = objet.data.path.text;
    const cible = trouverCible(cibles, absolu);
    correspondances.push({
      projet: cible?.projet ?? "(hors inventaire)",
      // Le chemin est rendu relatif au projet pour rester lisible.
      fichier: relatif(cible?.chemin ?? "", absolu),
      ligne: objet.data.line_number ?? 0,
      texte: nettoyerLigne(objet.data.lines?.text ?? "", options.longueurLigne),
    });
    if (correspondances.length >= options.maxResultats) break;
  }

  return {
    correspondances,
    moteur: "ripgrep",
    tronque: sortie.tronque || correspondances.length >= options.maxResultats,
    problemes: [],
  };
}

/** Exécute ripgrep en flux et coupe dès que la limite de résultats est atteinte. */
function lancerRipgrep(
  rg: string,
  args: string[],
  maxResultats: number
): Promise<{ lignes: string[]; tronque: boolean }> {
  return new Promise((resoudre, rejeter) => {
    const processus = spawn(rg, args, { windowsHide: true });
    const lignes: string[] = [];
    let tampon = "";
    let nbMatchs = 0;
    let tronque = false;
    let termine = false;

    const finir = () => {
      if (termine) return;
      termine = true;
      resoudre({ lignes, tronque });
    };

    processus.stdout.setEncoding("utf8");
    processus.stdout.on("data", (bloc: string) => {
      tampon += bloc;
      let indice: number;
      while ((indice = tampon.indexOf("\n")) !== -1) {
        const ligne = tampon.slice(0, indice);
        tampon = tampon.slice(indice + 1);
        lignes.push(ligne);
        if (ligne.includes('"type":"match"')) {
          nbMatchs++;
          if (nbMatchs >= maxResultats) {
            tronque = true;
            processus.kill();
            finir();
            return;
          }
        }
      }
    });

    processus.on("error", (err) => {
      if (termine) return;
      termine = true;
      rejeter(err);
    });

    // ripgrep renvoie 1 quand il ne trouve rien, ce n'est pas une erreur.
    processus.on("close", () => {
      if (tampon.trim() !== "") lignes.push(tampon);
      finir();
    });

    const minuteur = setTimeout(() => {
      tronque = true;
      processus.kill();
      finir();
    }, 60_000);
    processus.on("close", () => clearTimeout(minuteur));
  });
}

async function chercherAvecNode(
  cibles: CibleRecherche[],
  options: OptionsRecherche
): Promise<ResultatRecherche> {
  const correspondances: Correspondance[] = [];
  const problemes: string[] = [];
  let tronque = false;

  const testeur = construireTesteur(options);

  for (const cible of cibles) {
    if (correspondances.length >= options.maxResultats) {
      tronque = true;
      break;
    }
    let fichiers;
    try {
      fichiers = await parcourir(cible.chemin, {
        profondeurMax: 10,
        limiteFichiers: 4000,
        filtre: (rel) => {
          if (estFichierSecret(rel.split("/").pop() ?? "")) return false;
          const ext = path.extname(rel).toLowerCase();
          if (ext !== "" && !EXTENSIONS_TEXTE.has(ext)) return false;
          if (ext === "" && !rel.split("/").pop()?.startsWith(".")) return false;
          if (options.filtreFichiers && !correspondGlob(rel, options.filtreFichiers)) {
            return false;
          }
          return true;
        },
      });
    } catch (err) {
      problemes.push(
        `${cible.projet} : parcours impossible (${err instanceof Error ? err.message : String(err)})`
      );
      continue;
    }

    for (const fichier of fichiers) {
      if (correspondances.length >= options.maxResultats) {
        tronque = true;
        break;
      }
      const contenu = await lireTexte(fichier.absolu);
      if (contenu === null) continue;
      let nbDansFichier = 0;
      const lignes = contenu.split(/\r?\n/);
      for (let i = 0; i < lignes.length; i++) {
        if (!testeur(lignes[i])) continue;
        correspondances.push({
          projet: cible.projet,
          fichier: fichier.relatif,
          ligne: i + 1,
          texte: nettoyerLigne(lignes[i], options.longueurLigne),
        });
        nbDansFichier++;
        if (nbDansFichier >= options.maxParFichier) break;
        if (correspondances.length >= options.maxResultats) {
          tronque = true;
          break;
        }
      }
    }
  }

  return { correspondances, moteur: "node", tronque, problemes };
}

/** Construit la fonction de test d'une ligne selon le mode choisi. */
function construireTesteur(options: OptionsRecherche): (ligne: string) => boolean {
  if (options.regex) {
    let re: RegExp;
    try {
      re = new RegExp(options.motif, options.sensibleCasse ? "" : "i");
    } catch {
      const litteral = options.sensibleCasse
        ? options.motif
        : options.motif.toLowerCase();
      return (ligne) =>
        (options.sensibleCasse ? ligne : ligne.toLowerCase()).includes(litteral);
    }
    return (ligne) => re.test(ligne);
  }
  const litteral = options.sensibleCasse ? options.motif : options.motif.toLowerCase();
  return (ligne) =>
    (options.sensibleCasse ? ligne : ligne.toLowerCase()).includes(litteral);
}

function trouverCible(
  cibles: CibleRecherche[],
  absolu: string
): CibleRecherche | null {
  const bas = absolu.toLowerCase();
  let meilleur: CibleRecherche | null = null;
  for (const c of cibles) {
    const prefixe = c.chemin.toLowerCase();
    if (bas.startsWith(prefixe)) {
      if (!meilleur || prefixe.length > meilleur.chemin.length) meilleur = c;
    }
  }
  return meilleur;
}

function relatif(racine: string, absolu: string): string {
  if (racine === "") return absolu;
  return path.relative(racine, absolu).replace(/\\/g, "/");
}

function nettoyerLigne(texte: string, longueurMax: number): string {
  const propre = texte.replace(/\r?\n$/, "").replace(/\t/g, "  ").trim();
  return propre.length > longueurMax
    ? propre.slice(0, longueurMax) + "..."
    : propre;
}
