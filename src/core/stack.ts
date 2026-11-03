/**
 * Détection de la pile technique d'un projet à partir des fichiers présents.
 *
 * On ne devine jamais à partir du nom du dossier : uniquement à partir de
 * marqueurs concrets (fichiers manifestes, dépendances déclarées, extensions
 * majoritaires). Le résultat est volontairement court, il sert à situer le
 * projet en un coup d'oeil.
 */

import path from "node:path";
import { listerDossier, lireJson, lireTexte, trouverFichierRacine } from "./fichiers.js";

export interface PackageJson {
  name?: string;
  description?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export interface InfosStack {
  /** Pile principale, en un mot ou deux. */
  principale: string;
  /** Technologies détectées, de la plus structurante à la plus accessoire. */
  technologies: string[];
  /** Famille fonctionnelle déduite, pour regrouper les projets. */
  famille: string;
  /** Nom déclaré dans le manifeste (package.json, pyproject). */
  nomPaquet: string | null;
  /** Description déclarée dans le manifeste. */
  descriptionPaquet: string | null;
  /** Fichiers manifestes trouvés à la racine. */
  manifestes: string[];
}

/**
 * Familles fonctionnelles utilisées pour regrouper les projets.
 * Ce sont des libellés affichés, donc accentués. Les filtres qui s'appuient
 * dessus comparent sans les accents pour rester tolérants.
 */
export const FAMILLES = {
  mcp: "Serveur MCP",
  ecriture: "Écriture et romans",
  site: "Site web",
  backend: "Backend et API",
  front: "Application front",
  python: "Outil et script Python",
  statique: "Page ou jeu web statique",
  autre: "Autre",
} as const;

/** Libellé utilisé tant qu'aucun marqueur n'a permis de trancher. */
const PILE_INDETERMINEE = "indéterminée";

/** Dépendances npm qui identifient sans ambiguïté une technologie. */
const SIGNATURES_NPM: Array<[string, string]> = [
  ["@modelcontextprotocol/sdk", "MCP (SDK officiel)"],
  ["astro", "Astro"],
  ["next", "Next.js"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["three", "Three.js"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["electron", "Electron"],
  ["vite", "Vite"],
  ["tailwindcss", "Tailwind"],
  ["typescript", "TypeScript"],
  ["@anthropic-ai/sdk", "SDK Anthropic"],
  ["@anthropic-ai/claude-agent-sdk", "Claude Agent SDK"],
  ["openai", "SDK OpenAI"],
  ["playwright", "Playwright"],
  ["puppeteer", "Puppeteer"],
];

/** Modules Python qui identifient une technologie. */
const SIGNATURES_PYTHON: Array<[RegExp, string]> = [
  [/\bfastapi\b/i, "FastAPI"],
  [/\bflask\b/i, "Flask"],
  [/\bdjango\b/i, "Django"],
  [/\bstreamlit\b/i, "Streamlit"],
  [/\bopencv[-_]python\b/i, "OpenCV"],
  [/\bpandas\b/i, "pandas"],
  [/\bccxt\b/i, "CCXT"],
  [/\btorch\b/i, "PyTorch"],
  [/\bfastmcp\b|\bmcp\b/i, "MCP (Python)"],
  [/\bpyqt\d?\b|\btkinter\b|\bcustomtkinter\b/i, "interface graphique de bureau"],
  [/\brequests\b|\bhttpx\b/i, "client HTTP"],
];

/** Fichiers manifestes recherchés à la racine d'un dépôt. */
const MANIFESTES = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "Pipfile",
  "environment.yml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "composer.json",
  "Gemfile",
  "docker-compose.yml",
  "Dockerfile",
  "Makefile",
  "astro.config.mjs",
  "astro.config.ts",
  "astro.config.js",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
];

/** Extrait la valeur d'une clé simple dans un TOML plat (nom, description). */
function lireCleToml(contenu: string, cle: string): string | null {
  const re = new RegExp(`^\\s*${cle}\\s*=\\s*["']([^"']*)["']`, "mi");
  const m = contenu.match(re);
  return m ? m[1] : null;
}

/** Analyse la pile technique d'un dépôt à partir de sa racine. */
export async function detecterStack(racine: string): Promise<InfosStack> {
  const entrees = await listerDossier(racine);
  const fichiersRacine = new Map<string, string>();
  const dossiersRacine = new Set<string>();
  for (const e of entrees) {
    if (e.isFile()) fichiersRacine.set(e.name.toLowerCase(), e.name);
    else if (e.isDirectory()) dossiersRacine.add(e.name.toLowerCase());
  }

  const manifestes = MANIFESTES.filter((m) => fichiersRacine.has(m.toLowerCase()));
  const technologies: string[] = [];
  let nomPaquet: string | null = null;
  let descriptionPaquet: string | null = null;
  let principale = PILE_INDETERMINEE;

  // --- Piste Node / JavaScript ---
  const pkg = fichiersRacine.has("package.json")
    ? await lireJson<PackageJson>(path.join(racine, "package.json"))
    : null;

  if (pkg) {
    nomPaquet = pkg.name ?? null;
    descriptionPaquet = pkg.description ?? null;
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const [module, libelle] of SIGNATURES_NPM) {
      if (module in deps) technologies.push(libelle);
    }
    principale = technologies.includes("TypeScript") ? "Node / TypeScript" : "Node / JavaScript";
  }

  // Un fichier astro.config prime sur la simple présence de la dépendance.
  if (manifestes.some((m) => m.startsWith("astro.config"))) {
    if (!technologies.includes("Astro")) technologies.unshift("Astro");
    principale = "Astro";
  } else if (technologies.includes("Astro")) {
    principale = "Astro";
  }

  // --- Piste Python ---
  const aPython =
    fichiersRacine.has("requirements.txt") ||
    fichiersRacine.has("pyproject.toml") ||
    fichiersRacine.has("setup.py") ||
    fichiersRacine.has("pipfile");

  if (aPython) {
    let deps = "";
    const req = fichiersRacine.has("requirements.txt")
      ? await lireTexte(path.join(racine, "requirements.txt"))
      : null;
    if (req) deps += req;
    const pyproject = fichiersRacine.has("pyproject.toml")
      ? await lireTexte(path.join(racine, "pyproject.toml"))
      : null;
    if (pyproject) {
      deps += pyproject;
      nomPaquet = nomPaquet ?? lireCleToml(pyproject, "name");
      descriptionPaquet = descriptionPaquet ?? lireCleToml(pyproject, "description");
    }
    for (const [motif, libelle] of SIGNATURES_PYTHON) {
      if (motif.test(deps) && !technologies.includes(libelle)) technologies.push(libelle);
    }
    if (principale === PILE_INDETERMINEE || principale.startsWith("Node")) {
      principale = pkg ? `${principale} + Python` : "Python";
    }
  }

  // --- Autres piles ---
  if (fichiersRacine.has("cargo.toml")) principale = "Rust";
  if (fichiersRacine.has("go.mod")) principale = "Go";
  if (fichiersRacine.has("pom.xml") || fichiersRacine.has("build.gradle")) principale = "Java";
  if (entrees.some((e) => e.isFile() && e.name.toLowerCase().endsWith(".csproj"))) {
    principale = ".NET";
    technologies.push("C#");
  }
  if (fichiersRacine.has("dockerfile") || fichiersRacine.has("docker-compose.yml")) {
    technologies.push("Docker");
  }

  // --- Repli sur le contenu réel du dépôt ---
  if (principale === PILE_INDETERMINEE) {
    const compte = await compterExtensions(racine);
    const trie = [...compte.entries()].sort((a, b) => b[1] - a[1]);
    // Les extensions de code décrivent mieux un projet que les données
    // qu'il transporte : un dossier plein de .json reste un projet Python.
    const extensionsCode = new Set([
      ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro", ".svelte",
      ".vue", ".rs", ".go", ".java", ".kt", ".cs", ".rb", ".php", ".lua",
      ".ps1", ".sh", ".html", ".c", ".cpp",
    ]);
    // Un fichier de code égaré ne fait pas d'un dossier d'images un projet :
    // l'extension de code doit peser dans l'ensemble pour l'emporter.
    const total = trie.reduce((somme, [, n]) => somme + n, 0);
    const dominante =
      trie.find(([ext, n]) => extensionsCode.has(ext) && n >= 2 && n / total >= 0.08) ??
      trie[0];
    if (dominante) {
      const parExtension: Record<string, string> = {
        ".py": "Python",
        ".ts": "TypeScript",
        ".js": "JavaScript",
        ".html": "HTML statique",
        ".md": "Markdown (documentation ou rédaction)",
        ".ps1": "PowerShell",
        ".sh": "Shell",
        ".astro": "Astro",
        ".cs": "C#",
        ".rs": "Rust",
        ".go": "Go",
      };
      const medias = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".wav", ".mp3", ".psd"]);
      principale = medias.has(dominante[0])
        ? "dossier de ressources (images et médias)"
        : parExtension[dominante[0]] ?? `fichiers ${dominante[0]}`;
    }
  }

  return {
    principale,
    technologies: [...new Set(technologies)],
    famille: deduireFamille(racine, principale, technologies, dossiersRacine),
    nomPaquet,
    descriptionPaquet,
    manifestes,
  };
}

/** Compte les extensions de fichiers d'un dépôt, en surface (3 niveaux). */
async function compterExtensions(racine: string): Promise<Map<string, number>> {
  const { parcourir } = await import("./fichiers.js");
  const fichiers = await parcourir(racine, { profondeurMax: 3, limiteFichiers: 800 });
  const compte = new Map<string, number>();
  for (const f of fichiers) {
    const ext = path.extname(f.relatif).toLowerCase();
    if (ext === "") continue;
    compte.set(ext, (compte.get(ext) ?? 0) + 1);
  }
  return compte;
}

/**
 * Regroupe le projet dans une famille fonctionnelle.
 * Sert à présenter l'écosystème par usage plutôt que par ordre alphabétique.
 */
function deduireFamille(
  racine: string,
  principale: string,
  technologies: string[],
  dossiersRacine: Set<string>
): string {
  const cheminBas = racine.toLowerCase();
  if (technologies.some((t) => t.startsWith("MCP"))) return FAMILLES.mcp;
  // Un projet d'écriture se reconnaît à son emplacement ou à un dossier de
  // chapitres. Un simple dossier `references` ne suffit pas, beaucoup de
  // projets techniques en ont un.
  if (cheminBas.includes(`${path.sep}histoires${path.sep}`) || dossiersRacine.has("chapitres")) {
    return FAMILLES.ecriture;
  }
  if (principale === "Astro" || technologies.includes("Next.js")) return FAMILLES.site;
  if (technologies.includes("FastAPI") || technologies.includes("Flask") || technologies.includes("Django")) {
    return FAMILLES.backend;
  }
  if (technologies.includes("Three.js") || technologies.includes("React")) return FAMILLES.front;
  if (principale.includes("Python")) return FAMILLES.python;
  if (principale === "HTML statique") return FAMILLES.statique;
  return FAMILLES.autre;
}

/** Détecte la présence d'une configuration MCP dans un dépôt. */
export async function lireConfigMcp(
  racine: string
): Promise<string[]> {
  const chemin = await trouverFichierRacine(racine, ".mcp.json");
  if (!chemin) return [];
  const contenu = await lireJson<{ mcpServers?: Record<string, unknown> }>(chemin);
  if (!contenu?.mcpServers) return [];
  return Object.keys(contenu.mcpServers);
}
