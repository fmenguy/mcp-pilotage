/**
 * Outil de lecture du cerveau d'un projet : ses fichiers de contexte.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inventorier, nomsDisponibles, resoudreDepot } from "../core/depots.js";
import { lireDocument, recenserCerveau, type DocumentLu } from "../core/cerveau.js";
import { cheminSurDansDepot } from "../core/fichiers.js";
import { erreur, json, protege } from "../utils/reponse.js";

export function enregistrerOutilsCerveau(server: McpServer): void {
  server.tool(
    "lire_cerveau",
    [
      "Lit le contenu des documents de contexte d'un projet : son CLAUDE.md, son .claude/CLAUDE.md, son AGENTS.md, son README, son ARCHITECTURE.md, et sur demande n'importe quel autre markdown de ses dossiers docs, notes, références ou .claude.",
      "C'est ainsi que tu apprends comment François pense un projet donné : ses conventions, sa pile, ses règles d'écriture, ses pièges connus, sans qu'il ait à te les redire.",
      "Par défaut, seuls les documents prioritaires sont retournés, tronqués pour ne pas saturer ton contexte. Pour un document précis, passe son chemin relatif dans « fichier ». Pour connaître les documents disponibles sans les lire, mets « lister_seulement » à true.",
      "Lecture seule : cet outil n'écrit jamais dans les dépôts.",
    ].join(" "),
    {
      projet: z
        .string()
        .describe(
          "Nom du dossier du projet (par exemple « mon-site ») ou son chemin absolu. Utilise lister_projets si tu ne connais pas les noms."
        ),
      fichier: z
        .string()
        .optional()
        .describe(
          "Chemin relatif d'un document précis à lire, par exemple « CLAUDE.md », « docs/architecture.md » ou « références/personnages.md ». Si absent, les documents prioritaires du projet sont lus."
        ),
      lister_seulement: z
        .boolean()
        .default(false)
        .describe(
          "Ne renvoyer que la liste des documents de contexte disponibles avec leur taille, sans leur contenu. Utile pour choisir quoi lire avant de consommer du contexte."
        ),
      max_caracteres: z
        .number()
        .int()
        .min(500)
        .max(200000)
        .default(15000)
        .describe(
          "Budget de caractères par document. Au delà, le document est tronqué et signalé comme tel. Augmente cette valeur si un document important a été coupé."
        ),
    },
    protege("lire_cerveau", async ({ projet, fichier, lister_seulement, max_caracteres }) => {
      const depots = await inventorier();
      const depot = await resoudreDepot(projet, depots);
      if (!depot) {
        return erreur(
          `Aucun projet ne correspond à « ${projet} ».`,
          `Projets disponibles : ${nomsDisponibles(depots).join(", ")}.`
        );
      }

      const documents = await recenserCerveau(depot.chemin);

      if (lister_seulement) {
        return json({
          projet: depot.nom,
          chemin: depot.chemin,
          documents: documents.map((d) => ({
            chemin: d.chemin,
            octets: d.taille,
            prioritaire: d.prioritaire,
          })),
          indication:
            "Rappelle lire_cerveau avec le paramètre « fichier » pour lire l'un de ces documents.",
        });
      }

      // --- Lecture d'un document précis ---
      if (fichier) {
        const absolu = cheminSurDansDepot(depot.chemin, fichier.replace(/\//g, "\\"));
        if (!absolu) {
          return erreur(
            `Le chemin « ${fichier} » sort du projet ${depot.nom}, lecture refusée.`,
            "Donne un chemin relatif à la racine du projet."
          );
        }
        const lu = await lireDocument(absolu, fichier, max_caracteres);
        if (!lu) {
          return erreur(
            `Le fichier « ${fichier} » est introuvable ou illisible dans ${depot.nom}.`,
            `Documents connus : ${documents.map((d) => d.chemin).join(", ") || "aucun"}.`
          );
        }
        return json({ projet: depot.nom, chemin: depot.chemin, documents: [lu] });
      }

      // --- Lecture des documents prioritaires ---
      const prioritaires = documents.filter((d) => d.prioritaire);
      if (prioritaires.length === 0) {
        return json({
          projet: depot.nom,
          chemin: depot.chemin,
          documents: [],
          avertissement:
            "Ce projet n'a ni CLAUDE.md ni README à sa racine, son rôle n'est donc pas documenté.",
          autres_documents_disponibles: documents.map((d) => d.chemin),
        });
      }

      const lus: DocumentLu[] = [];
      const echecs: string[] = [];
      for (const d of prioritaires) {
        const lu = await lireDocument(d.absolu, d.chemin, max_caracteres);
        if (lu) lus.push(lu);
        else echecs.push(d.chemin);
      }

      return json({
        projet: depot.nom,
        chemin: depot.chemin,
        documents: lus,
        documents_illisibles: echecs.length > 0 ? echecs : undefined,
        autres_documents_disponibles: documents
          .filter((d) => !d.prioritaire)
          .map((d) => d.chemin),
      });
    })
  );
}
