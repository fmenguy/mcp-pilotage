/**
 * Helpers de formatage des réponses MCP.
 *
 * Les sorties sont pensées pour être lues par un modèle : compactes,
 * sans décoration inutile, et toujours explicites en cas d'échec.
 *
 * Convention d'écriture du serveur : les identifiants (clés JSON, noms de
 * paramètres, noms d'outils) restent en ASCII, les phrases destinées à être
 * lues sont écrites en français correctement accentué.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Forme de réponse attendue par le SDK MCP pour un appel d'outil. */
export type ReponseMcp = CallToolResult;

/** Réponse texte brute (markdown). */
export function texte(contenu: string): ReponseMcp {
  return { content: [{ type: "text" as const, text: contenu }] };
}

/** Réponse JSON, indentée pour rester lisible dans le contexte du modèle. */
export function json(valeur: unknown): ReponseMcp {
  return texte(JSON.stringify(valeur, null, 2));
}

/** Réponse d'erreur exploitable : ce qui a échoué et quoi faire ensuite. */
export function erreur(message: string, indication?: string): ReponseMcp {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          indication ? { erreur: message, indication } : { erreur: message },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

/**
 * Encadre un handler d'outil pour qu'aucune exception ne remonte au transport.
 * Une erreur interne devient une réponse d'erreur lisible.
 */
export function protege<A>(
  nomOutil: string,
  handler: (args: A) => Promise<ReponseMcp>
): (args: A) => Promise<ReponseMcp> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err) {
      return erreur(
        `L'outil ${nomOutil} a échoué : ${err instanceof Error ? err.message : String(err)}`,
        "Réessaie avec des paramètres plus restrictifs, ou appelle lister_projets pour vérifier les noms de projets."
      );
    }
  };
}

/** Formate une durée en jours de façon lisible. */
export function formaterAnciennete(jours: number | null): string {
  if (jours === null) return "inconnu";
  if (jours === 0) return "aujourd'hui";
  if (jours === 1) return "hier";
  if (jours < 30) return `il y a ${jours} jours`;
  if (jours < 365) return `il y a ${Math.round(jours / 30)} mois`;
  const annees = (jours / 365).toFixed(1);
  return `il y a ${annees} an(s)`;
}

/**
 * Retire les signes diacritiques d'un texte, uniquement pour comparer.
 * Permet d'accepter « Ecriture et romans » aussi bien que la forme correcte
 * « Écriture et romans » dans les filtres, sans jamais dégrader l'affichage.
 */
export function sansAccents(valeur: string): string {
  return valeur.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}
