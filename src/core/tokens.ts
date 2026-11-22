/**
 * Tokens consommés par les agents de code, lus dans leurs journaux locaux.
 *
 * Trois sources, toutes en lecture seule :
 * 1. Claude Code : `~/.claude/projects/<projet>/*.jsonl` et les journaux de
 *    sous agents rangés dessous. Une réponse est écrite sur plusieurs lignes
 *    (une par bloc de contenu) avec le même identifiant de message et le même
 *    usage : on ne compte chaque message qu'une fois. Le dossier `archive` est
 *    ignoré, comme dans l'appli Finances.
 * 2. Codex : `~/.codex/sessions/AAAA/MM/JJ/rollout-*.jsonl` et
 *    `~/.codex/archived_sessions`. Les événements `token_count` portent un
 *    total cumulé depuis le début de la session : on additionne les écarts
 *    d'un événement au suivant, ce qui absorbe les répétitions.
 * 3. Mistral Vibe : `~/.vibe/logs/session/unified/<session>/journal/*.jsonl`.
 *    Chaque `completion_succeeded` porte l'usage d'un seul appel.
 *
 * Les trois outils ne comptent pas l'entrée de la même façon. Tout est ramené
 * à une convention commune : `entree` (entrée facturée plein tarif, écriture
 * du cache comprise), `entree_cache` (entrée relue depuis le cache) et
 * `sortie` (raisonnement compris).
 *
 * Les journaux pèsent plusieurs Go : la recherche se fait dans les octets
 * (`Buffer.indexOf`), seules les lignes utiles sont décodées, et le résultat
 * de chaque fichier est gardé en mémoire tant que sa date et sa taille ne
 * changent pas.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { inventorier } from "./depots.js";

export type AgentCode = "Claude Code" | "Codex" | "Mistral Vibe";

export interface CompteTokens {
  entree: number;
  entree_cache: number;
  sortie: number;
}

/** Usage agrégé d'un fichier de journal pour un jour, un dossier et un modèle. */
export interface LigneTokens extends CompteTokens {
  agent: AgentCode;
  jour: string; // AAAA-MM-JJ, heure locale
  dossier: string; // dossier de travail de la session
  modele: string;
  appels: number;
  session: string; // chemin du fichier de journal, pour compter les sessions
}

const cache = new Map<string, { mtime: number; taille: number; lignes: LigneTokens[] }>();

function jourLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nombre(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Accumulateur par (jour, dossier, modèle) pour un fichier. */
class Accumulateur {
  private cartes = new Map<string, LigneTokens>();
  constructor(private agent: AgentCode, private session: string) {}

  ajouter(ms: number, dossier: string, modele: string, c: CompteTokens): void {
    if (!Number.isFinite(ms)) return;
    const jour = jourLocal(ms);
    const cle = `${jour}|${dossier}|${modele}`;
    let l = this.cartes.get(cle);
    if (!l) {
      l = { agent: this.agent, jour, dossier, modele, appels: 0, session: this.session, entree: 0, entree_cache: 0, sortie: 0 };
      this.cartes.set(cle, l);
    }
    l.appels += 1;
    l.entree += Math.max(0, c.entree);
    l.entree_cache += Math.max(0, c.entree_cache);
    l.sortie += Math.max(0, c.sortie);
  }

  lignes(): LigneTokens[] {
    return [...this.cartes.values()];
  }
}

/** Parcourt les lignes d'un tampon qui contiennent un marqueur, sans décoder le reste. */
function* lignesAvec(buf: Buffer, marqueur: string): Generator<string> {
  let pos = 0;
  while (true) {
    const i = buf.indexOf(marqueur, pos);
    if (i < 0) return;
    const debut = buf.lastIndexOf(10, i) + 1;
    let fin = buf.indexOf(10, i);
    if (fin < 0) fin = buf.length;
    yield buf.toString("utf8", debut, fin);
    pos = fin + 1;
  }
}

/** Liste récursivement les fichiers `.jsonl` modifiés depuis `depuisMs`. */
async function jsonlRecents(racine: string, depuisMs: number, ignorer: string[] = []): Promise<string[]> {
  const trouves: string[] = [];
  const pile = [racine];
  while (pile.length > 0) {
    const dossier = pile.pop()!;
    let entrees;
    try {
      entrees = await readdir(dossier, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entrees) {
      const chemin = path.join(dossier, e.name);
      if (e.isDirectory()) {
        if (!ignorer.includes(e.name)) pile.push(chemin);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          if ((await stat(chemin)).mtimeMs >= depuisMs) trouves.push(chemin);
        } catch {
          /* fichier disparu entre deux appels */
        }
      }
    }
  }
  return trouves;
}

async function avecCache(chemin: string, lire: (buf: Buffer) => Promise<LigneTokens[]> | LigneTokens[]): Promise<LigneTokens[]> {
  let s;
  try {
    s = await stat(chemin);
  } catch {
    return [];
  }
  const connu = cache.get(chemin);
  if (connu && connu.mtime === s.mtimeMs && connu.taille === s.size) return connu.lignes;
  let lignes: LigneTokens[] = [];
  try {
    lignes = await lire(await readFile(chemin));
  } catch {
    lignes = [];
  }
  cache.set(chemin, { mtime: s.mtimeMs, taille: s.size, lignes });
  return lignes;
}

/* ------------------------------------------------------------------ */
/* Claude Code                                                         */
/* ------------------------------------------------------------------ */

function lireJournalClaude(chemin: string, buf: Buffer): LigneTokens[] {
  const acc = new Accumulateur("Claude Code", chemin);
  const vus = new Set<string>();
  for (const ligne of lignesAvec(buf, '"usage":{')) {
    let o: any;
    try {
      o = JSON.parse(ligne);
    } catch {
      continue;
    }
    const m = o?.message;
    if (o?.type !== "assistant" || !m?.usage || m.model === "<synthetic>") continue;
    const id = m.id ?? o.requestId ?? o.uuid;
    if (id) {
      if (vus.has(id)) continue;
      vus.add(id);
    }
    const u = m.usage;
    acc.ajouter(Date.parse(o.timestamp), o.cwd ?? "", m.model ?? "inconnu", {
      entree: nombre(u.input_tokens) + nombre(u.cache_creation_input_tokens),
      entree_cache: nombre(u.cache_read_input_tokens),
      sortie: nombre(u.output_tokens),
    });
  }
  return acc.lignes();
}

async function tokensClaude(depuisMs: number): Promise<LigneTokens[]> {
  const fichiers = await jsonlRecents(config.dossierClaude, depuisMs, ["archive"]);
  const out: LigneTokens[] = [];
  for (const f of fichiers) out.push(...(await avecCache(f, (b) => lireJournalClaude(f, b))));
  return out;
}

/* ------------------------------------------------------------------ */
/* Codex                                                               */
/* ------------------------------------------------------------------ */

function lireJournalCodex(chemin: string, buf: Buffer): LigneTokens[] {
  const acc = new Accumulateur("Codex", chemin);
  let dossier = "";
  let modele = "inconnu";
  let prec = { entree: 0, cache: 0, sortie: 0 };
  let pos = 0;
  while (pos < buf.length) {
    let fin = buf.indexOf(10, pos);
    if (fin < 0) fin = buf.length;
    const tete = buf.toString("utf8", pos, Math.min(fin, pos + 200));
    const utile =
      tete.includes('"type":"token_count"') ||
      tete.includes('"type":"session_meta"') ||
      tete.includes('"type":"turn_context"');
    if (utile) {
      try {
        const o = JSON.parse(buf.toString("utf8", pos, fin));
        const p = o?.payload;
        if (o.type === "session_meta") {
          dossier = p?.cwd ?? dossier;
        } else if (o.type === "turn_context") {
          modele = p?.model ?? modele;
          dossier = p?.cwd ?? dossier;
        } else if (p?.type === "token_count" && p.info?.total_token_usage) {
          const t = p.info.total_token_usage;
          const cache = nombre(t.cached_input_tokens);
          const courant = { entree: nombre(t.input_tokens) - cache, cache, sortie: nombre(t.output_tokens) };
          // Un total qui recule signale une remise à zéro : on repart de lui.
          const recul = courant.entree + courant.cache + courant.sortie < prec.entree + prec.cache + prec.sortie;
          const base = recul ? { entree: 0, cache: 0, sortie: 0 } : prec;
          const delta = {
            entree: courant.entree - base.entree,
            entree_cache: courant.cache - base.cache,
            sortie: courant.sortie - base.sortie,
          };
          if (delta.entree + delta.entree_cache + delta.sortie > 0) {
            acc.ajouter(Date.parse(o.timestamp), dossier, modele, delta);
          }
          prec = courant;
        }
      } catch {
        /* ligne tronquée : ignorée */
      }
    }
    pos = fin + 1;
  }
  return acc.lignes();
}

async function tokensCodex(depuisMs: number): Promise<LigneTokens[]> {
  const racines = [config.dossierCodex, path.join(path.dirname(config.dossierCodex), "archived_sessions")];
  const out: LigneTokens[] = [];
  for (const r of racines) {
    for (const f of await jsonlRecents(r, depuisMs)) {
      out.push(...(await avecCache(f, (b) => lireJournalCodex(f, b))));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Mistral Vibe                                                        */
/* ------------------------------------------------------------------ */

async function metaVibe(dossierSession: string): Promise<{ dossier: string; modele: string }> {
  try {
    const m = JSON.parse(await readFile(path.join(dossierSession, "meta.json"), "utf8"));
    return {
      dossier: m?.environment?.working_directory ?? m?.origin_directory ?? "",
      modele: m?.config?.model_name ?? m?.config?.active_model ?? "inconnu",
    };
  } catch {
    return { dossier: "", modele: "inconnu" };
  }
}

function lireJournalVibe(chemin: string, buf: Buffer, meta: { dossier: string; modele: string }): LigneTokens[] {
  const acc = new Accumulateur("Mistral Vibe", path.dirname(path.dirname(chemin)));
  for (const ligne of lignesAvec(buf, '"completion_succeeded"')) {
    let o: any;
    try {
      o = JSON.parse(ligne);
    } catch {
      continue;
    }
    const entree = o?.payload?.input;
    const u = entree?.command?.result?.usage;
    if (!u) continue;
    const cache = nombre(u.cached_input_tokens);
    acc.ajouter(nombre(entree?.determinism?.time_unix_ms), meta.dossier, meta.modele, {
      entree: nombre(u.input_tokens) - cache,
      entree_cache: cache,
      sortie: nombre(u.output_tokens),
    });
  }
  return acc.lignes();
}

async function tokensVibe(depuisMs: number): Promise<LigneTokens[]> {
  const out: LigneTokens[] = [];
  let sessions;
  try {
    sessions = await readdir(config.dossierVibe, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const s of sessions) {
    if (!s.isDirectory()) continue;
    const dossierSession = path.join(config.dossierVibe, s.name);
    const fichiers = await jsonlRecents(path.join(dossierSession, "journal"), depuisMs);
    if (fichiers.length === 0) continue;
    const meta = await metaVibe(dossierSession);
    for (const f of fichiers) out.push(...(await avecCache(f, (b) => lireJournalVibe(f, b, meta))));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Rattachement d'un dossier de travail à un projet                    */
/* ------------------------------------------------------------------ */

function normaliser(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

const cacheProjets = new Map<string, string>();

/**
 * Nom du projet d'un dossier de travail : le dépôt connu qui le contient, sinon
 * le dépôt principal d'un worktree git (lu dans son fichier `.git`), sinon le
 * nom du dossier lui même.
 */
export async function projetDuDossier(dossier: string): Promise<string> {
  if (!dossier) return "inconnu";
  const connu = cacheProjets.get(dossier);
  if (connu) return connu;
  const depots = (await inventorier()).map((d) => ({ nom: d.nom, chemin: normaliser(d.chemin) }));
  const n = normaliser(dossier);
  const trouver = (cible: string) =>
    depots
      .filter((d) => cible === d.chemin || cible.startsWith(d.chemin + "/"))
      .sort((a, b) => b.chemin.length - a.chemin.length)[0]?.nom;
  let nom: string | undefined = trouver(n);
  if (!nom) {
    // Dossier mémoire de Claude Code (`~/.claude/projects/<slug>/memory`) : le slug
    // est le chemin du projet dont chaque caractère non alphanumérique devient « - ».
    const slug = n.match(/\/\.claude\/projects\/([^/]+)/)?.[1];
    if (slug) {
      const enSlug = (c: string) => c.replace(/[^a-z0-9]/g, "-");
      nom = depots.find((d) => enSlug(d.chemin) === slug)?.nom;
    }
  }
  if (!nom) {
    try {
      const git = await readFile(path.join(dossier, ".git"), "utf8");
      const m = git.match(/gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/i);
      if (m) nom = trouver(normaliser(m[1].trim())) ?? path.basename(m[1].trim());
    } catch {
      /* pas un worktree, ou worktree supprimé */
    }
  }
  nom = nom ?? (path.basename(dossier) || dossier);
  cacheProjets.set(dossier, nom);
  return nom;
}

/** Lit les tokens des trois agents depuis une date (ms). */
export async function lireTokensAgents(depuisMs: number): Promise<{
  lignes: (LigneTokens & { projet: string })[];
  sources: Record<AgentCode, string[]>;
}> {
  const [claude, codex, vibe] = await Promise.all([
    tokensClaude(depuisMs),
    tokensCodex(depuisMs),
    tokensVibe(depuisMs),
  ]);
  const jourMin = jourLocal(depuisMs);
  const lignes: (LigneTokens & { projet: string })[] = [];
  for (const l of [...claude, ...codex, ...vibe]) {
    if (l.jour < jourMin) continue;
    lignes.push({ ...l, projet: await projetDuDossier(l.dossier) });
  }
  return {
    lignes,
    sources: {
      "Claude Code": [config.dossierClaude],
      Codex: [config.dossierCodex, path.join(path.dirname(config.dossierCodex), "archived_sessions")],
      "Mistral Vibe": [config.dossierVibe],
    },
  };
}
