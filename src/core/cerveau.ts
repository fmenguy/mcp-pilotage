/**
 * Lecture du « cerveau » d'un projet.
 *
 * Le cerveau, ce sont les fichiers où François a écrit ce que le projet est
 * et comment il faut y travailler : CLAUDE.md en premier, puis README, puis
 * les documents d'architecture et les notes de contexte.
 */

import path from "node:path";
import {
  listerDossier,
  lireTexte,
  parcourir,
  resoudreCheminInsensible,
} from "./fichiers.js";

/**
 * Documents principaux, lus par défaut, dans l'ordre de priorité.
 * `.claude/CLAUDE.md` compte autant que la version à la racine : chez François
 * la majorité des projets rangent leurs instructions dans le dossier `.claude`.
 */
export const DOCUMENTS_PRIORITAIRES = [
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "AGENTS.md",
  ".claude/AGENTS.md",
  "README.md",
  "ARCHITECTURE.md",
  "CONTEXTE.md",
  "ETAT-DES-LIEUX.md",
];

/** Dossiers où vivent les documents de contexte secondaires. */
const DOSSIERS_CONTEXTE = [
  "docs",
  "doc",
  "notes",
  "références",
  "references",
  ".claude",
];

export interface DocumentCerveau {
  /** Chemin relatif au dépôt, séparateurs `/`. */
  chemin: string;
  /** Chemin absolu sur le disque. */
  absolu: string;
  /** Taille en octets. */
  taille: number;
  /** Vrai pour les documents principaux (CLAUDE.md, README, etc.). */
  prioritaire: boolean;
}

/** Recense les documents de contexte d'un dépôt sans en lire le contenu. */
export async function recenserCerveau(racine: string): Promise<DocumentCerveau[]> {
  const documents: DocumentCerveau[] = [];
  const dejaVu = new Set<string>();

  for (const nom of DOCUMENTS_PRIORITAIRES) {
    const chemin = await resoudreCheminInsensible(racine, nom);
    if (!chemin) continue;
    if (dejaVu.has(nom.toLowerCase())) continue;
    dejaVu.add(nom.toLowerCase());
    documents.push({
      chemin: nom,
      absolu: chemin,
      taille: await tailleSure(chemin),
      prioritaire: true,
    });
  }

  // Autres markdown à la racine, utiles mais non lus par défaut.
  for (const e of await listerDossier(racine)) {
    if (!e.isFile()) continue;
    const bas = e.name.toLowerCase();
    if (!bas.endsWith(".md") || dejaVu.has(bas)) continue;
    dejaVu.add(bas);
    documents.push({
      chemin: e.name,
      absolu: path.join(racine, e.name),
      taille: await tailleSure(path.join(racine, e.name)),
      prioritaire: false,
    });
  }

  // Documents de contexte rangés dans des sous-dossiers connus.
  for (const dossier of DOSSIERS_CONTEXTE) {
    const abs = path.join(racine, dossier);
    const fichiers = await parcourir(abs, {
      profondeurMax: 2,
      limiteFichiers: 60,
      filtre: (rel) => rel.toLowerCase().endsWith(".md"),
    });
    for (const f of fichiers) {
      const relatif = `${dossier}/${f.relatif}`;
      if (dejaVu.has(relatif.toLowerCase())) continue;
      dejaVu.add(relatif.toLowerCase());
      documents.push({
        chemin: relatif,
        absolu: f.absolu,
        taille: f.taille,
        prioritaire: false,
      });
    }
  }

  return documents;
}

async function tailleSure(chemin: string): Promise<number> {
  const { stat } = await import("node:fs/promises");
  try {
    return (await stat(chemin)).size;
  } catch {
    return 0;
  }
}

/**
 * Extrait un résumé court du rôle d'un projet à partir d'un texte markdown.
 * On saute les titres, les badges, les blocs de code et les commentaires HTML,
 * puis on prend le premier vrai paragraphe.
 */
export function extraireResume(markdown: string, longueurMax = 300): string | null {
  const sansCommentaires = markdown.replace(/<!--[\s\S]*?-->/g, "");
  const lignes = sansCommentaires.split(/\r?\n/);

  const paragraphe: string[] = [];
  const puces: string[] = [];
  let dansCodeFence = false;

  for (let i = 0; i < lignes.length; i++) {
    const brute = lignes[i];
    const ligne = brute.trim();
    const suivante = (lignes[i + 1] ?? "").trim();

    // Bloc de code indenté : ce sont des commandes, pas une description.
    // Un vrai paragraphe markdown commence en colonne zéro.
    if (/^(\t| {2,})\S/.test(brute) && paragraphe.length === 0) continue;

    if (ligne.startsWith("```")) {
      dansCodeFence = !dansCodeFence;
      continue;
    }
    if (dansCodeFence) continue;

    // Titre en style setext : le texte est souligné par des = ou des -.
    if (ligne !== "" && /^[=-]{3,}$/.test(suivante)) {
      i++;
      continue;
    }

    if (paragraphe.length === 0) {
      // On cherche le début du premier paragraphe utile.
      if (ligne === "") continue;
      if (ligne.startsWith("#")) continue;
      if (ligne.startsWith("<")) continue; // en-tête HTML, bloc centré, badges
      if (/^[-*_=]{3,}$/.test(ligne)) continue;
      if (/^!\[/.test(ligne)) continue; // ligne de badges ou d'images
      if (/^\[!\[/.test(ligne)) continue; // badge cliquable
      if (/^\|/.test(ligne)) continue; // tableau
      if (/^>/.test(ligne)) continue; // citation
      if (/^[-*+]\s/.test(ligne)) continue; // puce isolée avant tout paragraphe
      // Une ligne qui n'est qu'un lien ou qu'une image n'apprend rien.
      if (/^\[[^\]]*\]\([^)]*\)$/.test(ligne)) continue;
      // Ni une simple URL, même précédée d'une étiquette du type « GitHub : ».
      if (/^([\wÀ-ÿ .'-]{0,24}:\s*)?https?:\/\/\S+$/i.test(ligne)) continue;
      paragraphe.push(ligne);
    } else {
      if (ligne === "" || ligne.startsWith("#") || ligne.startsWith("<")) break;
      paragraphe.push(ligne);
    }
  }

  if (paragraphe.length === 0) return null;

  // Un paragraphe qui se termine par deux-points annonce une liste :
  // sans elle, le résumé ne dirait rien. On récupère les premières puces.
  if (paragraphe[paragraphe.length - 1].endsWith(":")) {
    const debutListe = lignes.findIndex(
      (l) => l.trim() === paragraphe[paragraphe.length - 1]
    );
    if (debutListe !== -1) {
      for (let i = debutListe + 1; i < lignes.length && puces.length < 4; i++) {
        const l = lignes[i].trim();
        if (l === "") continue;
        if (!/^[-*+]\s+/.test(l)) break;
        puces.push(l.replace(/^[-*+]\s+/, ""));
      }
    }
  }

  let texte = [...paragraphe, puces.join(", ")]
    .filter((p) => p !== "")
    .join(" ")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (texte.length > longueurMax) {
    texte = texte.slice(0, longueurMax).replace(/\s+\S*$/, "") + "...";
  }
  return texte === "" ? null : texte;
}

export interface RoleDeduit {
  /** Résumé en une ou deux phrases. */
  resume: string | null;
  /** Fichier qui a servi de source, ou null. */
  source: string | null;
}

/**
 * Déduit le rôle d'un projet. Ordre de confiance : CLAUDE.md, puis AGENTS.md,
 * puis README, puis la description du manifeste de paquet.
 */
export async function deduireRole(
  racine: string,
  descriptionPaquet: string | null
): Promise<RoleDeduit> {
  const ordre = [
    "CLAUDE.md",
    ".claude/CLAUDE.md",
    "AGENTS.md",
    ".claude/AGENTS.md",
    "README.md",
    "ARCHITECTURE.md",
  ];
  for (const nom of ordre) {
    const chemin = await resoudreCheminInsensible(racine, nom);
    if (!chemin) continue;
    const contenu = await lireTexte(chemin);
    if (!contenu) continue;
    const resume = extraireResume(contenu);
    if (resume) return { resume, source: nom };
  }

  if (descriptionPaquet && descriptionPaquet.trim() !== "") {
    return { resume: descriptionPaquet.trim(), source: "manifeste de paquet" };
  }

  return { resume: null, source: null };
}

export interface DocumentLu {
  chemin: string;
  taille: number;
  tronque: boolean;
  contenu: string;
}

/** Lit un document en appliquant une troncature en caractères. */
export async function lireDocument(
  absolu: string,
  cheminRelatif: string,
  maxCaracteres: number
): Promise<DocumentLu | null> {
  const contenu = await lireTexte(absolu);
  if (contenu === null) return null;
  const tronque = contenu.length > maxCaracteres;
  return {
    chemin: cheminRelatif,
    taille: contenu.length,
    tronque,
    contenu: tronque
      ? contenu.slice(0, maxCaracteres) +
        `\n\n[...] document tronqué à ${maxCaracteres} caractères sur ${contenu.length}. Relance avec un max_caracteres plus élevé, ou cible ce fichier seul.`
      : contenu,
  };
}
