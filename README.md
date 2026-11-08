# mcp-pilotage

> **In English:** a read-only MCP server that maps every git repository on your machine, so that an AI agent opened in any one of them can discover all the others on its own: inventory, tech stack, live git status, context files (`CLAUDE.md`, `AGENTS.md`, `README.md`) and cross-repository search. Node / TypeScript, official MCP SDK, stdio transport. Tool descriptions and answers are in French.

Serveur MCP qui cartographie **tous les projets présents sur la machine**, pour que n'importe quel agent branché dans n'importe quel dépôt puisse découvrir l'écosystème tout seul, sans explication préalable.

Node / TypeScript, SDK MCP officiel, transport stdio, **strictement en lecture seule**.

## Ce qu'il résout

Quand une quinzaine de dépôts vivent côte à côte, un agent qui démarre dans l'un d'eux ne sait rien des autres. Ce serveur lui donne, en un appel, la liste des projets, leur rôle, leur pile technique, leur état git en direct, et de quoi fouiller tous les projets d'un coup.

L'inventaire vient d'un **scan du disque à chaque appel**, pas d'un fichier de configuration. Il ne peut donc pas devenir faux quand un projet est créé, renommé ou supprimé.

## Les outils exposés

| Outil | À quoi il sert |
|---|---|
| `apercu_ecosysteme` | Briefing de démarrage à froid. Synthèse markdown de tout l'écosystème, groupée par famille, avec rôle, pile, branche et fraîcheur git de chaque projet. C'est l'appel à faire en premier. |
| `lister_projets` | Inventaire brut et filtrable : nom, chemin absolu, versionné ou non, pile, rôle résumé, documents de contexte disponibles. Filtres par terme libre et par famille. |
| `decrire_projet` | Fiche complète d'un seul projet : dépôt distant, dépendances marquantes, état git détaillé, derniers commits, branches, documents de contexte, arborescence de surface. |
| `lire_cerveau` | Contenu des fichiers de contexte d'un projet : `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `README.md`, `ARCHITECTURE.md`, ou n'importe quel markdown de ses dossiers `docs`, `notes`, `références`, `.claude`. Troncature réglable. |
| `etat_git` | État git lu au moment de l'appel. Sans argument, tableau de bord de tous les dépôts trié du plus récemment touché au plus ancien. Avec un projet, détail et historique. |
| `chercher_partout` | Recherche de texte ou d'expression régulière dans le contenu de tous les dépôts à la fois, résultats groupés par projet avec fichier et numéro de ligne. |
| `trouver_fichiers` | Recherche de fichiers par nom ou par motif glob à travers tous les dépôts. Complémentaire du précédent : localiser plutôt que fouiller. |
| `diagnostic_pilotage` | Configuration effective du serveur : racines scannées, exclusions, moteur de recherche détecté, durée du scan complet. À appeler quand un résultat surprend. |
| `usage_ia_claude` | Tokens consommés et factures de l'API Claude, lus depuis un dossier local (voir plus bas). Totaux, détail mois par mois, classement par projet et par modèle. Utile pour sourcer un article avec des chiffres réels. |
| `suivi_agents` | Où en est chaque agent de code actif (Codex dont Astra, Claude Code, Mistral Vibe) : modèle, dossier, branche, dernière activité, dernières commandes résumées, fichiers modifiés, sous-agents. Section Processus : charge, suites de tests orphelines ou en doublon par clone. Paramètres `fenetre_minutes`, `session`, `detail`. |

## Garanties de sécurité

Le serveur est **en lecture seule par construction** :

- aucun outil n'écrit, ne crée, ne supprime ni ne renomme de fichier ;
- aucune commande git modifiante n'est utilisée, ni `add`, ni `commit`, ni `push`, ni `checkout`, ni `fetch`, ni `reset`. Seuls `rev-parse`, `log`, `status`, `branch`, `rev-list` et `config --get` sont appelés ;
- aucun accès réseau ;
- `suivi_agents` ne lit que la fin des journaux de session (jamais le fichier entier, jamais un message complet restitué) et interroge la liste des processus par `Get-CimInstance Win32_Process` : il ne tue aucun processus, ne change aucune priorité, n'écrit rien ;
- les lectures restent confinées aux racines configurées, et un garde-fou refuse tout chemin qui sortirait du projet ciblé ;
- les fichiers de secrets (`.env`, `.env.*`, `*.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`) ne sont jamais fouillés par `chercher_partout`, y compris dans les dossiers hors git et sans ripgrep. Avec ripgrep, les `.gitignore` sont en plus respectés.

## Installation

```powershell
git clone https://github.com/fmenguy/mcp-pilotage.git
cd mcp-pilotage
npm install
npm run build
```

Le point d'entrée compilé est `dist/index.js`. Le plus simple est de cloner ce dépôt **à côté des autres** (par exemple dans `D:\git`) : sans réglage, le serveur scanne le dossier qui le contient.

## Brancher le serveur

Dans Claude Code, pour l'avoir dans tous les projets d'un coup :

```powershell
claude mcp add pilotage --scope user -- node D:/git/mcp-pilotage/dist/index.js
```

Ou dépôt par dépôt, avec `--scope project`, ce qui revient à créer un `.mcp.json` à la racine du dépôt :

```json
{
  "mcpServers": {
    "pilotage": {
      "command": "node",
      "args": ["D:/git/mcp-pilotage/dist/index.js"]
    }
  }
}
```

Adapter le chemin à l'endroit où le dépôt a été cloné. N'importe quel client MCP en stdio fonctionne de la même façon.

## Configuration facultative

Tout est pilotable par variables d'environnement, dans le bloc `env` du `.mcp.json` ou avec `-e` sur `claude mcp add`. Aucune n'est obligatoire.

| Variable | Défaut | Rôle |
|---|---|---|
| `PILOTAGE_RACINES` | le dossier qui contient ce dépôt | Dossiers parents à scanner, séparés par des points-virgules. |
| `PILOTAGE_PROFONDEUR` | `2` | Profondeur de descente pour trouver un `.git`. La descente s'arrête dès qu'un dépôt est trouvé. |
| `PILOTAGE_EXCLUSIONS` | (vide) | Noms de dossiers à ignorer en plus de la liste par défaut. |
| `PILOTAGE_CACHE_MS` | `60000` | Durée de vie du cache de scan. Le paramètre `rafraichir` des outils le contourne. |
| `PILOTAGE_RIPGREP` | (auto) | Chemin forcé vers `rg`. Sinon détecté dans le PATH, puis dans l'installation de VS Code. |
| `PILOTAGE_TIMEOUT_GIT_MS` | `15000` | Délai maximal d'une commande git. |
| `PILOTAGE_TAILLE_MAX_FICHIER` | `1048576` | Taille maximale d'un fichier lu ou fouillé, en octets. |
| `PILOTAGE_DOSSIER_USAGE` | `usage/` dans ce dépôt | Dossier lu par `usage_ia_claude` (voir ci-dessous). |
| `PILOTAGE_DOSSIER_CODEX` | `~/.codex/sessions` | Journaux de session Codex lus par `suivi_agents`. |
| `PILOTAGE_DOSSIER_CLAUDE` | `~/.claude/projects` | Journaux de session Claude Code lus par `suivi_agents`. |
| `PILOTAGE_DOSSIER_VIBE` | `~/.vibe/logs/session/unified` | Sessions Mistral Vibe lues par `suivi_agents`. |
| `PILOTAGE_DOSSIER_PILOTE` | `strates-fmenguy/.claude` dans la première racine | Dossier où `suivi_agents` regarde `agent.lock` et `recaps/`. |

Exemple avec plusieurs racines :

```powershell
claude mcp add pilotage --scope user -e "PILOTAGE_RACINES=D:/git;E:/autres-projets" -- node D:/git/mcp-pilotage/dist/index.js
```

## Le dossier d'usage de l'API Claude

`usage_ia_claude` lit deux sortes de fichiers, déposés à la main, et ne les modifie jamais :

- un export CSV des tokens par mois, nommé `claude_api_tokens_AAAA_MM.csv` (export de la console Claude) ;
- un fichier `factures.csv`, tenu à la main, car les factures mélangent abonnement et usage mesuré et ne se déduisent pas des tokens.

Le dossier `usage/` de ce dépôt est ignoré par git : on peut y déposer ses fichiers sans risque de les publier, ou pointer ailleurs avec `PILOTAGE_DOSSIER_USAGE`. Sans fichier, l'outil répond qu'il n'a trouvé aucun export et indique le dossier attendu.

## Conventions d'écriture

Deux registres cohabitent volontairement dans le code et dans les réponses :

- **Les identifiants restent en ASCII** : noms d'outils (`apercu_ecosysteme`), noms de paramètres (`rafraichir`, `seulement_modifies`), clés JSON des résultats (`depots_git`, `resultat_tronque`). C'est une convention de sérialisation stable, sur laquelle un appelant peut s'appuyer sans se soucier des accents.
- **Tout ce qui se lit est écrit en français correct**, entièrement accentué : descriptions des outils, descriptions des paramètres, titres et en-têtes du markdown généré, messages d'état et d'erreur, valeurs de repli.

Les filtres textuels (`filtre`, `famille`) comparent sans tenir compte des accents ni de la casse : `Ecriture et romans` et `Écriture et romans` donnent le même résultat, mais la valeur renvoyée reste toujours la forme correcte.

Le contenu extrait des fichiers des projets (rôles déduits d'un `CLAUDE.md` ou d'un `README`) est restitué **tel quel**, sans retouche.

## Performances observées

Mesures réelles sur une machine Windows avec 20 projets (17 dépôts git et 3 dossiers hors git) :

| Appel | Durée |
|---|---|
| Scan complet du disque, cache vide | 100 à 260 ms |
| `lister_projets` avec cache chaud | 1 ms |
| `apercu_ecosysteme` avec état git de tous les dépôts | 1,4 s |
| `etat_git` sur tous les dépôts | 1,4 s |
| `decrire_projet` sur un projet | 150 ms |
| `chercher_partout` avec ripgrep | 50 à 150 ms |
| `chercher_partout` sans ripgrep (repli Node) | 1,1 s |
| `trouver_fichiers` sur tous les dépôts | 160 ms |

Les dossiers `node_modules`, `.git`, `dist`, `build`, `.astro`, `venv`, `__pycache__` et une vingtaine d'autres ne sont jamais parcourus.

## Développement

```powershell
npm run dev                     # exécution directe des sources via tsx
npm run build                   # compilation TypeScript vers dist/
npm test                        # client MCP stdio qui appelle chaque outil et chronomètre
node tests/suivi-agents.mjs [minutes] [filtre] [detail]   # appelle seulement suivi_agents sur les vrais journaux
node tests/verif-accents.mjs    # contrôle de l'accentuation et de l'encodage UTF-8
```

`tests/client-test.mjs` démarre le serveur compilé, liste les outils et exerce chaque outil avec des paramètres réels sur ce dépôt lui-même, y compris un cas d'erreur (projet inexistant). C'est le moyen le plus rapide de vérifier une modification.

`tests/verif-accents.mjs` affiche les descriptions complètes telles qu'un modèle les reçoit, compte les caractères accentués, contrôle les points de code du markdown généré et vérifie que les fichiers source sont en UTF-8 sans BOM.

## Organisation du code

```
src/
  index.ts            point d'entrée, transport stdio, enregistrement des outils
  config.ts           configuration, variables d'environnement, motifs de secrets
  core/
    fichiers.ts       parcours et lectures tolérantes aux erreurs, glob maison
    depots.ts         scan des racines, cache, résolution d'un projet par nom
    stack.ts          détection de la pile technique et de la famille
    cerveau.ts        repérage et lecture des documents de contexte
    git.ts            état git en lecture seule
    recherche.ts      recherche transverse, ripgrep avec repli Node
    usage.ts          lecture et agrégation des exports de tokens et des factures
    agents.ts         journaux Codex, Claude Code et Vibe (fin de fichier seulement), processus vivants
  outils/             définition des outils MCP exposés
  utils/reponse.ts    formatage des réponses et garde-fou anti-plantage
```

## Licence

MIT, voir [LICENSE](LICENSE).
