import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
  type ThemedToken,
} from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

const THEME = "github-light";

type LangModule = { default: LanguageRegistration | LanguageRegistration[] };

/** 常用语言按需加载，每项都是独立 chunk，打开对应文件时才拉取 */
const LANGS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  sass: () => import("@shikijs/langs/sass"),
  less: () => import("@shikijs/langs/less"),
  html: () => import("@shikijs/langs/html"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  astro: () => import("@shikijs/langs/astro"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  php: () => import("@shikijs/langs/php"),
  ruby: () => import("@shikijs/langs/ruby"),
  csharp: () => import("@shikijs/langs/csharp"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  swift: () => import("@shikijs/langs/swift"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  "objective-cpp": () => import("@shikijs/langs/objective-cpp"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  powershell: () => import("@shikijs/langs/powershell"),
  bat: () => import("@shikijs/langs/bat"),
  fish: () => import("@shikijs/langs/fish"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  xml: () => import("@shikijs/langs/xml"),
  xsl: () => import("@shikijs/langs/xsl"),
  sql: () => import("@shikijs/langs/sql"),
  graphql: () => import("@shikijs/langs/graphql"),
  protobuf: () => import("@shikijs/langs/protobuf"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  makefile: () => import("@shikijs/langs/makefile"),
  ini: () => import("@shikijs/langs/ini"),
  dotenv: () => import("@shikijs/langs/dotenv"),
  diff: () => import("@shikijs/langs/diff"),
  lua: () => import("@shikijs/langs/lua"),
  dart: () => import("@shikijs/langs/dart"),
  scala: () => import("@shikijs/langs/scala"),
  zig: () => import("@shikijs/langs/zig"),
  nix: () => import("@shikijs/langs/nix"),
  terraform: () => import("@shikijs/langs/terraform"),
  cmake: () => import("@shikijs/langs/cmake"),
  nginx: () => import("@shikijs/langs/nginx"),
  groovy: () => import("@shikijs/langs/groovy"),
  log: () => import("@shikijs/langs/log"),
};

const EXT: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  json5: "jsonc",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  php: "php",
  rb: "ruby",
  cs: "csharp",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  swift: "swift",
  m: "objective-c",
  mm: "objective-cpp",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "fish",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  svg: "xml",
  xsl: "xsl",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  ini: "ini",
  conf: "ini",
  properties: "ini",
  dotenv: "dotenv",
  diff: "diff",
  patch: "diff",
  lua: "lua",
  dart: "dart",
  scala: "scala",
  zig: "zig",
  nix: "nix",
  tf: "terraform",
  tfvars: "terraform",
  cmake: "cmake",
  gradle: "groovy",
  log: "log",
};

function langForPath(rel: string): string | null {
  const name = (rel.split("/").pop() ?? "").toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile" || name.endsWith(".mk")) return "makefile";
  if (name === "cmakelists.txt") return "cmake";
  if (name === "cargo.lock") return "toml";
  if (name === ".env" || name.startsWith(".env.")) return "dotenv";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT[name.slice(dot + 1)] ?? null;
}

let core: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<string>>();

function highlighter(): Promise<HighlighterCore> {
  if (!core) {
    loaded.clear();
    core = createHighlighterCore({
      themes: [import("@shikijs/themes/github-light")],
      langs: [],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    }).catch((e) => {
      core = null;
      throw e;
    });
  }
  return core;
}

/** 语言模块里依赖的语言排在前面，目标语言永远是最后一个注册项 */
async function language(hl: HighlighterCore, key: string): Promise<string> {
  const cached = loaded.get(key);
  if (cached) return cached;
  const pending = LANGS[key]().then(async (mod) => {
    await hl.loadLanguage(mod);
    const regs = Array.isArray(mod.default) ? mod.default : [mod.default];
    return regs[regs.length - 1].name;
  });
  loaded.set(key, pending);
  pending.catch(() => loaded.delete(key));
  return pending;
}

export async function highlight(code: string, rel: string): Promise<ThemedToken[][] | null> {
  const key = langForPath(rel);
  if (!key) return null;
  const hl = await highlighter();
  const lang = await language(hl, key);
  return hl.codeToTokensBase(code, { lang, theme: THEME });
}

export type { ThemedToken };
