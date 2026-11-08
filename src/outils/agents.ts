/**
 * Outil de suivi des agents de code en cours sur la machine.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  lireFichiersPilote,
  lireProcessus,
  lireSessionsClaude,
  lireSessionsCodex,
  lireSessionsVibe,
  type SessionAgent,
} from "../core/agents.js";
import { protege, sansAccents, texte } from "../utils/reponse.js";

function ilYA(ms: number, maintenant: number): string {
  const min = Math.max(0, Math.round((maintenant - ms) / 60_000));
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  return `il y a ${h} h ${String(min % 60).padStart(2, "0")}`;
}

function heure(ms: number | null): string {
  if (ms === null) return "inconnu";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function correspond(s: SessionAgent, filtre: string): boolean {
  const f = sansAccents(filtre);
  return [s.id, s.surnom, s.dossier, s.modele, s.fournisseur, s.branche]
    .filter((v): v is string => typeof v === "string")
    .some((v) => sansAccents(v).includes(f));
}

function rendreSession(s: SessionAgent, enfants: SessionAgent[], detail: number, maintenant: number): string[] {
  const titre = s.surnom ? `${s.fournisseur} (${s.surnom})` : s.fournisseur;
  const l: string[] = [`### ${titre}${s.modele ? `, ${s.modele}` : ""}`];
  l.push(`- Session : \`${s.id}\``);
  l.push(`- Dossier : ${s.dossier ?? "inconnu"}`);
  if (s.branche) l.push(`- Branche (${s.brancheOrigine}) : ${s.branche}`);
  l.push(`- Début : ${heure(s.debut)}, dernière activité : ${ilYA(s.derniereActivite, maintenant)}`);
  l.push(
    s.fournisseur === "Mistral Vibe"
      ? "- Actions : non comptées pour Vibe"
      : `- Actions : ${s.nbActions} dans la fin du journal`
  );
  if (s.actions.length > 0 && detail > 0) {
    l.push("- Dernières actions :");
    for (const a of s.actions.slice(-detail)) l.push(`  - ${heure(a.quand).slice(6)} ${a.resume}`);
  }
  if (s.fichiersModifies.length > 0) {
    const f = s.fichiersModifies.slice(-6);
    const reste = s.fichiersModifies.length - f.length;
    l.push(`- Fichiers modifiés récemment : ${f.join(", ")}${reste > 0 ? ` (+${reste})` : ""}`);
  }
  const actifs = [
    ...s.sousAgents.map((x) => `${x.nom} (${ilYA(x.derniereActivite, maintenant)})`),
    ...enfants.map(
      (e) => `${e.surnom ?? e.id.slice(0, 8)}${e.modele ? `, ${e.modele}` : ""} (${ilYA(e.derniereActivite, maintenant)})`
    ),
  ];
  if (actifs.length > 0) l.push(`- Sous-agents actifs : ${actifs.join(" ; ")}`);
  if (s.note) l.push(`- Note : ${s.note}`);
  return l;
}

export function enregistrerOutilsAgents(server: McpServer): void {
  server.tool(
    "suivi_agents",
    [
      "Où en est chaque agent de code sur cette machine en ce moment : Codex (dont Astra), Claude Code et Mistral Vibe.",
      "Lit en direct, et seulement la fin, les journaux de session (dossiers .codex, .claude, .vibe) pour rendre, par session active : fournisseur, modèle, dossier de travail, branche, début, dernière activité, nombre d'actions, dernières commandes résumées, fichiers modifiés et sous-agents actifs.",
      "Ajoute une section Processus : charge du processeur, nombre de processus node, suites de tests orphelines (chaîne de parents disparue) et suites en doublon dans un même dossier de clone.",
      "Rend aussi la date du verrou agent.lock et des derniers récapitulatifs du dépôt pilote quand ils existent.",
      "Strictement en lecture : ne tue aucun processus, ne change aucune priorité, n'écrit aucun fichier, et ne restitue jamais le contenu brut des journaux ni un message complet.",
    ].join(" "),
    {
      fenetre_minutes: z
        .number()
        .int()
        .min(1)
        .max(10_080)
        .default(120)
        .describe("Ne retenir que les sessions dont le journal a été écrit dans les N dernières minutes. Défaut : 120."),
      session: z
        .string()
        .optional()
        .describe(
          "Filtre facultatif sur un fragment d'identifiant de session, de surnom, de dossier, de modèle, de branche ou de fournisseur (par exemple « astra » ou « bug76 »)."
        ),
      detail: z
        .number()
        .int()
        .min(0)
        .max(30)
        .default(8)
        .describe("Nombre d'actions récentes à lister par session. Défaut : 8."),
    },
    protege("suivi_agents", async ({ fenetre_minutes, session, detail }) => {
      const maintenant = Date.now();
      const limite = maintenant - fenetre_minutes * 60_000;

      const [codex, claude, vibe, processus, pilote] = await Promise.all([
        lireSessionsCodex(limite),
        lireSessionsClaude(limite),
        lireSessionsVibe(limite),
        lireProcessus(),
        lireFichiersPilote(),
      ]);

      const toutes = [...codex, ...claude, ...vibe.sessions].filter((s) => !session || correspond(s, session));
      const ids = new Set(toutes.map((s) => s.id));

      const enfantsDe = new Map<string, SessionAgent[]>();
      const racines: SessionAgent[] = [];
      for (const s of toutes) {
        if (s.parent && ids.has(s.parent)) {
          const l = enfantsDe.get(s.parent) ?? [];
          l.push(s);
          enfantsDe.set(s.parent, l);
        } else {
          racines.push(s);
        }
      }
      racines.sort((a, b) => b.derniereActivite - a.derniereActivite);

      const sortie: string[] = [];
      sortie.push(`# Suivi des agents (fenêtre de ${fenetre_minutes} min, relevé à ${heure(maintenant).slice(6)})`);
      sortie.push("");
      sortie.push(
        `Sessions affichées : ${racines.length} (journaux récents : Codex ${codex.length}, Claude Code ${claude.length}, Mistral Vibe ${vibe.sessions.length}).`
      );
      if (!vibe.present) sortie.push("Aucun journal Mistral Vibe trouvé sur cette machine.");
      sortie.push("");

      if (racines.length === 0) {
        sortie.push("Aucune session dans cette fenêtre. Élargir `fenetre_minutes` pour remonter plus loin.");
        sortie.push("");
      }
      for (const s of racines) {
        sortie.push(...rendreSession(s, enfantsDe.get(s.id) ?? [], detail, maintenant));
        sortie.push("");
      }

      sortie.push("## Dépôt pilote");
      sortie.push(
        pilote.verrou === null
          ? "- agent.lock : absent (aucun agent ne se déclare au travail)"
          : `- agent.lock : présent, modifié ${ilYA(pilote.verrou, maintenant)}`
      );
      if (pilote.recaps.length > 0) {
        sortie.push(
          `- Derniers récapitulatifs : ${pilote.recaps.map((r) => `${r.nom} (${ilYA(r.mtime, maintenant)})`).join(", ")}`
        );
      }
      sortie.push("");

      sortie.push("## Processus");
      if (processus.erreur) {
        sortie.push(processus.erreur);
      } else {
        sortie.push(
          `- Charge processeur : ${processus.charge === null ? "inconnue" : `${processus.charge} %`}, ${processus.nbNode} processus node, ${processus.nbCodex} codex, ${processus.nbClaude} claude.`
        );
        const nbOrphelines = processus.suites.filter((s) => s.orpheline).length;
        sortie.push(`- Suites de tests : ${processus.suites.length}, dont ${nbOrphelines} orpheline(s).`);
        for (const s of processus.suites) {
          const depuis = s.debut ? ilYA(s.debut, maintenant).replace("il y a ", "") : "?";
          sortie.push(
            `  - PID ${s.pid}${s.orpheline ? " ORPHELINE" : ""}, ${s.dossier ?? "dossier inconnu"}, depuis ${depuis} : ${s.ligne}`
          );
        }
        if (processus.doublons.length === 0) {
          sortie.push("- Doublons : aucun.");
        } else {
          sortie.push("- Doublons (plusieurs suites dans le même clone) :");
          for (const d of processus.doublons) sortie.push(`  - ${d.dossier} : PID ${d.pids.join(", ")}`);
        }
        sortie.push(
          "- Une suite est dite orpheline quand un de ses ancêtres n'existe plus : c'est une indication, pas une preuve, et cet outil n'arrête rien."
        );
      }

      return texte(sortie.join("\n"));
    })
  );
}
