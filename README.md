# mcp-pilotage

🇫🇷 Français · 🇬🇧 [English](#english)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-8B5CF6)](https://modelcontextprotocol.io)

Serveur MCP en lecture seule qui cartographie **tous les dépôts git présents sur la machine**. Un agent IA branché dans n'importe lequel d'entre eux découvre seul l'écosystème complet : inventaire, pile technique, état git en direct, fichiers de contexte et recherche transverse, sans explication préalable.

Node / TypeScript, SDK MCP officiel, transport stdio, **strictement en lecture seule**. Les descriptions des outils et les réponses sont rédigées en français.

## Ce qu'il résout

Quand une quinzaine de dépôts vivent côte à côte, un agent qui démarre dans l'un d'eux ne sait rien des autres. Ce serveur lui donne, en un appel, la liste des projets, leur rôle, leur pile technique, leur état git en direct, et de quoi fouiller tous les projets d'un coup.

L'inventaire vient d'un **scan du disque à chaque appel** (avec un cache court), pas d'un fichier de configuration. Il ne peut donc pas devenir faux quand un projet est créé, renommé ou supprimé.

## Les outils exposés

| Outil | À quoi il sert |
|---|---|
| `apercu_ecosysteme` | Briefing de démarrage à froid. Synthèse markdown de tout l'écosystème, groupée par famille, avec rôle, pile, branche et fraîcheur git de chaque projet. C'est l'appel à faire en premier. |
| `lister_projets` | Inventaire brut et filtrable : nom, chemin absolu, versionné ou non, pile, rôle résumé, documents de contexte disponibles. Filtres par terme libre et par famille. |
| `decrire_projet` | Fiche complète d'un seul projet : dépôt distant, dépendances marquantes, état git détaillé, derniers commits, branches, documents de contexte, arborescence de surface. |
| `lire_cerveau` | Contenu des fichiers de contexte d'un projet : `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `.claude/AGENTS.md`, `README.md`, `ARCHITECTURE.md`, `CONTEXTE.md`, `ETAT-DES-LIEUX.md`, ou n'importe quel markdown de ses dossiers `docs`, `doc`, `notes`, `références`, `references`, `.claude`. Troncature réglable, mode liste sans contenu. |
| `etat_git` | État git lu au moment de l'appel : branche, dernier commit, fichiers non commités, avance et retard sur la branche distante suivie, niveau d'activité. Sans argument, tableau de bord de tous les dépôts trié du plus récemment touché au plus ancien. Avec un projet, détail et historique. |
| `chercher_partout` | Recherche de texte ou d'expression régulière dans le contenu de tous les dépôts à la fois, résultats groupés par projet avec fichier et numéro de ligne. |
| `trouver_fichiers` | Recherche de fichiers par nom ou par motif glob à travers tous les dépôts. Complémentaire du précédent : localiser plutôt que fouiller. |
| `diagnostic_pilotage` | Configuration effective du serveur : racines scannées, exclusions, moteur de recherche détecté, durée du scan complet. À appeler quand un résultat surprend. |
| `usage_ia_claude` | Tokens consommés et factures de l'API Claude, lus depuis un dossier local (voir plus bas). Totaux, détail mois par mois, classement par projet et par modèle. Utile pour sourcer un article avec des chiffres réels. |
| `suivi_agents` | Où en est chaque agent de code actif (Codex, Claude Code, Mistral Vibe) : modèle, dossier, branche, dernière activité, dernières commandes résumées, fichiers modifiés, sous-agents. Section Processus : charge du processeur, suites de tests orphelines ou en doublon par clone. Paramètres `fenetre_minutes`, `session`, `detail`. |

## Garanties de sécurité

Le serveur est **en lecture seule par construction** :

- aucun outil n'écrit, ne crée, ne supprime ni ne renomme de fichier ;
- aucune commande git modifiante n'est utilisée, ni `add`, ni `commit`, ni `push`, ni `checkout`, ni `fetch`, ni `reset`. Seuls `rev-parse`, `log`, `status`, `branch`, `rev-list` et `config --get` sont appelés ;
- aucun accès réseau ;
- `suivi_agents` ne lit que la fin des journaux de session (jamais le fichier entier, jamais un message complet restitué) et interroge la liste des processus et la charge du processeur par `Get-CimInstance` (`Win32_Process`, `Win32_Processor`) : il ne tue aucun processus, ne change aucune priorité, n'écrit rien ;
- les lectures restent confinées aux racines configurées, et un garde-fou refuse tout chemin qui sortirait du projet ciblé ;
- les fichiers de secrets (`.env`, `.env.*`, `*.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`) ne sont jamais fouillés par `chercher_partout`, y compris dans les dossiers hors git et sans ripgrep. Avec ripgrep, les `.gitignore` sont en plus respectés.

## Prérequis

- Node.js 18 ou plus
- git dans le `PATH`
- [ripgrep](https://github.com/BurntSushi/ripgrep) facultatif : détecté dans le `PATH`, puis dans l'installation de VS Code. Sans lui, la recherche bascule sur un repli en Node, plus lent.
- Windows pour la section Processus de `suivi_agents` (elle passe par PowerShell). Sur les autres systèmes, cette section renvoie un message d'indisponibilité, le reste fonctionne.

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
| `PILOTAGE_EXCLUSIONS` | (vide) | Noms de dossiers à ignorer en plus de la liste par défaut, séparés par des points-virgules. |
| `PILOTAGE_CACHE_MS` | `60000` | Durée de vie du cache de scan. Le paramètre `rafraichir` des outils le contourne. |
| `PILOTAGE_RIPGREP` | (auto) | Chemin forcé vers `rg`. Sinon détecté dans le `PATH`, puis dans l'installation de VS Code. |
| `PILOTAGE_TIMEOUT_GIT_MS` | `15000` | Délai maximal d'une commande git. |
| `PILOTAGE_TAILLE_MAX_FICHIER` | `1048576` | Taille maximale d'un fichier lu ou fouillé, en octets. |
| `PILOTAGE_DOSSIER_USAGE` | `usage/` dans ce dépôt | Dossier lu par `usage_ia_claude` (voir ci-dessous). |
| `PILOTAGE_DOSSIER_CODEX` | `~/.codex/sessions` | Journaux de session Codex lus par `suivi_agents`. |
| `PILOTAGE_DOSSIER_CLAUDE` | `~/.claude/projects` | Journaux de session Claude Code lus par `suivi_agents`. |
| `PILOTAGE_DOSSIER_VIBE` | `~/.vibe/logs/session/unified` | Sessions Mistral Vibe lues par `suivi_agents`. |
| `PILOTAGE_DOSSIER_PILOTE` | `strates-fmenguy/.claude` dans la première racine | Dossier où `suivi_agents` regarde `agent.lock` et `recaps/`. Sans ce dossier, `agent.lock` est simplement signalé absent. |

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

Mesures relevées sur une machine Windows avec 20 projets (17 dépôts git et 3 dossiers hors git) :

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
npm test                        # client MCP stdio qui appelle chaque outil et chronomètre (nécessite npm run build)
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
tests/                client de test MCP, essai de suivi_agents, contrôle des accents
```

## Licence

MIT, voir [LICENSE](LICENSE).

Auteur : François Menguy, [fmenguy.fr](https://fmenguy.fr).

---

<a id="english"></a>

# mcp-pilotage (English)

🇬🇧 English · 🇫🇷 [Français](#mcp-pilotage)

A read-only MCP server that maps **every git repository on your machine**. An AI agent opened in any one of them can discover the whole ecosystem on its own: inventory, tech stack, live git status, context files and cross-repository search, with no briefing needed.

Node / TypeScript, official MCP SDK, stdio transport, **strictly read only**. Tool descriptions and answers are written in French; tool and parameter names are ASCII identifiers.

## The problem it solves

With fifteen or so repositories side by side, an agent that starts in one of them knows nothing about the others. This server gives it, in a single call, the list of projects, their purpose, their tech stack, their live git status, and a way to search all of them at once.

The inventory comes from **a disk scan on every call** (with a short cache), not from a configuration file. It cannot go stale when a project is created, renamed or deleted.

## Tools

| Tool | What it does |
|---|---|
| `apercu_ecosysteme` | Cold-start briefing. A markdown summary of the whole ecosystem, grouped by family, with each project's purpose, stack, branch and git freshness. This is the first call to make. |
| `lister_projets` | Raw, filterable inventory: name, absolute path, versioned or not, stack, short purpose, available context documents. Filters by free text and by family. |
| `decrire_projet` | Full profile of one project: remote, notable dependencies, detailed git status, recent commits, branches, context documents, top-level tree. |
| `lire_cerveau` | Contents of a project's context files: `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `.claude/AGENTS.md`, `README.md`, `ARCHITECTURE.md`, `CONTEXTE.md`, `ETAT-DES-LIEUX.md`, or any markdown file in its `docs`, `doc`, `notes`, `références`, `references` or `.claude` folders. Adjustable truncation, list-only mode. |
| `etat_git` | Git status read at call time: branch, last commit, uncommitted files, ahead/behind counts against the tracked remote branch, activity level. With no argument, a dashboard of every repository sorted from most to least recently touched. With a project, details and history. |
| `chercher_partout` | Text or regular expression search across the contents of every repository at once, results grouped by project with file and line number. |
| `trouver_fichiers` | File search by name or glob pattern across every repository. The counterpart of the previous tool: locate rather than grep. |
| `diagnostic_pilotage` | The server's effective configuration: scanned roots, exclusions, detected search engine, full scan duration. Call it when a result looks wrong. |
| `usage_ia_claude` | Tokens consumed and invoices for the Claude API, read from a local folder (see below). Totals, month-by-month breakdown, ranking by project and by model. Handy for backing a blog post with real figures. |
| `suivi_agents` | Status of each active coding agent (Codex, Claude Code, Mistral Vibe): model, folder, branch, last activity, summarized recent commands, modified files, subagents. A Processes section adds CPU load and flags orphaned or duplicate test runs per clone. Parameters `fenetre_minutes`, `session`, `detail`. |

## Safety guarantees

The server is **read only by design**:

- no tool writes, creates, deletes or renames a file;
- no git command that changes anything is used: no `add`, `commit`, `push`, `checkout`, `fetch` or `reset`. Only `rev-parse`, `log`, `status`, `branch`, `rev-list` and `config --get` are called;
- no network access;
- `suivi_agents` only reads the tail of session logs (never the whole file, never a full message returned) and queries the process list and CPU load through `Get-CimInstance` (`Win32_Process`, `Win32_Processor`): it kills no process, changes no priority, writes nothing;
- reads stay inside the configured roots, and a guard rejects any path that would escape the target project;
- secret files (`.env`, `.env.*`, `*.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`) are never searched by `chercher_partout`, including in non-git folders and without ripgrep. With ripgrep, `.gitignore` files are honored as well.

## Prerequisites

- Node.js 18 or later
- git on the `PATH`
- [ripgrep](https://github.com/BurntSushi/ripgrep), optional: looked up on the `PATH`, then in the VS Code installation. Without it, search falls back to a slower Node implementation.
- Windows for the Processes section of `suivi_agents` (it goes through PowerShell). On other systems that section reports it is unavailable; everything else works.

## Installation

```powershell
git clone https://github.com/fmenguy/mcp-pilotage.git
cd mcp-pilotage
npm install
npm run build
```

The compiled entry point is `dist/index.js`. The simplest setup is to clone this repository **next to your other ones** (for example in `D:\git`): with no configuration, the server scans the folder that contains it.

## Hooking it up

In Claude Code, to get it in every project at once:

```powershell
claude mcp add pilotage --scope user -- node D:/git/mcp-pilotage/dist/index.js
```

Or per repository with `--scope project`, which amounts to a `.mcp.json` at the repository root:

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

Adjust the path to wherever you cloned the repository. Any stdio MCP client works the same way.

## Optional configuration

Everything is driven by environment variables, in the `env` block of `.mcp.json` or with `-e` on `claude mcp add`. None is required.

| Variable | Default | Purpose |
|---|---|---|
| `PILOTAGE_RACINES` | the folder that contains this repository | Parent folders to scan, separated by semicolons. |
| `PILOTAGE_PROFONDEUR` | `2` | How deep to look for a `.git` folder. Descent stops as soon as a repository is found. |
| `PILOTAGE_EXCLUSIONS` | (empty) | Extra folder names to skip on top of the default list, separated by semicolons. |
| `PILOTAGE_CACHE_MS` | `60000` | Scan cache lifetime. The tools' `rafraichir` parameter bypasses it. |
| `PILOTAGE_RIPGREP` | (auto) | Forced path to `rg`. Otherwise looked up on the `PATH`, then in the VS Code installation. |
| `PILOTAGE_TIMEOUT_GIT_MS` | `15000` | Maximum duration of a git command. |
| `PILOTAGE_TAILLE_MAX_FICHIER` | `1048576` | Maximum size of a file read or searched, in bytes. |
| `PILOTAGE_DOSSIER_USAGE` | `usage/` in this repository | Folder read by `usage_ia_claude` (see below). |
| `PILOTAGE_DOSSIER_CODEX` | `~/.codex/sessions` | Codex session logs read by `suivi_agents`. |
| `PILOTAGE_DOSSIER_CLAUDE` | `~/.claude/projects` | Claude Code session logs read by `suivi_agents`. |
| `PILOTAGE_DOSSIER_VIBE` | `~/.vibe/logs/session/unified` | Mistral Vibe sessions read by `suivi_agents`. |
| `PILOTAGE_DOSSIER_PILOTE` | `strates-fmenguy/.claude` under the first root | Folder where `suivi_agents` looks for `agent.lock` and `recaps/`. If it does not exist, `agent.lock` is simply reported as absent. |

Example with several roots:

```powershell
claude mcp add pilotage --scope user -e "PILOTAGE_RACINES=D:/git;E:/other-projects" -- node D:/git/mcp-pilotage/dist/index.js
```

## The Claude API usage folder

`usage_ia_claude` reads two kinds of files, dropped in by hand, and never modifies them:

- a monthly CSV export of tokens, named `claude_api_tokens_YYYY_MM.csv` (exported from the Claude console);
- a `factures.csv` file (invoices), kept by hand, because invoices mix subscription and metered usage and cannot be derived from token counts.

This repository's `usage/` folder is ignored by git, so you can drop your files there without any risk of publishing them, or point elsewhere with `PILOTAGE_DOSSIER_USAGE`. With no files, the tool replies that it found no export and gives the expected folder.

## Writing conventions

Two registers coexist on purpose in the code and in the answers:

- **Identifiers stay ASCII**: tool names (`apercu_ecosysteme`), parameter names (`rafraichir`, `seulement_modifies`), JSON result keys (`depots_git`, `resultat_tronque`). It is a stable serialization convention callers can rely on without worrying about accents.
- **Everything meant to be read is proper, fully accented French**: tool descriptions, parameter descriptions, titles and headers of the generated markdown, status and error messages, fallback values.

Text filters (`filtre`, `famille`) ignore accents and case: `Ecriture et romans` and `Écriture et romans` give the same result, but the returned value always keeps the correct spelling.

Content extracted from project files (purposes taken from a `CLAUDE.md` or a `README`) is returned **as is**, untouched.

## Observed performance

Measured on a Windows machine with 20 projects (17 git repositories and 3 non-git folders):

| Call | Duration |
|---|---|
| Full disk scan, cold cache | 100 to 260 ms |
| `lister_projets` with warm cache | 1 ms |
| `apercu_ecosysteme` with git status of every repository | 1.4 s |
| `etat_git` on every repository | 1.4 s |
| `decrire_projet` on one project | 150 ms |
| `chercher_partout` with ripgrep | 50 to 150 ms |
| `chercher_partout` without ripgrep (Node fallback) | 1.1 s |
| `trouver_fichiers` across every repository | 160 ms |

`node_modules`, `.git`, `dist`, `build`, `.astro`, `venv`, `__pycache__` and about twenty other folders are never walked.

## Development

```powershell
npm run dev                     # runs the sources directly via tsx
npm run build                   # compiles TypeScript to dist/
npm test                        # stdio MCP client that calls every tool and times it (needs npm run build first)
node tests/suivi-agents.mjs [minutes] [filter] [detail]   # calls only suivi_agents on the real logs
node tests/verif-accents.mjs    # checks accents and UTF-8 encoding
```

`tests/client-test.mjs` starts the compiled server, lists the tools and exercises each one with real parameters against this repository itself, including an error case (unknown project). It is the quickest way to check a change.

`tests/verif-accents.mjs` prints the full descriptions as a model receives them, counts accented characters, checks the code points of the generated markdown and verifies that source files are UTF-8 without BOM.

## Code layout

```
src/
  index.ts            entry point, stdio transport, tool registration
  config.ts           configuration, environment variables, secret file patterns
  core/
    fichiers.ts       error-tolerant traversal and reads, home-made glob
    depots.ts         root scanning, cache, project lookup by name
    stack.ts          tech stack and family detection
    cerveau.ts        locating and reading context documents
    git.ts            read-only git status
    recherche.ts      cross-repository search, ripgrep with Node fallback
    usage.ts          reading and aggregating token exports and invoices
    agents.ts         Codex, Claude Code and Vibe logs (tail only), live processes
  outils/             MCP tool definitions
  utils/reponse.ts    response formatting and crash guard
tests/                MCP test client, suivi_agents probe, accent check
```

## License

MIT, see [LICENSE](LICENSE).

Author: François Menguy, [fmenguy.fr](https://fmenguy.fr).
