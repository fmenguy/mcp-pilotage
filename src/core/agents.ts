/**
 * Suivi des agents de code en cours sur la machine.
 *
 * Tout est lu en lecture seule : les journaux de session de Codex, de Claude
 * Code et de Mistral Vibe (seulement la fin des fichiers, jamais leur
 * totalité), et la liste des processus vivants. Aucune écriture, aucun kill,
 * aucun changement de priorité.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

const OCTETS_FIN = 256 * 1024;
const OCTETS_DEBUT = 128 * 1024;

/** Plafond de journaux Codex examinés : leur date de modification n'est pas fiable sous Windows tant qu'ils sont ouverts. */
const MAX_FICHIERS_CODEX = 60;

export interface ActionAgent {
  quand: number;
  resume: string;
}

export interface SousAgent {
  nom: string;
  derniereActivite: number;
}

export interface SessionAgent {
  fournisseur: "Codex" | "Claude Code" | "Mistral Vibe";
  id: string;
  modele: string | null;
  dossier: string | null;
  branche: string | null;
  brancheOrigine: "démarrage" | "courante" | null;
  debut: number | null;
  derniereActivite: number;
  nbActions: number;
  actions: ActionAgent[];
  fichiersModifies: string[];
  sousAgents: SousAgent[];
  surnom: string | null;
  parent: string | null;
  note: string | null;
}

/** Lit la fin d'un fichier, en écartant la première ligne si elle est coupée. */
async function lireFin(fichier: string, octets: number): Promise<string[]> {
  const fh = await fs.open(fichier, "r");
  try {
    const { size } = await fh.stat();
    const debut = Math.max(0, size - octets);
    const tampon = Buffer.alloc(size - debut);
    await fh.read(tampon, 0, tampon.length, debut);
    const lignes = tampon.toString("utf8").split("\n");
    if (debut > 0) lignes.shift();
    return lignes.filter((l) => l.trim() !== "");
  } finally {
    await fh.close();
  }
}

/** Lit le début d'un fichier et rend les premières lignes complètes. */
async function lireDebut(fichier: string, octets: number): Promise<string[]> {
  const fh = await fs.open(fichier, "r");
  try {
    const tampon = Buffer.alloc(octets);
    const { bytesRead } = await fh.read(tampon, 0, octets, 0);
    const lignes = tampon.toString("utf8", 0, bytesRead).split("\n");
    if (bytesRead === octets) lignes.pop();
    return lignes.filter((l) => l.trim() !== "");
  } finally {
    await fh.close();
  }
}

function analyser(ligne: string): any | null {
  try {
    return JSON.parse(ligne);
  } catch {
    return null;
  }
}

function horodatage(valeur: unknown): number | null {
  if (typeof valeur !== "string") return null;
  const t = Date.parse(valeur);
  return Number.isFinite(t) ? t : null;
}

/** Réduit une commande à une ligne courte. */
export function resumer(texte: string, max = 160): string {
  const une = texte.replace(/\s+/g, " ").trim();
  return une.length > max ? `${une.slice(0, max - 3)}...` : une;
}

async function mtime(fichier: string): Promise<number | null> {
  try {
    return (await fs.stat(fichier)).mtimeMs;
  } catch {
    return null;
  }
}

async function listerDossier(dossier: string): Promise<string[]> {
  try {
    return await fs.readdir(dossier);
  } catch {
    return [];
  }
}

function normaliserChemin(p: string): string {
  return p.replace(/\//g, "\\");
}

/* ------------------------------------------------------------------ */
/* Codex                                                               */
/* ------------------------------------------------------------------ */

function extraireCommandesCodex(input: string): string[] {
  const resultats: string[] = [];
  const re = /cmd:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    try {
      resultats.push(JSON.parse(`"${m[1]}"`));
    } catch {
      resultats.push(m[1]);
    }
  }
  return resultats;
}

function extraireFichiersPatch(input: string): string[] {
  const resultats: string[] = [];
  const re = /\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+?)(?:\\n|\n|")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) resultats.push(m[1].trim());
  return resultats;
}

function actionsCodex(payload: any, quand: number): ActionAgent[] {
  const t = payload.type;
  if (t === "custom_tool_call" && typeof payload.input === "string") {
    const input: string = payload.input;
    const sortie: ActionAgent[] = [];
    const patch = extraireFichiersPatch(input);
    if (patch.length > 0) {
      sortie.push({ quand, resume: `patch : ${patch.map((f) => path.basename(f)).join(", ")}` });
    }
    for (const cmd of extraireCommandesCodex(input)) sortie.push({ quand, resume: resumer(cmd) });
    if (sortie.length === 0 && input.includes("write_stdin")) {
      sortie.push({ quand, resume: "attente de la sortie d'une commande en cours" });
    }
    if (sortie.length === 0) sortie.push({ quand, resume: resumer(input, 100) });
    return sortie;
  }
  if (t === "function_call") {
    const nom = String(payload.name ?? "outil");
    let detail = "";
    try {
      const a = JSON.parse(payload.arguments ?? "{}");
      if (typeof a.cmd === "string") detail = a.cmd;
      else if (typeof a.command === "string") detail = a.command;
      else if (typeof a.target === "string") detail = `vers ${a.target}`;
    } catch {
      /* arguments illisibles : on garde le nom seul */
    }
    return [{ quand, resume: detail ? `${nom} : ${resumer(detail, 120)}` : nom }];
  }
  return [];
}

async function fichiersCodexRecents(limiteMs: number): Promise<{ chemin: string; mtime: number }[]> {
  const racine = config.dossierCodex;
  const maintenant = Date.now();
  const nbJours = Math.ceil((maintenant - limiteMs) / 86_400_000) + 1;
  const p = (n: number) => String(n).padStart(2, "0");
  const jours = new Set<string>();
  for (let i = 0; i <= nbJours; i++) {
    const d = new Date(maintenant - i * 86_400_000);
    jours.add(path.join(racine, String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate())));
  }
  const trouves: { chemin: string; mtime: number }[] = [];
  for (const jour of jours) {
    for (const nom of await listerDossier(jour)) {
      if (!nom.startsWith("rollout-") || !nom.endsWith(".jsonl")) continue;
      const chemin = path.join(jour, nom);
      trouves.push({ chemin, mtime: (await mtime(chemin)) ?? 0 });
    }
  }
  trouves.sort((x, y) => y.chemin.localeCompare(x.chemin));
  return trouves.slice(0, MAX_FICHIERS_CODEX);
}

async function lireSessionCodex(chemin: string, mtimeMs: number): Promise<SessionAgent | null> {
  const debut = await lireDebut(chemin, OCTETS_DEBUT);
  const meta = debut.length > 0 ? analyser(debut[0]) : null;
  const p = meta?.payload ?? {};
  const lignes = (await lireFin(chemin, OCTETS_FIN)).map(analyser).filter((l) => l !== null);

  let modele: string | null = null;
  let dossier: string | null = typeof p.cwd === "string" ? p.cwd : null;
  const actions: ActionAgent[] = [];
  const fichiers: string[] = [];
  let derniere = mtimeMs;
  let sousAgentsActifs = 0;

  for (const l of lignes) {
    const quand = horodatage(l.timestamp) ?? mtimeMs;
    derniere = Math.max(derniere === mtimeMs ? 0 : derniere, quand);
    const pl = l.payload;
    if (!pl) continue;
    if (l.type === "turn_context") {
      if (typeof pl.model === "string") modele = pl.model;
      if (typeof pl.cwd === "string") dossier = pl.cwd;
    }
    if (pl.type === "sub_agent_activity") sousAgentsActifs++;
    if (pl.type === "patch_apply_end" && pl.changes && typeof pl.changes === "object") {
      for (const f of Object.keys(pl.changes)) if (!fichiers.includes(f)) fichiers.push(f);
    }
    if (l.type === "response_item") actions.push(...actionsCodex(pl, quand));
  }
  if (derniere === 0) derniere = mtimeMs;

  if (!modele) {
    const m = /"model":"([^"]+)"/.exec(debut[0] ?? "");
    modele = m ? m[1] : null;
  }

  const sousAgent = p.thread_source === "subagent";
  return {
    fournisseur: "Codex",
    id: String(p.id ?? path.basename(chemin)),
    modele,
    dossier,
    branche: typeof p.git?.branch === "string" ? p.git.branch : null,
    brancheOrigine: typeof p.git?.branch === "string" ? "démarrage" : null,
    debut: horodatage(p.timestamp) ?? horodatage(meta?.timestamp),
    derniereActivite: derniere,
    nbActions: actions.length,
    actions,
    fichiersModifies: fichiers.map(normaliserChemin),
    sousAgents: [],
    surnom: typeof p.agent_nickname === "string" ? p.agent_nickname : null,
    parent: sousAgent && typeof p.parent_thread_id === "string" ? p.parent_thread_id : null,
    note:
      sousAgentsActifs > 0
        ? `${sousAgentsActifs} événement(s) de sous-agents dans la fin du journal`
        : null,
  };
}

export async function lireSessionsCodex(limiteMs: number): Promise<SessionAgent[]> {
  const sessions: SessionAgent[] = [];
  for (const f of await fichiersCodexRecents(limiteMs)) {
    try {
      const s = await lireSessionCodex(f.chemin, f.mtime);
      if (s && s.derniereActivite >= limiteMs) sessions.push(s);
    } catch {
      /* un journal illisible ne doit pas masquer les autres */
    }
  }
  return sessions;
}

/* ------------------------------------------------------------------ */
/* Claude Code                                                         */
/* ------------------------------------------------------------------ */

function actionClaude(bloc: any): { resume: string; fichier?: string; modifie: boolean } | null {
  if (!bloc || bloc.type !== "tool_use") return null;
  const nom = String(bloc.name ?? "outil");
  const i = bloc.input ?? {};
  if (typeof i.command === "string") return { resume: `${nom} : ${resumer(i.command)}`, modifie: false };
  if (typeof i.file_path === "string") {
    return {
      resume: `${nom} : ${i.file_path}`,
      fichier: i.file_path,
      modifie: nom === "Edit" || nom === "Write" || nom === "NotebookEdit",
    };
  }
  if (typeof i.pattern === "string") return { resume: `${nom} : ${resumer(i.pattern, 100)}`, modifie: false };
  if (typeof i.description === "string") return { resume: `${nom} : ${resumer(i.description, 120)}`, modifie: false };
  return { resume: nom, modifie: false };
}

async function lireSessionClaude(chemin: string, mtimeMs: number): Promise<SessionAgent> {
  const debut = (await lireDebut(chemin, 16 * 1024)).map(analyser).filter((l) => l !== null);
  const lignes = (await lireFin(chemin, OCTETS_FIN)).map(analyser).filter((l) => l !== null);

  let dossier: string | null = null;
  let branche: string | null = null;
  let modele: string | null = null;
  let derniere = 0;
  const actions: ActionAgent[] = [];
  const fichiers: string[] = [];

  for (const l of lignes) {
    const quand = horodatage(l.timestamp);
    if (quand !== null) derniere = Math.max(derniere, quand);
    if (typeof l.cwd === "string") dossier = l.cwd;
    if (typeof l.gitBranch === "string" && l.gitBranch !== "") branche = l.gitBranch;
    if (l.type !== "assistant") continue;
    if (typeof l.message?.model === "string") modele = l.message.model;
    const contenu = l.message?.content;
    if (!Array.isArray(contenu)) continue;
    for (const bloc of contenu) {
      const a = actionClaude(bloc);
      if (!a) continue;
      actions.push({ quand: quand ?? mtimeMs, resume: a.resume });
      if (a.modifie && a.fichier && !fichiers.includes(a.fichier)) fichiers.push(a.fichier);
    }
  }

  const premier = debut.map((l) => horodatage(l.timestamp)).find((t) => t !== null) ?? null;
  const id = path.basename(chemin, ".jsonl");

  const sousAgents: SousAgent[] = [];
  const dossierSous = path.join(path.dirname(chemin), id, "subagents");
  for (const nom of await listerDossier(dossierSous)) {
    if (!nom.endsWith(".jsonl")) continue;
    const m = await mtime(path.join(dossierSous, nom));
    if (m === null) continue;
    let description = nom.replace(/\.jsonl$/, "");
    try {
      const meta = JSON.parse(
        await fs.readFile(path.join(dossierSous, nom.replace(/\.jsonl$/, ".meta.json")), "utf8")
      );
      if (typeof meta.description === "string") description = meta.description;
    } catch {
      /* méta absente : on garde l'identifiant */
    }
    sousAgents.push({ nom: description, derniereActivite: m });
  }

  return {
    fournisseur: "Claude Code",
    id,
    modele,
    dossier,
    branche,
    brancheOrigine: branche ? "courante" : null,
    debut: premier,
    derniereActivite: derniere || mtimeMs,
    nbActions: actions.length,
    actions,
    fichiersModifies: fichiers.map(normaliserChemin),
    sousAgents,
    surnom: null,
    parent: null,
    note: null,
  };
}

export async function lireSessionsClaude(limiteMs: number): Promise<SessionAgent[]> {
  const sessions: SessionAgent[] = [];
  for (const projet of await listerDossier(config.dossierClaude)) {
    const dossierProjet = path.join(config.dossierClaude, projet);
    for (const nom of await listerDossier(dossierProjet)) {
      if (!nom.endsWith(".jsonl")) continue;
      const chemin = path.join(dossierProjet, nom);
      const m = await mtime(chemin);
      if (m === null || m < limiteMs) continue;
      try {
        sessions.push(await lireSessionClaude(chemin, m));
      } catch {
        /* journal illisible : ignoré */
      }
    }
  }
  return sessions;
}

/* ------------------------------------------------------------------ */
/* Mistral Vibe                                                        */
/* ------------------------------------------------------------------ */

export async function lireSessionsVibe(limiteMs: number): Promise<{ sessions: SessionAgent[]; present: boolean }> {
  const noms = await listerDossier(config.dossierVibe);
  const sessions: SessionAgent[] = [];
  for (const nom of noms) {
    const dossier = path.join(config.dossierVibe, nom);
    const metaChemin = path.join(dossier, "meta.json");
    let derniere = (await mtime(metaChemin)) ?? 0;
    for (const sous of ["journal", "chunks"]) {
      for (const f of await listerDossier(path.join(dossier, sous))) {
        derniere = Math.max(derniere, (await mtime(path.join(dossier, sous, f))) ?? 0);
      }
    }
    if (derniere < limiteMs) continue;
    try {
      const meta = JSON.parse(await fs.readFile(metaChemin, "utf8"));
      sessions.push({
        fournisseur: "Mistral Vibe",
        id: String(meta.session_id ?? nom),
        modele: meta.config?.active_model ?? null,
        dossier: meta.environment?.working_directory ?? meta.origin_directory ?? null,
        branche: meta.git_branch ?? null,
        brancheOrigine: meta.git_branch ? "démarrage" : null,
        debut: horodatage(meta.start_time),
        derniereActivite: derniere,
        nbActions: 0,
        actions: [],
        fichiersModifies: [],
        sousAgents: [],
        surnom: null,
        parent: null,
        note: "détail des actions non lu pour Vibe (format de journal par blocs)",
      });
    } catch {
      /* méta illisible : ignorée */
    }
  }
  return { sessions, present: noms.length > 0 };
}

/* ------------------------------------------------------------------ */
/* Processus                                                           */
/* ------------------------------------------------------------------ */

export interface Processus {
  pid: number;
  parent: number;
  nom: string;
  debut: number | null;
  ligne: string;
}

export interface SuiteTests {
  pid: number;
  ligne: string;
  dossier: string | null;
  debut: number | null;
  orpheline: boolean;
  raison: string | null;
}

export interface EtatProcessus {
  charge: number | null;
  total: number;
  nbNode: number;
  nbCodex: number;
  nbClaude: number;
  suites: SuiteTests[];
  doublons: { dossier: string; pids: number[] }[];
  erreur: string | null;
}

const SCRIPT_PROCESSUS = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$noms='node.exe','codex.exe','claude.exe','vibe.exe','python.exe'",
  "$p=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p=$_.ProcessId; pp=$_.ParentProcessId; n=$_.Name; d=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null}); c=$(if($noms -contains $_.Name){$_.CommandLine}else{$null}) } })",
  "$l=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average",
  "[pscustomobject]@{ charge=$l; procs=$p } | ConvertTo-Json -Compress -Depth 4",
].join("; ");

const MOTIF_SUITE = /test-carte\.mjs|(?:^|\s)--test(?:\s|$)|--test-reporter/;

function dossierDeCommande(ligne: string): string | null {
  const m = /([A-Za-z]:[\\/](?:tmp|git)[\\/][^\\/\s"']+)/i.exec(ligne);
  return m ? m[1].replace(/\//g, "\\") : null;
}

export async function lireProcessus(): Promise<EtatProcessus> {
  const vide: EtatProcessus = {
    charge: null, total: 0, nbNode: 0, nbCodex: 0, nbClaude: 0, suites: [], doublons: [], erreur: null,
  };
  if (process.platform !== "win32") {
    return { ...vide, erreur: "Lecture des processus prévue pour Windows uniquement." };
  }
  let brut: any;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SCRIPT_PROCESSUS],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" }
    );
    brut = JSON.parse(stdout);
  } catch (err) {
    return { ...vide, erreur: `Lecture des processus impossible : ${err instanceof Error ? err.message : String(err)}` };
  }

  const liste: any[] = Array.isArray(brut.procs) ? brut.procs : [brut.procs];
  const procs = new Map<number, Processus>();
  for (const x of liste) {
    procs.set(x.p, {
      pid: x.p,
      parent: x.pp,
      nom: String(x.n ?? "").toLowerCase(),
      debut: horodatage(x.d),
      ligne: typeof x.c === "string" ? x.c : "",
    });
  }

  const enfants = new Map<number, Processus[]>();
  for (const p of procs.values()) {
    const l = enfants.get(p.parent) ?? [];
    l.push(p);
    enfants.set(p.parent, l);
  }

  const estSuite = (p: Processus) => p.nom === "node.exe" && MOTIF_SUITE.test(p.ligne);

  const dossierDe = (racine: Processus): string | null => {
    const pile = [racine];
    const vus = new Set<number>();
    while (pile.length > 0) {
      const p = pile.shift()!;
      if (vus.has(p.pid)) continue;
      vus.add(p.pid);
      const d = dossierDeCommande(p.ligne);
      if (d) return d;
      pile.push(...(enfants.get(p.pid) ?? []));
    }
    return null;
  };

  const ancetres = (p: Processus): { orpheline: boolean; raison: string | null } => {
    let courant = p;
    for (let i = 0; i < 30; i++) {
      const parent = procs.get(courant.parent);
      if (!parent || (parent.debut !== null && courant.debut !== null && parent.debut > courant.debut)) {
        return { orpheline: true, raison: `parent ${courant.parent} disparu` };
      }
      if (["codex.exe", "claude.exe", "code.exe", "vibe.exe"].includes(parent.nom)) {
        return { orpheline: false, raison: null };
      }
      courant = parent;
    }
    return { orpheline: false, raison: null };
  };

  const suites: SuiteTests[] = [];
  for (const p of procs.values()) {
    if (!estSuite(p)) continue;
    const parent = procs.get(p.parent);
    if (parent && estSuite(parent)) continue;
    const a = ancetres(p);
    suites.push({
      pid: p.pid,
      ligne: resumer(p.ligne, 140),
      dossier: dossierDe(p),
      debut: p.debut,
      orpheline: a.orpheline,
      raison: a.raison,
    });
  }
  suites.sort((x, y) => (x.debut ?? 0) - (y.debut ?? 0));

  const parDossier = new Map<string, number[]>();
  for (const s of suites) {
    if (!s.dossier) continue;
    const l = parDossier.get(s.dossier) ?? [];
    l.push(s.pid);
    parDossier.set(s.dossier, l);
  }
  const doublons = [...parDossier.entries()]
    .filter(([, pids]) => pids.length > 1)
    .map(([dossier, pids]) => ({ dossier, pids }));

  const compte = (nom: string) => [...procs.values()].filter((p) => p.nom === nom).length;
  return {
    charge: typeof brut.charge === "number" ? brut.charge : null,
    total: procs.size,
    nbNode: compte("node.exe"),
    nbCodex: compte("codex.exe"),
    nbClaude: compte("claude.exe"),
    suites,
    doublons,
    erreur: null,
  };
}

/* ------------------------------------------------------------------ */
/* Fichiers du pilote                                                  */
/* ------------------------------------------------------------------ */

export async function lireFichiersPilote(): Promise<{ verrou: number | null; recaps: { nom: string; mtime: number }[] }> {
  const verrou = await mtime(path.join(config.dossierPilote, "agent.lock"));
  const recaps: { nom: string; mtime: number }[] = [];
  const dossier = path.join(config.dossierPilote, "recaps");
  for (const nom of await listerDossier(dossier)) {
    if (!nom.endsWith(".md")) continue;
    const m = await mtime(path.join(dossier, nom));
    if (m !== null) recaps.push({ nom, mtime: m });
  }
  recaps.sort((a, b) => b.mtime - a.mtime);
  return { verrou, recaps: recaps.slice(0, 3) };
}
