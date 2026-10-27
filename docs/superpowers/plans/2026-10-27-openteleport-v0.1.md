# OpenTeleport v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npx openteleport move --from <app> --to <app> --agent <name>` przenosi agenta (persona, instrukcje, skille, rutyny, fakty z pamięci, preferencje modeli) między dowolnym katalogiem projektu (`folder`), OpenClaw i Claude Code, w obie strony, z raportem tego, co przeniesiono, przybliżono i pominięto.

**Architecture:** Trzy warstwy w jednym pakiecie npm: `core` (schemat `.jetpack`, archiwum, sekrety, raport, konwersje), `adapters` (jeden moduł na aplikację, wspólny interfejs `detect/list/read/write`), `cli` (cienkie polecenia). Format `.jetpack` używa nazw plików, które są już standardem między narzędziami (`AGENTS.md`, `SOUL.md`, `skills/*/SKILL.md`, `MEMORY.md`), więc rozpakowany plik jest sam w sobie działającym katalogiem agenta; adapter `folder` to ten układ bez wymogu manifestu. Silnik `move` to `read` ze źródła, walidacja, `write` do celu, a różnice między deklarowanymi możliwościami adapterów trafiają do raportu. Narzędzie nigdy nie woła modelu językowego.

**Tech Stack:** TypeScript 5 (strict), Node.js 24 LTS, npm, tsup (ESM + bin), vitest, commander, @clack/prompts, zod 4 (`z.toJSONSchema`), fflate (zip), ulid, json5, yaml, execa.

**Spec:** `docs/superpowers/specs/2026-10-27-openteleport-design.md` (w C:\dev\OpenSI; kopiowany do repo jako `docs/design.md` w Task 1).

## Global Constraints

- Nazwa pakietu npm: `openteleport`; polecenie: `openteleport` (nigdy `teleport`). Organizacja GitHub: `openteleport`, repo `openteleport/openteleport`. Licencja Apache-2.0.
- Język kodu, README, komunikatów CLI, issues: angielski.
- Node `>=24`. `"type": "module"`. Zero zależności natywnych.
- Żadna aplikacja nie jest wyznacznikiem: w `core/` nie ma importów z `adapters/`; nazwa żadnej aplikacji nie występuje w `core/` poza komentarzami.
- Rozszerzenie archiwum: `.jetpack` (zwykły zip). Manifest: `jetpack.json`, `schemaVersion: "0.1"`. Układ katalogu: `jetpack.json`, `AGENTS.md`, `SOUL.md` (opcjonalny), `skills/<name>/SKILL.md`, `MEMORY.md`, `memory/<name>.md`, `routines/<slug>.json`, `files/`, `avatar.<ext>`.
- Sekrety nigdy w archiwum: odrzucać `.env*`, `*private*key*`, `.git/`, `node_modules/`, zagnieżdżone archiwa (`.zip .tar .gz .tgz .7z .rar`), tokeny o wzorcach z Task 4.
- Limity formatu (ustawione na najciaśniejszy znany importer, żeby plik przechodził wszędzie): `name` ≤ 80 znaków, `title` ≤ 120, skille ≤ 32, rutyny ≤ 64, fakt ≤ 500 znaków, `files/` ≤ 100 MB, avatar ≤ 512 KB PNG/JPEG/WebP.
- Rutyny po imporcie domyślnie **wyłączone**; `--enable-routines` włącza. `move` nigdy nie modyfikuje źródła.
- `files/` tylko z `--include-files`.
- README zawiera zdanie: "Not affiliated with Teleport by Gravitational."
- Testy nie dotykają katalogu domowego użytkownika: zawsze `--source-dir`/`--target-dir` albo `OPENTELEPORT_HOME` wskazujące na katalog tymczasowy; adaptery czytają `HOME` wyłącznie z `ctx.home`.

## Review Focus

1. Plik `.jetpack` z instrukcją zawierającą wklejony klucz `sk-ant-...`: `export` odmawia z listą trafień, `import` odrzuca plik. Test w Task 4 i Task 12.
2. Agent o tej samej nazwie już istnieje w celu, a bundle nie niesie znanego `id`: domyślnie kopia z sufiksem `-2`, raport mówi dlaczego; `--replace` nadpisuje. Test w Task 8, 10, 11, 12.
3. Rutyna, której cel nie umie wyrazić (Claude Code nie ma rutyn plikowych; OpenClaw nie przyjmie `every` poniżej 1 minuty): rutyna pominięta, wpis w raporcie z nazwą i powodem, reszta agenta importuje się. Test w Task 7, 10, 11.
4. Workspace OpenClaw bez `SOUL.md` albo bez `IDENTITY.md`, katalog `folder` bez `MEMORY.md`, agent Claude Code bez `model` we frontmatterze: eksport działa, brakujące pola puste, raport wymienia brak. Test w Task 8, 9, 10.
5. Katalog pamięci Claude Code dla projektu jest pochodną ścieżki projektu (np. `C:\dev\OpenSI` → `~/.claude/projects/C--dev-OpenSI/memory/`): zła sanityzacja zapisuje pamięć w cudzym katalogu. Test w Task 10 przypina regułę na trzech systemach.

---

## Struktura plików

```
openteleport/
  package.json  tsconfig.json  tsup.config.ts  vitest.config.ts  LICENSE  README.md  .gitignore
  .github/workflows/ci.yml          test na ubuntu, macos, windows; node 24
  docs/design.md                    kopia specyfikacji
  schema/jetpack.schema.json        generowany z zod (Task 2), publikowany
  src/
    index.ts                        publiczne API: readBundle, writeBundle, move, adapters
    cli.ts                          bin: commander, rejestracja poleceń
    core/
      schema.ts                     zod: Manifest, Routine, Schedule, Bundle; typy
      bundle.ts                     katalog <-> zip <-> Bundle
      paths.ts                      ścieżki zakazane, limity rozmiaru
      secrets.ts                    skan tokenów i plików
      report.ts                     MoveReport, renderMarkdown
      ids.ts                        ULID + cache <home>/.openteleport/ids.json
      text.ts                       merge/split SOUL+AGENTS, proza -> fakty
      schedule.ts                   Schedule <-> cron/every/at, parsery i opisy
      engine.ts                     move(): read -> validate -> write -> report
    adapters/
      types.ts                      Adapter, AdapterCapabilities, WriteResult, Ctx
      registry.ts                   getAdapter(name), listAdapters()
      folder/index.ts               uniwersalny katalog (manifest opcjonalny)
      openclaw/
        index.ts  paths.ts  cli.ts  read.ts  write.ts
      claude-code/
        index.ts  paths.ts  frontmatter.ts  read.ts  write.ts
    commands/
      export.ts  import.ts  move.ts  inspect.ts  validate.ts  list.ts  shared.ts
  test/
    fixtures/
      jetpack/ada/                  katalog .jetpack referencyjny
      folder/no-manifest/           katalog z AGENTS.md + skills, bez jetpack.json
      openclaw/home/                ~/.openclaw z openclaw.json i 2 workspace'ami
      openclaw/automations.json     wyjście `openclaw automations list --json --all`
      claude-code/project/          projekt z .claude/agents/reviewer.md, .claude/skills/
      claude-code/home/             ~/.claude z projects/<sanitized>/memory/
    helpers/memory-adapter.ts
    core/*.test.ts  adapters/**/*.test.ts  commands/*.test.ts  e2e/roundtrip.test.ts
```

---

### Task 1: Szkielet repozytorium i CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `LICENSE`, `README.md`, `.gitignore`, `.github/workflows/ci.yml`, `src/cli.ts`, `src/index.ts`, `docs/design.md`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Produces: `npm run build` tworzy `dist/cli.js` (bin) i `dist/index.js`; `npm test` uruchamia vitest; `npx openteleport --version` drukuje wersję z package.json.

- [ ] **Step 1: Utwórz repo** — `mkdir C:\dev\openteleport && cd C:\dev\openteleport && git init -b main`.

- [ ] **Step 2: `package.json`** — `name: "openteleport"`, `version: "0.1.0"`, `type: "module"`, `license: "Apache-2.0"`, `bin: { "openteleport": "dist/cli.js" }`, `exports: "./dist/index.js"`, `engines: { node: ">=24" }`, `files: ["dist", "schema", "README.md", "LICENSE"]`, skrypty: `build` (tsup), `test` (vitest run), `lint` (tsc --noEmit), `schema` (node dist/scripts/emit-schema.js). Zależności: `commander@^13`, `@clack/prompts@^0.10`, `zod@^4`, `fflate@^0.8`, `ulid@^2`, `json5@^2`, `yaml@^2`, `execa@^9`. Dev: `typescript@^5`, `tsup@^8`, `vitest@^3`, `@types/node@^24`.

- [ ] **Step 3: `tsconfig.json`** — `strict`, `module: "NodeNext"`, `target: "ES2022"`, `rootDir: "src"`, `outDir: "dist"`, `types: ["node"]`.

- [ ] **Step 4: `tsup.config.ts`** — wpisy `src/cli.ts` (banner `#!/usr/bin/env node`), `src/index.ts` (dts), `src/scripts/emit-schema.ts`; format `esm`; `clean`.

- [ ] **Step 5: Failing test `test/smoke.test.ts`**

```ts
it("prints version", async () => {
  const { stdout } = await execaNode("dist/cli.js", ["--version"]);
  expect(stdout).toMatch(/^0\.1\.0$/);
});
```

- [ ] **Step 6: Run** `npm run build && npm test` → FAIL.
- [ ] **Step 7: `src/cli.ts`** — `new Command("openteleport").version(pkg.version).description("Move your AI agent between apps in one command.")`; `src/index.ts` eksportuje `VERSION`.
- [ ] **Step 8: Run** → PASS.
- [ ] **Step 9:** `LICENSE` (Apache-2.0, 2026 OpenTeleport contributors), `README.md` (jedno zdanie, trzy polecenia z sekcji 6 spec, zdanie o Gravitational), `.gitignore`, `docs/design.md`.
- [ ] **Step 10: `.github/workflows/ci.yml`** — matrix `ubuntu-latest, macos-latest, windows-latest`, node 24, `npm ci`, `npm run lint`, `npm run build`, `npm test`.
- [ ] **Step 11: Commit** `chore: scaffold openteleport package, CLI entry, CI`

---

### Task 2: Schemat manifestu i generowanie JSON Schema

**Files:**
- Create: `src/core/schema.ts`, `src/scripts/emit-schema.ts`, `schema/jetpack.schema.json`
- Test: `test/core/schema.test.ts`

**Interfaces:**
- Produces:
  - `Manifest = { schemaVersion: "0.1"; id: string /* ULID */; name: string; title?: string; description?: string; models: ModelPref[]; capabilities: Capability[]; origin?: { app: string; version?: string; exportedAt: string }; signature?: null; [key: \`x-${string}\`]: unknown }`
  - `ModelPref = { runtime?: string; provider?: string; model?: string }` (co najmniej jedno pole)
  - `Capability = "browser" | "shell" | "filesystem" | "network" | "computerUse" | "scheduler"`
  - `Routine = { name: string; instruction: string; enabled: boolean; timezone: string; schedule: Schedule }`
  - `Schedule = { kind: "cron"; expression: string } | { kind: "every"; every: string /* /^\d+(m|h|d)$/ */ } | { kind: "at"; at: string /* ISO 8601 */ }`
  - `Bundle = { manifest: Manifest; persona?: string; instructions: string; skills: Skill[]; routines: Routine[]; facts: string[]; notes: Note[]; files: FileEntry[]; avatar?: { name: string; bytes: Uint8Array }; unknownPaths: string[] }`
  - `Note = { name: string /* bez .md */; text: string }`, `Skill = { name: string; files: FileEntry[] }` (`files[0].path === "SKILL.md"`), `FileEntry = { path: string; bytes: Uint8Array }`
  - `parseManifest(json: unknown): Manifest` (rzuca `ZodError`), `ManifestSchema`, `RoutineSchema`

- [ ] **Step 1: Failing tests**

```ts
it("accepts a minimal manifest", () => { expect(parseManifest(MIN).name).toBe("Ada"); });
it("rejects name longer than 80 chars", () => { expect(() => parseManifest({ ...MIN, name: "a".repeat(81) })).toThrow(); });
it("keeps x-vendor keys and rejects unknown keys without prefix", () => {
  expect(parseManifest({ ...MIN, "x-openclaw": { emoji: "🦥" } })["x-openclaw"]).toEqual({ emoji: "🦥" });
  expect(() => parseManifest({ ...MIN, vendorStuff: 1 })).toThrow();
});
it("rejects a ModelPref with no fields", ...); it("rejects unknown schemaVersion", ...);
it("validates timezone as IANA and every as duration", ...); // RoutineSchema: "Europe/Warsaw" ok, "Mars/Olympus" błąd; "30m" ok, "30 minutes" błąd
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (zod; `Intl.supportedValuesOf("timeZone")` dla IANA; `z.iso.datetime()` dla `at`). **Step 4: Run** → PASS.
- [ ] **Step 5: `src/scripts/emit-schema.ts`** — `z.toJSONSchema(ManifestSchema)` z `$id: "https://openteleport.dev/schema/0.1/jetpack.json"` do `schema/jetpack.schema.json`; test, że plik w repo równa się wynikowi.
- [ ] **Step 6: Run** `npm run build && npm run schema && npm test` → PASS.
- [ ] **Step 7: Commit** `feat(core): jetpack manifest schema and JSON Schema export`

---

### Task 3: Archiwum `.jetpack`: katalog ↔ zip ↔ Bundle

**Files:**
- Create: `src/core/bundle.ts`, `src/core/paths.ts`
- Test: `test/core/bundle.test.ts`, fixture `test/fixtures/jetpack/ada/`

**Interfaces:**
- Consumes: `Bundle`, `parseManifest`
- Produces:
  - `readBundle(source: string, opts?: { requireManifest?: boolean /* default true */ }): Promise<Bundle>` — katalog albo zip; bez manifestu i `requireManifest:false` → `manifest` z `name = basename(source)`, `id = ""` (uzupełnia `ensureId` w silniku), `models: []`, `capabilities: []`
  - `writeBundle(bundle: Bundle, target: string, opts?: { asDirectory?: boolean }): Promise<void>`
  - `bundleToEntries(bundle: Bundle): FileEntry[]`, `entriesToBundle(entries: FileEntry[], opts): Bundle` (czyste)
  - `paths.ts`: `FORBIDDEN_PATH_PATTERNS`, `isForbiddenPath(path)`, `MAX_FILES_BYTES = 100 * 1024 * 1024`, `MAX_AVATAR_BYTES = 512 * 1024`
  - Mapowanie: `AGENTS.md` ↔ `instructions`; `SOUL.md` ↔ `persona`; `MEMORY.md` ↔ `facts` (linie `- ` po `trim`, każda ≤ 500; linie niebędące punktami → `notes` pod nazwą `MEMORY-prose`); `memory/<name>.md` ↔ `notes`; `routines/<slug>.json` ↔ `routines`; `skills/<name>/**` ↔ `skills`; `files/**` ↔ `files`; `avatar.<png|jpg|jpeg|webp>` ↔ `avatar`

- [ ] **Step 1: Fixture** `test/fixtures/jetpack/ada/` — manifest Ady (2 modele: `{runtime:"claude-code",provider:"anthropic",model:"claude-opus-5-5"}`, `{runtime:"codex",provider:"openai",model:"gpt-5.5"}`; capabilities `["browser","filesystem","scheduler"]`), `SOUL.md`, `AGENTS.md`, `skills/web-brief/SKILL.md` (frontmatter `name: web-brief`, `description`), `routines/morning-digest.json` (`cron "30 8 * * 1-5"`, `Europe/Warsaw`, `enabled: true`), `MEMORY.md` z 2 punktami i jednym akapitem, `memory/2026-10-20.md`, `avatar.png` (1×1 px).

- [ ] **Step 2: Failing tests**

```ts
it("round-trips directory -> Bundle -> zip -> Bundle", ...)   // manifest równy, facts == 2, notes == ["2026-10-20", "MEMORY-prose"], skills == ["web-brief"], routines[0].schedule.kind == "cron"
it("reads a folder without manifest when requireManifest is false", ...) // name == basename, facts z MEMORY.md
it("rejects forbidden paths inside the archive", ...)           // files/.env -> /forbidden path: files\/\.env/
it("rejects nested archives and .git", ...)
it("rejects files/ over MAX_FILES_BYTES and avatar over MAX_AVATAR_BYTES", ...)
it("fails on missing AGENTS.md", ...)
it("reports unknown top-level files in unknownPaths", ...)
```

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** (fflate; ścieżki w zip z `/`, bez `..` i absolutnych). **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(core): read and write .jetpack bundles`

---

### Task 4: Skaner sekretów

**Files:**
- Create: `src/core/secrets.ts`
- Test: `test/core/secrets.test.ts`

**Interfaces:**
- Produces: `scanSecrets(bundle: Bundle): SecretFinding[]`, `SecretFinding = { path: string; line?: number; kind: string; preview: string /* 6 znaków + "…" */ }`, `SECRET_PATTERNS: { kind: string; regex: RegExp }[]`

- [ ] **Step 1: Failing tests** — po jednym na wzorzec: `sk-` (w tym `sk-ant-`), `ghp_`/`github_pat_`, `xoxb-`/`xoxp-`, `AKIA[0-9A-Z]{16}`, `-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----`, `AIza[0-9A-Za-z_-]{35}`, JWT, `Bearer [A-Za-z0-9._-]{20,}`; instrukcja z `sk-ant-api03-abc…` → `{ path: "AGENTS.md", line, kind: "anthropic-api-key" }`, `preview` bez pełnego tokena; tekst zwykły → `[]`; skan obejmuje `AGENTS.md`, `SOUL.md`, `skills/**`, `routines/*.json` (`instruction`), `MEMORY.md`, `memory/*`, `files/**` tekstowe ≤ 2 MB (binarne po bajcie NUL w pierwszych 8 KB pomijane).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(core): secret scanner`

---

### Task 5: Raport przeniesienia

**Files:**
- Create: `src/core/report.ts`
- Test: `test/core/report.test.ts`

**Interfaces:**
- Produces: `MoveReport = { source: { app: string; agent: string }; target?: { app: string; agent?: string }; outcome: "done" | "handoff" | "exported"; nextStep?: string; moved: Item[]; approximated: Item[]; skipped: Item[]; warnings: string[] }`, `Item = { field: string; detail: string }`, `renderReportMarkdown(r)`, `renderReportTerminal(r)` (bez kolorów gdy `!isTTY`), `writeReportFile(r, dir): Promise<string>` → `<dir>/move-report.md`

- [ ] **Step 1: Failing tests** — markdown ma `## Moved`, `## Approximated`, `## Skipped`; pusta sekcja → `_nothing_`; `handoff` → `**Next step:** …` na górze; snapshot terminala.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(core): move report`

---

### Task 6: Konwersje tekstu i harmonogramów

**Files:**
- Create: `src/core/text.ts`, `src/core/schedule.ts`
- Test: `test/core/text.test.ts`, `test/core/schedule.test.ts`

**Interfaces:**
- Produces (`text.ts`): `mergeInstructions(persona: string | undefined, instructions: string): string` (`"# Persona\n\n…\n\n# Instructions\n\n…"` gdy persona, inaczej same instrukcje); `splitInstructions(text): { persona?: string; instructions: string }` (odwrotność; inny tekst → `{ instructions: text }`); `proseToFacts(notes: string, max = 500): { facts: string[]; truncated: number }` (akapity i punkty `- `/`* `/`1. `, `trim`, obcięcie z `…`); `factsToProse(facts: string[]): string` (`- fakt` na linię)
- Produces (`schedule.ts`): `parseCron(expr: string): { ok: true; fields: 5 | 6 } | { ok: false; reason: string }`; `everyToMs(every: string): number`; `msToEvery(ms: number): string | null` (pełne minuty/godziny/dni, inaczej `null`); `describeSchedule(s: Schedule): string` (np. `"every weekday at 08:30 (Europe/Warsaw)"` dla prostych cronów, inaczej surowe wyrażenie); `toOpenClawFlags(s: Schedule, tz: string): string[]` (cron → `["--cron", expr, "--tz", tz]`, every → `["--every", every]`, at → `["--at", at, "--tz", tz]`); `fromOpenClawJob(job: { schedule: unknown }): Schedule | null` (`{kind:"cron",expr,tz}`, `{kind:"every",everyMs}` przez `msToEvery`, `{kind:"at",at}`; `on-exit`/`stream` → `null`)

- [ ] **Step 1: Failing tests** — `splitInstructions(mergeInstructions("P","I"))` → `{persona:"P",instructions:"I"}`; `proseToFacts("Akapit.\n\n- a\n- b")` → 3; fakt 600 znaków → obcięty, `truncated: 1`; `parseCron("30 8 * * 1-5").ok`; `parseCron("x").ok === false`; `msToEvery(1800000) === "30m"`; `msToEvery(90000) === null`; `fromOpenClawJob({schedule:{kind:"on-exit"}}) === null`; `toOpenClawFlags` dla 3 rodzajów.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(core): text and schedule conversions`

---

### Task 7: Interfejs adaptera, rejestr, silnik `move`, identyfikatory

**Files:**
- Create: `src/adapters/types.ts`, `src/adapters/registry.ts`, `src/core/engine.ts`, `src/core/ids.ts`, `test/helpers/memory-adapter.ts`
- Test: `test/core/engine.test.ts`, `test/core/ids.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `AdapterCapabilities = { persona: boolean; instructions: boolean; skills: boolean; routines: boolean; facts: boolean; notes: boolean; files: boolean; avatar: boolean; models: boolean; schedules: Schedule["kind"][] }`
  - `AgentRef = { id: string; name: string; title?: string; location?: string }`
  - `WriteResult = { outcome: "done" | "handoff"; nextStep?: string; targetAgentId?: string; artifactPath?: string; items: { approximated: Item[]; skipped: Item[]; warnings: string[] } }`
  - `Ctx = { sourceDir?: string; targetDir?: string; home: string; cwd: string; env: NodeJS.ProcessEnv; exec: typeof execa; logger: (msg: string) => void }`
  - `WriteOpts = { enableRoutines: boolean; includeFiles: boolean; onConflict: "update" | "replace" | "copy" }`
  - `Adapter = { name: string; displayName: string; capabilities: AdapterCapabilities; detect(ctx): Promise<{ found: boolean; location?: string; version?: string; hint?: string }>; list(ctx): Promise<AgentRef[]>; read(ctx, agent: string): Promise<{ bundle: Bundle; warnings: string[] }>; write(ctx, bundle: Bundle, opts: WriteOpts): Promise<WriteResult> }`
- Produces (`registry.ts`): `getAdapter(name): Adapter` (rzuca `UnknownAdapterError` z listą), `listAdapters(): Adapter[]`, `registerAdapter(a: Adapter)` (dla testów)
- Produces (`engine.ts`): `move(opts: { from: Adapter; to: Adapter; agent: string; ctx: Ctx; write: WriteOpts }): Promise<MoveReport>` — `from.read` → `ensureId` → `scanSecrets` (znaleziska → `SecretsFoundError(findings)`) → `diffCapabilities(bundle, to.capabilities)` (pola nieobsługiwane → `skipped` przed zapisem; rutyny z `schedule.kind` spoza `to.capabilities.schedules` → `skipped` z nazwą i powodem; `includeFiles:false` → `files` wycięte bez wpisu) → `to.write` → scalenie `items` → raport; `exportBundle(opts: { from; agent; ctx; out?: string; includeFiles })` i `importBundle(opts: { to; bundle; ctx; write })` jako składowe używane przez CLI
- Produces (`ids.ts`): `ensureId(bundle, key: { app: string; agentId: string }, home: string): Promise<Bundle>` — cache `<home>/.openteleport/ids.json`; uszkodzony cache → pusty

- [ ] **Step 1: `test/helpers/memory-adapter.ts`** — adapter w pamięci z konfigurowalnymi `capabilities`, rejestrem zapisów i opcją `conflictWith: string[]`.

- [ ] **Step 2: Failing tests (engine)**

```ts
it("skips facts when target has facts:false and lists them", ...)          // skipped zawiera { field: "memory.facts", detail: … }
it("skips a routine whose schedule kind the target lacks", ...)           // skipped[0].field === "routine:One-off"
it("aborts on secrets before writing", ...)                               // target.written.length === 0
it("drops files unless includeFiles", ...)
it("propagates outcome handoff and nextStep", ...)
it("assigns an id to a manifest-less bundle", ...)                        // ULID 26 znaków
```

- [ ] **Step 3: Failing tests (ids)** — ten sam klucz → ten sam id; uszkodzony `ids.json` nie rzuca.
- [ ] **Step 4–6:** FAIL → implement → PASS. **Step 7: Commit** `feat(core): adapter interface, registry, move engine, id cache`

---

### Task 8: Adapter `folder` (uniwersalny)

**Files:**
- Create: `src/adapters/folder/index.ts`
- Modify: `src/adapters/registry.ts`
- Test: `test/adapters/folder.test.ts`, fixture `test/fixtures/folder/no-manifest/`

**Interfaces:**
- Consumes: `readBundle({ requireManifest: false })`, `writeBundle({ asDirectory: true })`
- Produces adapter `folder`:
  - `capabilities`: wszystko `true`, `schedules: ["cron","every","at"]`
  - `detect(ctx)`: `dir = ctx.sourceDir ?? ctx.targetDir ?? ctx.cwd`; `found` gdy `dir/AGENTS.md` istnieje albo `dir` zawiera podkatalogi z `AGENTS.md`; `hint: "Pass --source-dir <folder> with an AGENTS.md inside"`
  - `list(ctx)`: jeśli `dir/AGENTS.md` → `[{ id: ".", name: manifest.name ?? basename(dir) }]`; inaczej każdy podkatalog z `AGENTS.md` → `{ id: <subdir>, name }`
  - `read(ctx, agent)`: `readBundle(join(dir, agent === "." ? "" : agent), { requireManifest: false })`; brak `SOUL.md`/`MEMORY.md` → warnings
  - `write(ctx, bundle, opts)`: `target = ctx.targetDir ?? join(ctx.cwd, slug(bundle.manifest.name))`; jeśli istnieje i niepusty: `onConflict` `update` → nadpisz nasze pliki, zostaw inne; `copy` → `<target>-2`, `-3`…; `replace` → wyczyść katalog; zapis `writeBundle(bundle, target, { asDirectory: true })` (z `jetpack.json`); rutyny zawsze zapisane jako `routines/*.json` z `enabled` wg `opts.enableRoutines` i warning `"routines are stored in the folder; no app runs them from here yet"`; `outcome: "done"`, `targetAgentId: target`

- [ ] **Step 1: Fixture** `test/fixtures/folder/no-manifest/` — `AGENTS.md`, `skills/web-brief/SKILL.md`, `MEMORY.md` z 1 punktem; bez `SOUL.md`, bez `jetpack.json`.
- [ ] **Step 2: Failing tests** — `read` fixture → `name === "no-manifest"`, `facts.length === 1`, warnings zawierają `"SOUL.md not found"`; `write` Ady do pustego katalogu → `AGENTS.md`, `SOUL.md`, `jetpack.json`, `skills/web-brief/SKILL.md`, `MEMORY.md`, `routines/morning-digest.json` z `enabled:false`; drugi `write` z `onConflict:"copy"` → `ada-2`; `update` → nadpisuje `AGENTS.md`, zostawia obcy plik `notes.txt`; `list` na katalogu z 2 podkatalogami → 2 wpisy.
- [ ] **Step 3–5:** FAIL → implement → PASS. Zarejestruj w `registry.ts`.
- [ ] **Step 6: Commit** `feat(folder): universal directory adapter`

---

### Task 9: Adapter OpenClaw — odczyt

**Files:**
- Create: `src/adapters/openclaw/index.ts`, `src/adapters/openclaw/paths.ts`, `src/adapters/openclaw/cli.ts`, `src/adapters/openclaw/read.ts`
- Modify: `src/adapters/registry.ts`
- Test: `test/adapters/openclaw/read.test.ts`, fixtures `test/fixtures/openclaw/home/`, `test/fixtures/openclaw/automations.json`

**Interfaces:**
- Consumes: `Adapter`, `fromOpenClawJob`, `readBundle`
- Produces:
  - `openclawPaths(ctx): { stateDir: string; configFile: string; workspaceFor(agentId: string, cfg: OpenClawConfig): string }` — `stateDir = ctx.sourceDir ?? ctx.targetDir ?? ctx.env.OPENCLAW_STATE_DIR ?? <home>/.openclaw`; `configFile = ctx.env.OPENCLAW_CONFIG_PATH ?? <stateDir>/openclaw.json`; workspace: `agents.entries[id].workspace` → `<agents.defaults.workspace>/<id>` → `<stateDir>/workspace` dla jedynego agenta → `<stateDir>/workspace-<id>`; `~` rozwijane do `ctx.home`
  - `readOpenClawConfig(file): Promise<OpenClawConfig>` (json5); `OpenClawConfig = { agents?: { defaults?: { workspace?: string }; entries?: Record<string, OpenClawAgentEntry> } }`; `OpenClawAgentEntry = { name?: string; workspace?: string; model?: string | { primary: string; fallbacks?: string[] }; skills?: string[]; identity?: { name?: string; emoji?: string; theme?: string; avatar?: string }; runtime?: { type?: string; acp?: { agent?: string } } }`
  - `OpenClawCli(ctx)`: `agentsList(): Promise<{ id: string; name?: string; workspace?: string }[]>`, `automationsList(): Promise<JobRow[]>` (`openclaw automations list --json --all`), `agentsAdd(id, workspace)`, `setIdentity(agent, { name, emoji?, avatar? })`, `automationsAdd(args: string[]): Promise<{ id: string }>`, `automationsDisable(id)`, `configSet(path: string, value: string): Promise<boolean>` (zwraca `false`, gdy polecenie nieobsługiwane); wszystkie przez `ctx.exec("openclaw", […, "--json"], { env: { ...ctx.env, OPENCLAW_STATE_DIR: stateDir } })`; nazwy pól JSON (`id`, `disabled`, `schedule`, `payload.message`, `agentId`) builder potwierdza na żywym `openclaw --version` i wpisuje do fixture
  - `readOpenClawAgent(ctx, agentId)`: `name` ← `identity.name ?? name ?? id`; `persona` ← `SOUL.md`; `instructions` ← `AGENTS.md`; `facts` ← punkty z `MEMORY.md`; `notes` ← reszta `MEMORY.md` + `memory/*.md`; `skills` ← `<workspace>/skills/*`; `routines` ← joby z `agentId` (`fromOpenClawJob`; `null` → warning z nazwą), `instruction` ← `payload.message`, `enabled` ← `!disabled`; `models` ← `provider/model` → `{provider, model}`, `{primary, fallbacks}` → lista, `runtime.acp.agent` → `runtime` pierwszego wpisu; `avatar` ← `identity.avatar` gdy względna ścieżka istnieje; `capabilities` ← `["browser","shell","filesystem","network","scheduler"]` + `approximated`; `x-openclaw` ← `{ identity }`
  - `openclaw.capabilities`: persona, instructions, skills, routines, facts, notes, avatar, models `true`; files `false`; schedules `["cron","every","at"]`
  - `detect`: `configFile` istnieje → `found`, `version` z `openclaw --version` gdy w PATH; `hint: "Install OpenClaw or pass --source-dir <state dir>"`

- [ ] **Step 1: Fixtures** — `openclaw.json` (json5 z komentarzem; `agents.entries.ada` z `identity`, `model: { primary: "anthropic/claude-opus-5-5", fallbacks: ["openai/gpt-5.5"] }`, `skills: ["web-brief"]`; `agents.entries.bare` puste), `workspace-ada/` (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `MEMORY.md` z 2 punktami + akapit, `memory/2026-10-20.md`, `skills/web-brief/SKILL.md`), `workspace-bare/` (tylko `AGENTS.md`), `automations.json` (cron Ady, `every` 1800000 ms Ady, `on-exit` Ady, 1 job innego agenta).
- [ ] **Step 2: Failing tests** — Ada: `facts.length === 2`, `notes` ma `MEMORY-prose` i `2026-10-20`, `routines.length === 2`, warning z nazwą joba `on-exit`, `models` w kolejności primary→fallback, `persona === SOUL.md`; `bare`: `persona` undefined, warnings `"SOUL.md not found"`, `"IDENTITY.md not found"`; `OPENCLAW_STATE_DIR` i `ctx.sourceDir` respektowane; `exec` dostaje `OPENCLAW_STATE_DIR` w env.
- [ ] **Step 3–5:** FAIL → implement (stub `ctx.exec` czyta `automations.json`) → PASS.
- [ ] **Step 6: Commit** `feat(openclaw): read adapter`

---

### Task 10: Adapter Claude Code — odczyt i zapis

**Files:**
- Create: `src/adapters/claude-code/index.ts`, `src/adapters/claude-code/paths.ts`, `src/adapters/claude-code/frontmatter.ts`, `src/adapters/claude-code/read.ts`, `src/adapters/claude-code/write.ts`
- Modify: `src/adapters/registry.ts`
- Test: `test/adapters/claude-code/*.test.ts`, fixtures `test/fixtures/claude-code/project/`, `test/fixtures/claude-code/home/`

**Interfaces:**
- Consumes: `mergeInstructions`, `splitInstructions`, `factsToProse`, `Adapter`
- Produces:
  - `claudePaths(ctx): { projectDir: string; projectAgents: string; projectSkills: string; userDir: string; userAgents: string; userSkills: string; memoryDir(projectDir: string): string }` — `projectDir = ctx.sourceDir ?? ctx.targetDir ?? ctx.cwd`; `projectAgents = <projectDir>/.claude/agents`; `projectSkills = <projectDir>/.claude/skills`; `userDir = ctx.env.CLAUDE_CONFIG_DIR ?? <home>/.claude`; `memoryDir(p) = <userDir>/projects/<sanitize(p)>/memory` gdzie `sanitize` zamienia każdy znak spoza `[A-Za-z0-9]` na `-` (przypięte: `C:\dev\OpenSI` → `C--dev-OpenSI`, `/home/u/proj` → `-home-u-proj`); builder potwierdza regułę na aktualnym Claude Code i aktualizuje test, jeśli się różni
  - `parseAgentFile(text): { name: string; description?: string; tools?: string[]; model?: string; body: string }` (yaml frontmatter; `tools` jako lista lub string po przecinkach); `renderAgentFile(a): string`
  - `read(ctx, agent)`: `agent` = nazwa pliku bez `.md` (najpierw projekt, potem user); `instructions`/`persona` ← `splitInstructions(body)`; `name` ← frontmatter `name`; `title` ← `description` (≤ 120); `models` ← `model` → `[{ runtime: "claude-code", provider: "anthropic", model }]` (`inherit`/brak → `[]` + warning); `capabilities` ← z `tools` (`Bash`→`shell`, `Read|Write|Edit|Glob|Grep`→`filesystem`, `WebFetch|WebSearch`→`network`, nazwy zaczynające się od `mcp__claude-in-chrome|Browser`→`browser`) + `approximated`; `skills` ← wszystkie `projectSkills/*` (warning `"Claude Code skills are project-wide; all were exported"`); `facts` ← punkty z `memoryDir/MEMORY.md`; `notes` ← inne `memoryDir/*.md`; `x-claude-code` ← `{ tools, model, scope: "project" | "user" }`; `routines: []`, `avatar` brak
  - `write(ctx, bundle, opts)`: plik `projectAgents/<slug>.md` (konflikt: `update` nadpisuje, `copy` → `<slug>-2.md`, `replace` = update); frontmatter `name`, `description` ← `title ?? pierwsze zdanie instrukcji ≤ 120`, `model` ← `models.find(m => m.provider === "anthropic")?.model` (brak → pole pominięte), `tools` ← `x-claude-code.tools` gdy jest; body ← `mergeInstructions(persona, instructions)`; skille → `projectSkills/<name>/` (konflikt → `-2`); fakty → dopisane do `memoryDir/MEMORY.md` jako `- fakt` (bez duplikatów), notatki → `memoryDir/imported-<slug>-<note>.md`; rutyny → `skipped` z `"Claude Code has no file-based routines"`; avatar → `skipped`; `outcome: "done"`
  - `capabilities`: persona, instructions, skills, facts, notes, models `true`; routines, files, avatar `false`; schedules `[]`
  - `detect`: `.claude/` w `projectDir` lub `userDir` istnieje; `version` z `claude --version` gdy w PATH; `hint: "Pass --source-dir <project with .claude/agents>"`
  - `list`: pliki `*.md` z `projectAgents` (scope project) i `userAgents` (scope user), `location` = ścieżka

- [ ] **Step 1: Fixtures** — `project/.claude/agents/reviewer.md` (frontmatter `name: reviewer`, `description`, `tools: Read, Grep, Bash`, `model: claude-opus-5-5`, body z `# Persona` i `# Instructions`), `project/.claude/agents/plain.md` (bez `model`, body bez nagłówków), `project/.claude/skills/web-brief/SKILL.md`; `home/.claude/projects/<sanitize(projectDir fixture)>/memory/MEMORY.md` (2 punkty) i `memory/2026-10-20.md`.
- [ ] **Step 2: Failing tests** — `read("reviewer")`: `persona` i `instructions` rozdzielone, `models[0].model === "claude-opus-5-5"`, `capabilities` zawiera `shell` i `filesystem`, `facts.length === 2`, `skills` == `["web-brief"]`; `read("plain")`: `models === []` + warning, `persona` undefined; `sanitize` dla 3 ścieżek; `write` Ady → `reviewer`-like plik z frontmatterem i body, `MEMORY.md` dopisany bez duplikatów, `routines` w `skipped` z powodem, drugi `write` z `copy` → `ada-2.md`; `write` nigdy nie dotyka `<home>/.claude` poza `memoryDir` celu.
- [ ] **Step 3–5:** FAIL → implement → PASS. Zarejestruj w `registry.ts`.
- [ ] **Step 6: Commit** `feat(claude-code): read and write adapter`

---

### Task 11: Adapter OpenClaw — zapis

**Files:**
- Create: `src/adapters/openclaw/write.ts`
- Modify: `src/adapters/openclaw/index.ts`, `src/adapters/openclaw/cli.ts`
- Test: `test/adapters/openclaw/write.test.ts`

**Interfaces:**
- Consumes: `OpenClawCli`, `toOpenClawFlags`, `factsToProse`, `scanSecrets`
- Produces `writeOpenClawAgent(ctx, bundle, opts): Promise<WriteResult>` — (1) `agentId` = slug nazwy (`[a-z0-9-]`, ≤ 32); konflikt w `agentsList()`: `update` → pisz do istniejącego workspace, `copy` → `<id>-2`, `replace` → update + usunięcie jobów tego agenta; bez flagi i bez dopasowania `manifest.id` w `x-openteleport` celu → `copy` + warning; (2) nowy → `agentsAdd(id, <stateDir>/workspace-<id>)`; (3) pliki: `SOUL.md` ← persona (brak → nie twórz), `AGENTS.md` ← instrukcje, `IDENTITY.md` ← `- **Name:** <name>`, `- **Emoji:** <x-openclaw.identity.emoji ?? "🤖">`, `- **Avatar:** avatars/<file>` gdy avatar, `MEMORY.md` ← `factsToProse(facts)` + notatki `MEMORY-prose`, `memory/<name>.md` ← pozostałe notatki, `skills/<name>/**`, `avatars/<avatar>`; (4) `setIdentity(id, { name, emoji, avatar })`; (5) model: pierwszy `models[]` z `provider` i `model` → `configSet("agents.entries.<id>.model", "<provider>/<model>")`; gdy `configSet` zwraca `false` → json5 rewrite `openclaw.json` z kopią `openclaw.json.bak-<timestamp>` i warning `"openclaw.json rewritten; comments may be lost"`; `runtime` ∈ {codex, claude-code, gemini-cli, opencode, cursor, cline} → `agents.entries.<id>.runtime = { type: "acp", acp: { agent: <nazwa ACP wg docs/tools/acp-agents.md OpenClaw, builder wpisuje mapę> } }`; (6) rutyny: `automationsAdd(["--name", r.name, ...toOpenClawFlags(r.schedule, r.timezone), "--message", r.instruction, "--agent", id, "--session", "isolated"])`, potem `automationsDisable(jobId)` gdy `!(opts.enableRoutines && r.enabled)`; (7) gateway działa (`openclaw gateway status --json` ok) → warning `"Restart the Gateway to load the new agent: openclaw gateway restart"`; `outcome: "done"`, `targetAgentId: id`; defensywnie: `scanSecrets` przed zapisem plików → trafienie = błąd bez zapisu

- [ ] **Step 1: Failing tests** (`ctx.exec` = rejestrator + stuby) — po zapisie Ady: workspace ma `SOUL.md`, `AGENTS.md`, `IDENTITY.md`, `MEMORY.md` (zaczyna się od `- The user reports in EUR.`), `memory/2026-10-20.md`, `skills/web-brief/SKILL.md`; wywołania w kolejności: `agents add ada --workspace … --non-interactive --json`, `agents set-identity …`, `config set agents.entries.ada.model anthropic/claude-opus-5-5`, `automations add --name "Morning digest" --cron "30 8 * * 1-5" --tz Europe/Warsaw --message … --agent ada --session isolated`, `automations disable <id>`; `enableRoutines:true` → brak `disable`; konflikt bez flagi → `ada-2` + warning; `configSet` zwracający `false` → `openclaw.json.bak-*` istnieje i warning; token w instrukcjach → błąd, zero plików; `targetDir` → każde `exec` ma `OPENCLAW_STATE_DIR === targetDir`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(openclaw): write adapter via CLI and workspace files`

---

### Task 12: Polecenia CLI

**Files:**
- Create: `src/commands/shared.ts`, `export.ts`, `import.ts`, `move.ts`, `inspect.ts`, `validate.ts`, `list.ts`
- Modify: `src/cli.ts`, `src/index.ts`
- Test: `test/commands/*.test.ts` (`dist/cli.js` przez `execaNode`, `OPENTELEPORT_HOME` tymczasowy, `OPENTELEPORT_TEST_ADAPTER=1` rejestruje adapter `memory`)

**Interfaces:**
- Produces polecenia (wspólne: `--source-dir <path>`, `--target-dir <path>`, `--json`, `--quiet`):
  - `list --from <adapter>` → tabela `id | name | location`
  - `export --from <adapter> --agent <id|name> [--out <file.jetpack>] [--include-files]` → plik + `move-report.md`; brak `--agent` w TTY → `@clack/prompts` `select` z `list()`; poza TTY → kod 2 `Missing --agent. Available: …`
  - `import --to <adapter> <file.jetpack|folder> [--enable-routines] [--include-files] [--replace|--copy]`; `handoff` → `Next step:` na stdout, kod 0
  - `move --from <a> --to <b> --agent <x> [te same flagi] [--keep <file.jetpack>]`
  - `inspect <file|folder>` → nazwa, id, modele, liczby (skills, routines, facts, notes, files), rozmiar
  - `validate <file|folder>` → schemat + ścieżki + sekrety; kod 0/1
  - `adapters` → lista adapterów z `detect()` dla każdego (`found`, `location`, `version`)
  - Kody: 0 OK (także `handoff`), 1 walidacja/sekrety, 2 zły argument, 3 adapter nie wykrył aplikacji (komunikat z `hint`)
  - `src/index.ts` eksportuje `readBundle, writeBundle, move, exportBundle, importBundle, getAdapter, listAdapters, registerAdapter, scanSecrets, parseManifest` i typy

- [ ] **Step 1: Failing tests** — `export` z `memory` tworzy `.jetpack` i `move-report.md`; `import` bundle z `sk-ant-…` → kod 1, stderr `AGENTS.md:`; `import` dwa razy bez flag → `ada-2` + warning (Review Focus 2); `move --json` → stdout parsuje się jako `MoveReport`; `list --from nope` → kod 2 z listą; `export` bez `--agent` poza TTY → kod 2; `validate` fixture Ady → 0; `inspect` fixture folderu bez manifestu → działa, drukuje `skills: 1`; `adapters` → 3 wiersze (`folder`, `openclaw`, `claude-code`) + `memory`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(cli): export, import, move, inspect, validate, list, adapters`

---

### Task 13: Round-trip na prawdziwych instalacjach, demo, README

**Files:**
- Create: `test/e2e/roundtrip.test.ts` (tylko z `OPENTELEPORT_E2E=1`), `scripts/demo.sh`, `scripts/demo.ps1`, `docs/demo.md`
- Modify: `README.md`

- [ ] **Step 1: `test/e2e/roundtrip.test.ts`** — wymaga `openclaw` w PATH i tymczasowego `OPENCLAW_STATE_DIR` po `openclaw onboard --non-interactive` (builder dobiera flagi z `docs/cli/onboard.md`): (a) `move --from claude-code --source-dir test/fixtures/claude-code/project --to openclaw --target-dir <tmp> --agent reviewer` → `openclaw agents list --json` zawiera `reviewer`; (b) `move --from openclaw --source-dir <tmp> --to folder --target-dir <tmp2> --agent reviewer` → katalog z `AGENTS.md`; (c) `export --from folder --source-dir <tmp2>/reviewer` → bundle równy (a) poza polami z `report.approximated` (porównanie `name`, `instructions`, `facts`, `skills[].name`).
- [ ] **Step 2: `scripts/demo.sh` / `demo.ps1`** — pięć agentów z projektu Claude Code: `openteleport list --from claude-code`, pętla `move` do OpenClaw, `openclaw agents list`, jeden `move` z powrotem do `folder`, otwarcie `move-report.md`. `docs/demo.md`: scenariusz 60 s (problem, jedno polecenie, raport, trzy narzędzia).
- [ ] **Step 3: README** — What it does; Install (`npx openteleport`); Usage (3 polecenia); Supported apps (tabela: adapter | read | write | notes; wiersze `folder`, OpenClaw, Claude Code; sekcja "Coming next": OpenBot, Hermes, Codex, Grok Bot, Letta); The `.jetpack` format ("an unzipped .jetpack is a working agent folder for any AGENTS.md-aware tool", link do `schema/`); Remote installs (export → copy → import); Safety (sekrety, rutyny wyłączone, źródło nietykane); Contributing an adapter (interfejs z Task 7, fixture'y, checklista); Not affiliated.
- [ ] **Step 4: Run** `OPENTELEPORT_E2E=1 npx vitest run test/e2e` na maszynie z OpenClaw → PASS; wersje OpenClaw i Claude Code do `docs/demo.md`.
- [ ] **Step 5: Commit** `docs: README, demo script, e2e round-trip`

---

### Task 14: Publikacja i plugin OpenClaw

**Files:**
- Create: `.github/workflows/release.yml`, `CHANGELOG.md`, `docs/openclaw-plugin.md`
- Modify: `package.json` (`publishConfig: { access: "public" }`, `repository`, `homepage: "https://openteleport.dev"`, `keywords`)

- [ ] **Step 1: `release.yml`** — na tag `v*`: `npm ci`, `build`, `test`, `npm publish --provenance` (`NPM_TOKEN` jako secret organizacji albo trusted publishing).
- [ ] **Step 2: `docs/openclaw-plugin.md`** — propozycja pluginu wg `docs/plugins/building-plugins.md` OpenClaw: polecenia `openclaw agents export <id>` / `openclaw agents import <file.jetpack>` wołające `openteleport` jako bibliotekę; tekst gotowy do issue jako "fresh focused design proposal" z linkiem do zamkniętego #97885.
- [ ] **Step 3: `CHANGELOG.md`** — `0.1.0`: format `.jetpack` 0.1; adaptery `folder`, OpenClaw (read/write przez CLI), Claude Code (read/write).
- [ ] **Step 4: Weryfikacja** — `npm pack --dry-run` listuje tylko `dist`, `schema`, `README.md`, `LICENSE`; `npx openteleport --version` z tarballa w pustym katalogu → `0.1.0`.
- [ ] **Step 5: Commit** `chore: release workflow, changelog, OpenClaw plugin proposal`; tag `v0.1.0` po decyzji właściciela.

---

## Self-review

- **Pokrycie spec:** sekcja 6 → Task 12, 5; sekcja 7 (układ na standardach, manifest opcjonalny, sekrety) → Task 2, 3, 4, 8; sekcja 8 (warstwy, adaptery folder/OpenClaw/Claude Code, fixture'y) → Task 7–11, 13; sekcja 12 pkt 1 (lokalnie, `--source-dir/--target-dir`) → Task 8–12; pkt 2 (`done`/`handoff`) → Task 7, 11; pkt 3 (id, konflikt) → Task 7, 8, 10, 11, 12; pkt 4 (rutyny wyłączone) → Task 8, 11; pkt 5 (`files/`, 100 MB) → Task 3, 7; pkt 6–8 → Task 2, 6, 9–11; pkt 9 (OpenBot v0.2) → Załącznik A; sekcja 9 → Task 1, 14; sekcja 10 → Task 13, 14. Hermes, Codex, Grok Bot, Letta poza v0.1 zgodnie ze spec.
- **Spójność nazw:** `Bundle`, `Manifest`, `Schedule`, `Routine`, `Note`, `Adapter`, `Ctx`, `WriteOpts`, `WriteResult`, `MoveReport`, `Item`, `ensureId`, `toOpenClawFlags`, `fromOpenClawJob`, `mergeInstructions`, `splitInstructions`, `factsToProse` używane jednakowo w Task 2–12.
- **Review Focus:** 1 → Task 4, 11, 12; 2 → Task 8, 10, 11, 12; 3 → Task 7, 10, 11; 4 → Task 8, 9, 10; 5 → Task 10.
- **Proporcja:** sygnatury i testy, nie ciała funkcji; jedyne stałe treści to układy plików narzucone przez narzędzia zewnętrzne.

---

## Załącznik A: notatki do adaptera OpenBot (v0.2)

Zebrane 27.10.2026 z repo `nightly-labs/openbot` (licencja PolyForm Noncommercial; czytanie formatów danych nie jest użyciem kodu).

- **Ścieżki:** workspace `~/OpenBot/Agents/<agentId>`; dane aplikacji w Electron `userData` (`%APPDATA%\OpenBot`, `~/Library/Application Support/OpenBot`, `~/.config/OpenBot`): baza SQLite (nazwa pliku w `src/backend/openbot-database.ts`), `local-skills/<id>/<rewizja>/` (SKILL.md lub `bundle.zip`); skille wspólne w `~/.agents/skills/<slug>`.
- **Baza (`src/backend/openbot-database-schema.ts`):** `projection_agents(agent_id, model, agent_json)` z `agent_json` → `name, title, description (instrukcje), provider, model, reasoningEffort, avatarSeed, avatarHue, avatar, workspacePath, notifications` (typ `AgentSummary` w `packages/contracts/src/ipc-agents.ts`); `projection_agent_memories(agent_id, text, origin)`; `projection_agent_routines(routine_id, agent_id, name, instruction, active, timezone)`; `projection_routine_triggers(routine_id, schedule_json)`. Odczyt z kopii pliku (+ `-wal`, `-shm`) przez `node:sqlite` w trybie read-only.
- **Zapis (import):** zip `openbot-agent-import` v1: `openbot-import.json` (`format`, `version: 1`, `source: { app, exportedAt }`, `agents[]`: `key` (slug ≤ 64), `name` ≤ 80, `title` ≤ 120, `description` ≤ 2 000 (dłuższe: pełny tekst w `agents/<key>/files/INSTRUCTIONS.md`), `avatar`, `skills` (≤ 32 ścieżek `agents/<key>/skills/<name>`), `routines` (≤ 64: `name`, `instruction`, `active`, `timezone`, `schedule`), `memories` (≤ 64 × 500), `files`; `channels` opcjonalne). Import w aplikacji: Server settings → Import (`handoff`). Bezgłowo: Team API `POST /v1/agent-import/stage` (raw zip ≤ 100 MB) → `apply { token, keys, channelKeys, timezone }` → `discard` (`packages/contracts/src/team-protocol/agent-import-v1.ts`), wymaga sesji członka; sprawdzić dostępność lokalnie (`docs/architecture/team-api.md`).
- **Odczyt (transfer instancji):** zip z `openbot-transfer.json` (`format: "openbot-instance-transfer"`, `version: 1`; `src/main/instance-transfer-manifest.ts`): `agents[]` z `key, name, title, description, avatarSeed, avatarHue, avatar, provider, model, reasoningEffort, notifications, skills, files, routines[] (key, name, instruction, active, timezone, schedule, limitPolicy, missedPolicy), oneTimeRoutines[], memories[] ({ text, inclusion })`; `settings` (`mcpServers` bez sekretów, `customProviders`); `shared/`.
- **Harmonogramy OpenBota:** `hourly{minute}`, `daily{time}`, `weekdays{time}`, `weekly{weekday 0-6,time}`, `monthly{day,time}`, `interval{amount,unit: minutes|hours|days}` (min. 3 minuty), `custom{expression}`; mapowanie na `Schedule`: hourly→`M * * * *`, daily→`m h * * *`, weekdays→`m h * * 1-5`, weekly→`m h * * W`, monthly→`m h D * *`, interval→`every`, custom→cron; `at` nie ma odpowiednika (poza `oneTimeRoutines` w transferze).
- **Provider → runtime:** `codex`→`codex`, `claude`→`claude-code`, `gemini`→`gemini-cli`, `grok`→`grok-cli`, `opencode`→`opencode`, `cursor`→`cursor`, `cline`→`cline`.
- **Uwaga:** OpenBot importuje też z Hermesa (`src/main/hermes-import-reader.ts`) — źródło wiedzy o układzie `~/.hermes` dla adaptera Hermes.
