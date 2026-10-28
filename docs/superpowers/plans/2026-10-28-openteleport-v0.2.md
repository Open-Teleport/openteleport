# OpenTeleport v0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pięć nowych adapterów (`hermes`, `codex`, `openbot`, `grok-bot`, `letta`), kreator po `npx openteleport` bez argumentów, domyślny bieżący katalog dla `export`/`import`, pomoc podstawowa i pełna, dwie poprawki z v0.1.

**Architecture:** Nowe adaptery są czysto plikowe (żadnych binarnych plików aplikacji), każdy we własnym katalogu `src/adapters/<name>/` z testami w `test/adapters/<name>/`. Wspólne części wyciągnięte z v0.1 do `src/adapters/marker.ts` (znacznik tożsamości) i `src/core/zip.ts` (bezpieczny czytnik zipów); format zipa OpenBota w `src/formats/openbot-zip.ts` obsługuje `openbot` i `grok-bot`. `done` tylko tam, gdzie aplikacja zobaczy agenta po samym zapisie plików (Hermes, Codex); OpenBot, Grok Bot i Letta zwracają `handoff` z artefaktem i jednym następnym krokiem.

**Tech Stack:** TypeScript 5 strict, Node.js 24 LTS, ESM, npm; tsup, vitest, commander, @clack/prompts, zod 4, fflate, yaml, json5, ulid, execa; nowe: `smol-toml` (Codex), wbudowany `node:sqlite` (OpenBot, import leniwy).

**Spec:** `docs/superpowers/specs/2026-10-28-openteleport-v0.2-design.md` (dalej „spec"; numery sekcji odnoszą się do niego). Research: `docs/superpowers/research/2026-10-28-v0.2-adapters-research.md`. Notatki o OpenBocie: Załącznik A w `docs/superpowers/plans/2026-10-27-openteleport-v0.1.md`.

## Global Constraints

- Obowiązują Global Constraints planu v0.1 (`docs/superpowers/plans/2026-10-27-openteleport-v0.1.md`), w szczególności: TypeScript strict bez `any`; ESM z rozszerzeniami `.js` w importach; testy nigdy nie dotykają prawdziwego katalogu domowego (każdy test buduje `Ctx` z `home` i `cwd` w `mkdtemp`); żaden test ani adapter nie uruchamia prawdziwego `openclaw`, `claude`, `hermes`, `codex`, `letta`, `grok` (testy CLI mają pusty `PATH`); `read` nigdy nie modyfikuje źródła; sekrety blokują zapis; rutyny lądują wyłączone; `files/` tylko z `--include-files`; limity formatu z `src/core/paths.ts` (32 skille, 64 rutyny, 500 znaków faktu, 512 KB awatara, 100 MB `files/`, 2 MiB na plik tekstowy); nic nie jest zapisywane przez dowiązanie symboliczne (`lstat` przed zapisem); zapisy plików, które aplikacja sama utrzymuje, są atomowe (plik tymczasowy w tym samym katalogu + `rename`).
- Rulingi v0.1 wiążące dla v0.2 (kod v0.1 jest formą obowiązującą, spec sekcja 3): `update` pisze w miejsce tylko nad agentem o tym samym id (dowód ze znacznika); inny agent o tej samej nazwie dostaje `-N` z ostrzeżeniem; `replace` usuwa tylko to, co OpenTeleport sam zapisał, inaczej odmawia z komunikatem „Refusing to replace ...: ...; delete it yourself if you mean it"; `copy` zawsze `-N`; nigdy nie usuwa się skilli w katalogu współdzielonym; raport mówi prawdę: `moved` = dostarczone minus pominięte przez adapter; każde przybliżenie ma wpis `approximated` z polem i powodem; ostrzeżenia to pełne zdania bez stosu wywołań; komunikaty użytkownika po angielsku, bez myślników typograficznych i bez emoji.
- Ledger v0.1 (rulingi z przeglądów) leży na tej maszynie w `C:\Users\nadru\AppData\Local\Temp\claude\C--dev-OpenSI\7c6f60b0-c867-457a-8860-21895c645e2b\scratchpad\sdd-ledger-openteleport-v0.1\progress.md`; wykonawca czyta go, gdy ma wątpliwość co do reguły, ale gdy ledger i kod się różnią, obowiązuje kod.
- Nowe adaptery czytają katalog domowy aplikacji wyłącznie z `ctx.home`, `ctx.env` i `ctx.sourceDir`/`ctx.targetDir` (spec 3.2, 3.3); `--source-dir`/`--target-dir` mają pierwszeństwo przed zmiennymi środowiska.
- Dane bez odpowiednika w `Bundle` idą do `x-<vendor>` w manifeście; dodatkowe pola rutyn do `x-<vendor>.routines["<nazwa>"]` (spec 3.8).
- Limity aplikacji są egzekwowane przy zapisie; pominięty fakt to `{ field: "fact:<n>", detail: "<60 znaków>… (<powód>)" }` (spec 3.12).
- Fixture'y odtwarzają układy z researchu; każdy katalog fixture'a ma `README.md` z numerami źródeł (spec 3.13).
- Commity: conventional commits (`feat(hermes): ...`, `test(codex): ...`, `fix(cli): ...`, `docs: ...`), autor i committer `Story91 <tvkonflikt@gmail.com>` (konfiguracja repozytorium), **bez żadnych stopek `Co-Authored-By` ani innych stopek atrybucji** (CONTRIBUTING.md).
- Każde zadanie kończy się zielonym `npm run lint && npm test` (pełny zestaw, nie tylko nowe pliki) i commitem; gałąź integracyjna to `v0.2`, zadania równoległe pracują w osobnych worktree na gałęziach `v0.2/task-N`.
- Rejestracja adaptera: każde zadanie adaptera dodaje własną linię `registerAdapter(...)` w `src/adapters/index.ts` i rozszerza oczekiwaną listę nazw w `test/commands/adapters.test.ts`; kolejność docelowa (`folder`, `openclaw`, `claude-code`, `hermes`, `codex`, `openbot`, `grok-bot`, `letta`) jest ustalana raz w zadaniu 9.

## Review Focus

Pięć wejść, których spec nie opisuje wprost, a które najpewniej trafią użytkownika; każde ma test w zadaniu, które jest za nie odpowiedzialne:

1. **Plik aplikacji z BOM UTF-8 lub CRLF** (`SOUL.md`, `memories/MEMORY.md`, `AGENTS.md`, `persona.md`): odczyt musi dać ten sam tekst co bez BOM, a podział `splitInstructions` musi działać z `\r\n` → test w zadaniach 3, 4, 5.
2. **Nazwa agenta, która po slugowaniu jest pusta lub koliduje z nazwą zarezerwowaną** (np. `***`, `default`, `profiles`): zapis odmawia jasnym błędem, nie tworzy `profiles/` ani `agents/.toml` → test w zadaniach 3 i 4.
3. **`cron/jobs.json` lub `crons.json`, który nie jest poprawnym JSON** (uszkodzony plik): `read` zgłasza ostrzeżenie i czyta resztę profilu; `write` odmawia nadpisania z błędem nazywającym plik, zamiast zastąpić go pustą listą → test w zadaniach 3 i 5.
4. **Zip OpenBota z agentem, którego `key` zawiera `..` lub ukośnik, albo ze ścieżką skilla poza `agents/<key>/`**: odrzucony z błędem, nic nie jest wypakowane → test w zadaniu 2.
5. **Kreator przerwany Ctrl+C na dowolnym pytaniu** oraz **uruchomiony bez TTY** (CI, potok): nic nie jest zapisane, kod 0 po anulowaniu, pomoc i kod 2 bez TTY → test w zadaniu 8.

---

### Task 1: Fundamenty: znacznik, czytnik zipów, `createsOnWrite`, fakty w raporcie, dwie poprawki, zależności

Sekwencyjne; wszystko dalej buduje na tym zadaniu. Nie zmienia zachowania adapterów v0.1: ich testy przechodzą bez zmian w fixture'ach.

**Files:**
- Create: `src/adapters/marker.ts`, `src/core/zip.ts`, `test/adapters/marker.test.ts`, `test/core/zip.test.ts`, `test/helpers/zip.ts`
- Modify: `src/adapters/types.ts`, `src/adapters/folder/index.ts`, `src/commands/shared.ts`, `src/core/engine.ts`, `src/core/bundle.ts`, `src/core/schedule.ts`, `src/adapters/openclaw/write.ts`, `src/adapters/openclaw/read.ts`, `src/adapters/claude-code/write.ts`, `src/adapters/claude-code/read.ts`, `package.json`, `package-lock.json`, `test/helpers/cli.ts`, `test/core/engine.test.ts`, `test/core/schedule.test.ts`, `test/commands/shared.test.ts`, `test/commands/validate.test.ts`

**Interfaces:**
- Produces `src/adapters/marker.ts`:
  - `export const MARKER_FILE = ".openteleport.json"`
  - `export type Marker = { id: string; movedAt: string } & Record<string, unknown>`
  - `export async function readMarker(dir: string): Promise<Marker | undefined>` (brak pliku, dowiązanie, niepoprawny JSON, brak łańcucha `id` → `undefined`; nigdy nie rzuca dla tych przypadków)
  - `export async function carriesMarker(dir: string, id: string): Promise<boolean>` (`id === ""` → `false`)
  - `export function renderMarker(marker: Marker): string` (JSON z wcięciem 2 i końcowym `\n`)
  - `export async function writeMarker(dir: string, marker: Marker): Promise<void>` (atomowo; gdy `<dir>/.openteleport.json` istnieje i nie jest zwykłym plikiem, rzuca `Error` z „is not a regular file")
  - `export type AgentIds = Record<string, string>`, `export async function readIds(path: string): Promise<AgentIds>`, `export async function recordId(path: string, slug: string, id: string, items: { warnings: string[] }): Promise<void>` (przeniesione z `claude-code/write.ts` bez zmiany zachowania; `claude-code` importuje je stąd)
- Produces `src/core/zip.ts`:
  - `export type ZipEntryKind = "text" | "file" | "unknown"`
  - `export type ZipPolicy = { kindOf(path: string): ZipEntryKind; validate(listing: readonly { path: string; size: number }[]): void }`
  - `export async function readZipEntries(source: string, archiveBytes: number, policy: ZipPolicy): Promise<FileEntry[]>` (dwa przebiegi jak dziś: `unknown` nie jest inflowane i dostaje puste bajty; `text` ≤ `MAX_TEXT_ENTRY_BYTES` skompresowane; stored entry: `compressedSize === size`; suma skompresowanych ≤ rozmiar pliku; `archiveBytes > MAX_ARCHIVE_BYTES` → błąd)
  - `export function unzipOrThrow<T>(source: string, run: () => T): T`
  - `bundle.ts` woła `readZipEntries` z polityką `{ kindOf: (p) => classify(p).kind === "file" ? "file" : classify(p).kind === "unknown" ? "unknown" : "text", validate: validateListing }`.
- Produces w `src/adapters/types.ts`: `Adapter.createsOnWrite?: boolean` z komentarzem „`true`: `write` tworzy cel (plik lub katalog), więc instalacja aplikacji nie jest potrzebna po stronie celu".
- Produces w `src/core/schedule.ts`:
  - `export function everyToCron(every: string): string` (`30m` → `*/30 * * * *`, `2h` → `0 */2 * * *`, `3d` → `0 0 */3 * *`; `1m` → `* * * * *`, `1h` → `0 * * * *`, `1d` → `0 0 * * *`; wartość spoza wzorca rzuca jak `everyToMs`)
  - `export function zonedToInstant(local: string, timeZone: string): string | undefined` (`local` = `YYYY-MM-DDTHH:MM[:SS]` bez offsetu; wynik ISO UTC z `Z`; nieznana strefa lub niepoprawna data → `undefined`; algorytm: potraktuj składniki jako UTC, odczytaj offset strefy dla tego instantu przez `Intl.DateTimeFormat(..., { timeZone, hourCycle: "h23" }).formatToParts`, odejmij, powtórz raz dla brzegu zmiany czasu)
- Produces w `test/helpers/zip.ts`: `export async function zipDirectory(dir: string): Promise<Uint8Array>` (fflate `zipSync`, ścieżki `/`-separowane, bez katalogów-wpisów) i `export async function zipDirectoryToFile(dir: string, file: string): Promise<string>`.
- Produces w `test/helpers/cli.ts` (`run`): do środowiska dochodzą `HERMES_HOME: join(box.home, ".hermes")`, `CODEX_HOME: join(box.home, ".codex")`, `APPDATA: join(box.home, "AppData", "Roaming")`, `LOCALAPPDATA: join(box.home, "AppData", "Local")`, `LETTA_LOCAL_BACKEND_DIR: undefined`, `HERMES_TIMEZONE: undefined`.
- Produces: zależność `smol-toml@^1.9` w `dependencies`.

- [ ] **Step 1: Test znacznika**

`test/adapters/marker.test.ts`: `readMarker` zwraca `{ id, movedAt }` z poprawnego pliku; `undefined` dla braku pliku, dla `"not json"`, dla `{ "id": 5 }`, dla dowiązania symbolicznego do poprawnego pliku (pomiń test, gdy system nie pozwala tworzyć dowiązań, jak `canSymlink` w `test/adapters/openclaw/write.test.ts`); `carriesMarker(dir, "")` → `false`; `writeMarker` zostawia dokładnie jeden plik (brak `*.tmp`) i rzuca „is not a regular file", gdy w miejscu pliku jest katalog; `readIds`/`recordId` zachowują się jak dotychczasowe testy w `test/adapters/claude-code/write.test.ts` (przenieś te przypadki tutaj, zostawiając w claude-code testy zachowania adaptera).

- [ ] **Step 2: Uruchom test, oczekiwany FAIL** (`npx vitest run test/adapters/marker.test.ts`, „Cannot find module")

- [ ] **Step 3: Zaimplementuj `src/adapters/marker.ts`** i przełącz `openclaw/write.ts` (`carriesMarker`, zapis przez `renderMarker` + istniejące `writeInside`), `openclaw/read.ts` (`markerId` → `(await readMarker(dir))?.id ?? ""`), `claude-code/write.ts` i `read.ts` (import `readIds`/`recordId` z `../marker.js`; `idsFileOf` zostaje w claude-code).

- [ ] **Step 4: Test czytnika zipów**

`test/core/zip.test.ts`: zip zbudowany w teście (`test/helpers/zip.ts` + `zipSync` dla przypadków specjalnych): wpis `unknown` dostaje puste bajty i nie jest inflowany (polityka liczy wywołania `kindOf`); wpis `text` powyżej `MAX_TEXT_ENTRY_BYTES` skompresowanych → błąd z „limit for entries outside files/"; polityka `validate` dostaje pełną listę ścieżek z rozmiarami i jej wyjątek przerywa odczyt przed inflowaniem; `unzipOrThrow("x.zip", () => { throw new Error("bad") })` → „x.zip is not a valid zip archive: bad".

- [ ] **Step 5: Uruchom test, oczekiwany FAIL**

- [ ] **Step 6: Zaimplementuj `src/core/zip.ts`** przez przeniesienie `unzip`, `ZipRecord`, `validateZipRecords`, `readZipEntries` z `src/core/bundle.ts` i uogólnienie przez `ZipPolicy`; `bundle.ts` woła nową funkcję. `npx vitest run test/core` zielone, w tym `bundle.test.ts` bez zmian.

- [ ] **Step 7: Test `createsOnWrite`**

`test/commands/shared.test.ts`: `ensureDetected(adapter, ctx, "target")` nie woła `detect`, gdy `adapter.createsOnWrite === true`; woła i rzuca `NotDetectedError`, gdy pole jest `false` lub nieobecne i `found: false`; po stronie `source` zawsze woła. `folderAdapter.createsOnWrite === true`.

- [ ] **Step 8: Zaimplementuj**: pole w `types.ts`, `createsOnWrite: true` w `folder/index.ts`, w `shared.ts` zbiór `CREATED_ON_WRITE` zastąpiony sprawdzeniem pola.

- [ ] **Step 9: Test faktów w raporcie**

`test/core/engine.test.ts`: adapter pamięciowy, którego `write` zwraca `skipped: [{ field: "fact:2", detail: "..." }]` dla bundle'a z trzema faktami → raport `moved` ma `{ field: "memory.facts", detail: "2 facts" }` (dokładny tekst wg istniejącego `counted`); z trzema pominiętymi → brak wpisu faktów w `moved`; pominięcie `fact:9` (spoza zakresu) nie zmniejsza liczby.

- [ ] **Step 10: Zaimplementuj** w `engine.ts`: wpis `FIELDS` dla faktów dostaje `parts: { prefix: "fact", noun: "fact", names: (b) => b.facts.map((_, i) => String(i + 1)) }` (sprawdź, jak `FIELDS` nazywa etykietę i rzeczownik, i zachowaj dotychczasowy tekst dla przypadku bez pominięć).

- [ ] **Step 11: Testy dwóch poprawek**

`test/commands/validate.test.ts`: `validate` niepoprawnego pliku z zamkniętym stdout (uruchom CLI z `stdout: "pipe"` i zamknij strumień po pierwszym bajcie, albo przez potok do procesu kończącego się od razu; wzorzec w istniejącym teście EPIPE, jeśli jest) kończy się kodem 1. `test/core/engine.test.ts`: adapter pamięciowy z `cacheIdentity` liczącym wywołania; `move` agenta z pustym `manifest.id` → 1 wywołanie; z ustawionym id → 0.

- [ ] **Step 12: Zaimplementuj**: `exitOnBrokenPipe` → `process.exit()`; `withId` woła `cacheIdentity` tylko gdy `bundle.manifest.id === ""`.

- [ ] **Step 13: `everyToCron` i `zonedToInstant` z testami** w `test/core/schedule.test.ts`: `everyToCron` dla sześciu wartości z Interfaces; `zonedToInstant("2026-11-01T09:30", "Europe/Warsaw")` → `"2026-11-01T08:30:00.000Z"`; `("2026-07-01T09:30", "Europe/Warsaw")` → `"2026-07-01T07:30:00.000Z"`; `("2026-03-29T02:30", "Europe/Warsaw")` (godzina nieistniejąca) → wynik w `03:30` lub `01:30` lokalnie, ale zdefiniowany (test sprawdza, że nie `undefined`); `("2026-11-01T09:30", "Mars/Olympus")` → `undefined`; `("2026-02-30T09:30", "UTC")` → `undefined`.

- [ ] **Step 14: Zależności i helpery testowe**: `npm install smol-toml@^1.9`; `test/helpers/zip.ts`; zmienne w `test/helpers/cli.ts` (`run`). Sprawdź, że `import("node:sqlite")` przechodzi `tsc` (`@types/node` ^24 ma `sqlite.d.ts`).

- [ ] **Step 15: `npm run lint && npm test`** zielone (1141 + nowe testy).

- [ ] **Step 16: Commit** w kilku krokach: `refactor(adapters): share the identity marker and the zip reader`, `feat(core): adapters may create their target on write`, `fix(report): skipped facts no longer count as moved`, `fix(cli): keep the exit code when stdout closes early`, `fix(engine): look up the cache identity only for agents without an id`, `feat(core): interval to cron and zoned time helpers`, `chore(test): sandbox env for the v0.2 adapters, zip helper, smol-toml`.

### Task 2: Harmonogramy OpenBota i moduł `src/formats/openbot-zip.ts`

Po zadaniu 1. Równolegle z 3, 4, 5, 8. Wymagane przez 6 i 7.

**Files:**
- Create: `src/formats/openbot-zip.ts`, `test/formats/openbot-zip.test.ts`, `test/fixtures/openbot/import-v1/**`, `test/fixtures/openbot/transfer-v1/**`, `test/fixtures/openbot/README.md`
- Modify: `src/core/schedule.ts`, `test/core/schedule.test.ts`

**Interfaces:**
- Consumes: `readZipEntries`, `unzipOrThrow` (Task 1); `zonedToInstant`, `msToEvery`, `everyToMs`, `parseCron` (`src/core/schedule.ts`); `isForbiddenPath`, `isSafeArchivePath`, limity z `src/core/paths.ts`; `FileEntry`, `Bundle`, `ModelPref`, `Routine` z `src/core/schema.ts`; `WriteResult["items"]` z `src/adapters/types.ts`.
- Produces w `src/core/schedule.ts`:
  - `export type OpenBotSchedule = { kind: "hourly"; minute: number } | { kind: "daily"; time: string } | { kind: "weekdays"; time: string } | { kind: "weekly"; weekday: number; time: string } | { kind: "monthly"; day: number; time: string } | { kind: "interval"; amount: number; unit: "minutes" | "hours" | "days"; anchorAt?: string } | { kind: "advanced"; months: number[]; days: number[]; time: string } | { kind: "custom"; expression: string } | { kind: "once"; date: string; time: string }`
  - `export function fromOpenBotSchedule(schedule: unknown, timezone: string): { schedule: Schedule; extra?: Record<string, unknown> } | null` (tabela w spec 9.2; `once` → `at` przez `zonedToInstant`; `interval.anchorAt` → `extra.anchorAt`; `custom` z wyrażeniem, którego `parseCron` nie przyjmuje → `null`; nieznany kształt → `null`)
  - `export function toOpenBotSchedule(schedule: Schedule): Exclude<OpenBotSchedule, { kind: "once" }> | null` (`at` → `null`; cron pięciopolowy rozpoznawany do `hourly`/`daily`/`weekdays`/`weekly`/`monthly`/`advanced`, inaczej `custom`; `every` → `interval` z największą jednostką, `every` poniżej 3 minut → `null`)
- Produces `src/formats/openbot-zip.ts`:
  - `export const OPENBOT_IMPORT_MANIFEST = "openbot-import.json"`, `export const OPENBOT_TRANSFER_MANIFEST = "openbot-transfer.json"`
  - `export type OpenBotZipFormat = "openbot-agent-import" | "openbot-instance-transfer"`
  - `export type OpenBotZipAgent = { key: string; bundle: Bundle }`
  - `export async function readOpenBotZip(file: string, opts?: { includeFiles?: boolean }): Promise<{ format: OpenBotZipFormat; agents: OpenBotZipAgent[]; warnings: string[] }>` (manifest `Bundle`: `schemaVersion "0.1"`, `id` = `x-openteleport.id` jeśli łańcuch ULID, inaczej `""`; `name`, `title`; `models` z `openBotModelPref`; `capabilities: []`; `origin: { app: source.app ?? "openbot", version: source.appVersion?, exportedAt }`; `x-openbot` wg spec 6.2 i 9.2; `instructions` = `description`, a gdy istnieje `agents/<key>/files/INSTRUCTIONS.md`, jego treść; `unknownPaths: []`)
  - `export function openBotModelPref(provider: unknown, model: unknown): ModelPref | undefined` (tabela runtime → provider ze spec 6.2)
  - `export function writeOpenBotImportZip(bundles: readonly Bundle[], opts: { app: string; version: string; includeFiles: boolean }): { bytes: Uint8Array; items: WriteResult["items"] }` (reguły i limity spec 9.3; `x-openteleport: { id, version }` w manifeście zipa)
  - Polityka zipa dla `readZipEntries`: `kindOf` = `file` dla `agents/<key>/files/**`, `unknown` dla `shared/**` i wszystkiego poza `agents/**` i manifestami, `text` dla reszty; `validate` odrzuca ścieżki, które nie są `isSafeArchivePath`, klucze spoza `[a-z0-9-]{1,64}`, ścieżki `avatar`/`skills`/`files` z manifestu, które nie zaczynają się od `agents/<key>/`, oraz sumę `files/` powyżej `MAX_FILES_BYTES`.

- [ ] **Step 1: Testy harmonogramów** w `test/core/schedule.test.ts`: `fromOpenBotSchedule` dla dziewięciu kształtów (wartości ze spec 9.2, np. `{kind:"weekly", weekday: 1, time: "09:00"}` → cron `0 9 * * 1`; `{kind:"advanced", months:[1,6], days:[1,15], time:"09:00"}` → `0 9 1,15 1,6 *`; `{kind:"once", date:"2026-11-01", time:"09:30"}` z `Europe/Warsaw` → `at "2026-11-01T08:30:00.000Z"`; `{kind:"interval", amount: 90, unit: "minutes"}` → `every "90m"`; `{kind:"interval", amount: 2, unit: "days"}` → `every "2d"`); `toOpenBotSchedule` odwrotnie dla każdego oraz `cron "*/5 * * * *"` → `custom`, `every "2m"` → `null`, `at` → `null`; round-trip `toOpenBotSchedule(fromOpenBotSchedule(x))` dla ośmiu kształtów importu daje `x` (bez `anchorAt`).

- [ ] **Step 2: Uruchom, FAIL; zaimplementuj w `schedule.ts`; uruchom, PASS; commit** `feat(schedule): OpenBot schedule shapes to and from the manifest`.

- [ ] **Step 3: Fixture'y.** `test/fixtures/openbot/import-v1/`: `openbot-import.json` z `format`, `version: 1`, `source: { app: "grok-bot", exportedAt: "2026-10-28T10:00:00.000Z" }`, `agents[0]` = `ada` (name „Ada", title, description 300 znaków, `avatar: "agents/ada/avatar.png"` (1x1 PNG), `skills: ["agents/ada/skills/release-notes", "agents/ada/skills/triage"]`, 8 rutyn po jednej na kształt importu (`hourly`, `daily`, `weekdays`, `weekly`, `monthly`, `interval`, `advanced`, `custom`), w tym jedna `active: false`, wszystkie `timezone: "Europe/Warsaw"`, 3 wspomnienia, `files: "agents/ada/files"` z `notes/todo.md`), `agents[1]` = `min` (same pola wymagane, `avatar: null`, `files: null`, puste listy), `channels: [{ key: "ops", name: "Ops", members: ["ada"] }]`. `test/fixtures/openbot/transfer-v1/`: `openbot-transfer.json` z `format: "openbot-instance-transfer"`, `version: 1`, `source: { appVersion: "1.4.0", exportedAt }`, jeden agent `ada` z `provider: "claude"`, `model: "claude-opus-5-5"`, `reasoningEffort: "high"`, `avatarSeed`, `avatarHue`, `notifications: true`, 2 rutyny z `limitPolicy`/`missedPolicy`, `oneTimeRoutines: [{ ..., schedule: { kind: "once", date: "2026-12-01", time: "08:00" } }]`, `memories: [{ text, inclusion: "essential" }, { text }]`, `settings: { mcpServers: [] }`, `shared: "shared"`, `signedIn: []` i plik `shared/readme.txt`. `README.md` z odsyłaczami do Załącznika A i źródeł G12, O2, O3.

- [ ] **Step 4: Testy modułu** w `test/formats/openbot-zip.test.ts` (zipy przez `zipDirectoryToFile`): `readOpenBotZip(import)` → `format`, 2 agentów, `ada.bundle.routines.length === 8` z `enabled` zgodnym z `active`, `facts.length === 3`, `skills.map(s => s.name)` = `["release-notes", "triage"]`, `avatar.bytes.length > 0`, `files` puste bez `includeFiles` i 1 wpis z `includeFiles`, `instructions` = description, `manifest.origin.app === "grok-bot"`, `manifest.id === ""`, ostrzeżenie o kanale; `readOpenBotZip(transfer)` → `models[0]` = `{ runtime: "claude-code", provider: "anthropic", model: "claude-opus-5-5" }`, `x-openbot.reasoningEffort === "high"`, 3 rutyny (w tym `at` z `2026-12-01T07:00:00.000Z`), `x-openbot.routines["<name>"].limitPolicy`, `x-openbot.memories` z jednym wpisem `essential`, ostrzeżenie o `settings`/`shared`; `openBotModelPref("codex", "gpt-5.5")` → `{ runtime: "codex", provider: "openai", model: "gpt-5.5" }`, `("opencode", "x")` → `{ runtime: "opencode", model: "x" }`, `(undefined, undefined)` → `undefined`; `writeOpenBotImportZip([bundleAda])` → manifest z `x-openteleport.id`, `description` ≤ 2000 i `files/INSTRUCTIONS.md` przy 2500 znakach (`approximated`), 65 faktów → 64 w zipie i `skipped` z `fact:65`, rutyna `at` → `skipped`, `every "2m"` → `skipped`, 33 skille → `skipped` 33.; round-trip `readOpenBotZip(write(read(import)))` daje te same rutyny, fakty, skille, instrukcje; (Review Focus 4) manifest z `key: "../x"` → błąd, nic w wyniku; skill ze ścieżką `agents/other/skills/x` przy kluczu `ada` → błąd.

- [ ] **Step 5: Uruchom, FAIL; zaimplementuj `src/formats/openbot-zip.ts`; uruchom, PASS.**

- [ ] **Step 6: `npm run lint && npm test`; commit** `feat(formats): read and write OpenBot agent zips`.

### Task 3: Adapter `hermes`

Po zadaniu 1. Równolegle z 2, 4, 5, 8.

**Files:**
- Create: `src/adapters/hermes/index.ts`, `paths.ts`, `memory.ts`, `cron.ts`, `read.ts`, `write.ts`; `test/adapters/hermes/paths.test.ts`, `memory.test.ts`, `cron.test.ts`, `read.test.ts`, `write.test.ts`; `test/fixtures/hermes/home/**`, `test/fixtures/hermes/README.md`
- Modify: `src/adapters/index.ts`, `test/commands/adapters.test.ts`

**Interfaces:**
- Consumes: `readMarker`, `writeMarker`, `carriesMarker`, `MARKER_FILE` (Task 1); `mergeInstructions`, `splitInstructions` (`src/core/text.ts`); `msToEvery`, `everyToMs`, `describeSchedule`, `zonedToInstant`, `parseCron` (`src/core/schedule.ts`); `yaml` (`parse`, `stringify`); `isSafeArchivePath`, `MAX_SKILLS`, `MAX_FACT_CHARS` (`src/core/paths.ts`); wzorce `placeSkill`/`holdsSkill` z `src/adapters/claude-code/write.ts` (skopiuj logikę do `hermes/write.ts` lub wyciągnij do `src/adapters/skills.ts`, jeśli obie strony zostają identyczne; decyzja wykonawcy, bez zmiany zachowania claude-code).
- Produces `src/adapters/hermes/paths.ts`:
  - `export const PROFILE_FILES = ["config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"] as const`
  - `export function hermesHome(ctx: Ctx, platform: NodeJS.Platform = process.platform): string` (`sourceDir ?? targetDir ?? ctx.env.HERMES_HOME ?? (win32 ? join(ctx.env.LOCALAPPDATA ?? join(ctx.home, "AppData", "Local"), "hermes") : join(ctx.home, ".hermes"))`, zawsze absolutna względem `ctx.cwd`)
  - `export const DEFAULT_PROFILE = "default"`; `export function profileDir(home: string, id: string): string`; `export async function isProfile(dir: string): Promise<boolean>`
  - `export type HermesConfig = { model?: { default?: string; provider?: string; base_url?: string }; timezone?: string; memory?: { memory_char_limit?: number; user_char_limit?: number }; agent?: { system_prompt?: string } }`; `export async function readConfig(dir: string): Promise<{ config: HermesConfig; raw: Record<string, unknown> } | undefined>`
  - `export function hermesTimezone(ctx: Ctx, config: HermesConfig | undefined): string` (`ctx.env.HERMES_TIMEZONE` → `config.timezone` → `Intl.DateTimeFormat().resolvedOptions().timeZone`)
- Produces `memory.ts`: `export const ENTRY_DELIMITER = "\n§\n"`, `export function parseEntries(text: string): string[]` (BOM usuwany, CRLF → LF, puste wpisy pomijane, wpisy trimowane), `export function renderEntries(entries: readonly string[]): string`.
- Produces `cron.ts`: `export type HermesJob = Record<string, unknown> & { id: string; name: string; prompt: string; schedule: unknown }`; `export async function readJobsFile(file: string): Promise<{ jobs: HermesJob[]; rest: Record<string, unknown> } | { error: string }>` (brak pliku → puste; tablica goła lub `{ jobs }`; wpis bez `id`/`name`/`prompt` jako łańcuchów jest pomijany z ostrzeżeniem przez wołającego); `export function jobToRoutine(job: HermesJob, timezone: string): { routine: Routine; extra: Record<string, unknown> } | null` (`extra` z `deliver`, `workdir`, `skills`, `enabled_toolsets`, `repeat`, `origin`, gdy obecne); `export function routineToJob(routine: Routine, extra: Record<string, unknown> | undefined, now: Date, id: string): HermesJob` (pola ze spec 4.5, zawsze `enabled: false`, `state: "paused"`); `export function newJobId(): string` (12 znaków hex z `randomBytes`); `export async function writeJobsFile(file: string, jobs: readonly HermesJob[], rest: Record<string, unknown>, now: Date): Promise<void>` (kopia `jobs.json.bak-<ISO z - zamiast :>` gdy plik istnieje, zapis atomowy `{ ...rest, jobs, updated_at }`).
- Produces `read.ts`: `export async function listHermesProfiles(ctx: Ctx): Promise<AgentRef[]>`, `export async function readHermesProfile(ctx: Ctx, agent: string): Promise<{ bundle: Bundle; warnings: string[] }>`, `export async function hermesCacheIdentity(ctx: Ctx, agent: string): Promise<string>` (realpath katalogu profilu).
- Produces `write.ts`: `export async function writeHermesProfile(ctx: Ctx, bundle: Bundle, opts: WriteOpts): Promise<WriteResult>`; `export function profileSlug(name: string): string` (jak `slug` w `folder`, z błędem dla pustego wyniku i dla nazw `default`, `profiles`).
- Produces `index.ts`: `export const hermesAdapter: Adapter` z `name: "hermes"`, `displayName: "Hermes Agent"`, capabilities ze spec 4.4, `createsOnWrite: false`, `cacheIdentity: hermesCacheIdentity`.

- [ ] **Step 1: Fixture** `test/fixtures/hermes/home/`: profil domyślny (`config.yaml` z `model: { default: "anthropic/claude-sonnet-4-5", provider: "anthropic" }`, `timezone: "Europe/Warsaw"`, `memory: { memory_char_limit: 2200 }`; `SOUL.md` bez układu persona/instrukcje; `memories/MEMORY.md` z trzema wpisami rozdzielonymi `\n§\n`, trzeci 700 znaków; `memories/USER.md` z jednym wpisem; `cron/jobs.json` w formie `{ jobs: [...] }` z trzema zadaniami: `cron` (`0 9 * * 1-5`), `interval` (`minutes: 120`), `once` (`run_at: "2026-12-01T08:00:00"` bez offsetu), jedno z `deliver: "telegram"` i `workdir`; `skills/writing/release-notes/SKILL.md` (kategoria), `skills/triage/SKILL.md`, `skills/.hub/state.json`, `skills/.bundled_manifest` listujący `triage`, `skills/claude-code-imports/old/SKILL.md`; `profile.yaml` z `display_name: "Main"`) i profil `profiles/reviewer/` (`profile.yaml` `display_name: "Reviewer"`, `description: "Reviews PRs"`; `SOUL.md` w układzie `# Persona` / `# Instructions`; bez `cron/`). `README.md` z numerami źródeł H3–H6, H13–H16, H18.

- [ ] **Step 2: Testy `paths`, `memory`, `cron`** (`paths.test.ts`: `hermesHome` dla `HERMES_HOME`, dla `win32` z `LOCALAPPDATA` i bez, dla `linux`; `sourceDir` wygrywa z `HERMES_HOME`; `isProfile` dla katalogu z samym `state.db` → true, pustego → false; `hermesTimezone` w trzech wariantach. `memory.test.ts`: `parseEntries` z BOM i CRLF (Review Focus 1), pusty plik → `[]`, round-trip `renderEntries(parseEntries(x)) === x` dla fixture'a. `cron.test.ts`: trzy zadania z fixture'a → rutyny `cron`/`every "2h"`/`at "2026-12-01T07:00:00.000Z"` ze strefą `Europe/Warsaw`; `extra.deliver === "telegram"`; zadanie z `schedule.kind: "weird"` → `null`; `routineToJob` daje `enabled: false`, `state: "paused"`, `next_run_at: null`, `schedule.display === describeSchedule(...)`, `interval.minutes === 120` dla `2h`; `readJobsFile` na pliku `{ not json` → `{ error }` (Review Focus 3); `writeJobsFile` zostawia `.bak-*` i zachowuje obce zadania i obce klucze najwyższego poziomu.)

- [ ] **Step 3: Uruchom, FAIL; zaimplementuj `paths.ts`, `memory.ts`, `cron.ts`; uruchom, PASS; commit** `feat(hermes): profile paths, memory entries and cron jobs`.

- [ ] **Step 4: Testy `read`** (`read.test.ts`, `Ctx` z `home` = kopia fixture'a w `mkdtemp`, `HERMES_HOME` w `env`): `list` → `[{ id: "default", name: "Main", location }, { id: "reviewer", name: "Reviewer", title: "Reviews PRs", location }]`; `read("default")`: `persona` = cały `SOUL.md`, `instructions === ""`, `facts` = 3 (2 z MEMORY.md + 1 z USER.md), `notes` = `[{ name: "memory-3", ... }]`, `routines` 3 z `timezone "Europe/Warsaw"`, `skills` = `["release-notes", "old"]` (bez `triage` z `.bundled_manifest`, bez `.hub`), ostrzeżenie „1 bundled Hermes skill left behind", `models` = `[{ provider: "anthropic", model: "anthropic/claude-sonnet-4-5" }]`, `x-hermes.profile === "default"`, `x-hermes.routines["<name>"].deliver === "telegram"`, `manifest.id === ""`; `read("reviewer")`: persona i instrukcje rozdzielone, `routines: []`; `read("nope")` → błąd wymieniający dostępne profile; BOM w `SOUL.md` nie trafia do persony; uszkodzony `cron/jobs.json` → ostrzeżenie, reszta czytana; po `read` fixture jest bajt w bajt taki sam (porównaj listing i hashe); `cacheIdentity` zwraca realpath.

- [ ] **Step 5: Uruchom, FAIL; zaimplementuj `read.ts`; uruchom, PASS; commit** `feat(hermes): read profiles as bundles`.

- [ ] **Step 6: Testy `write`** (`write.test.ts`, pusty `HERMES_HOME` z samym `config.yaml`, bundle „Ada" z persona, instrukcjami, 2 skillami, 3 rutynami (cron, every, at w przyszłości) i 4 faktami, `models` z `provider`/`model`): nowy profil `profiles/ada/` z `profile.yaml` (`display_name: "Ada"`), `SOUL.md` = `mergeInstructions(...)`, `config.yaml` z `model.default`/`model.provider`, `memories/MEMORY.md` z 4 wpisami, `cron/jobs.json` z 3 zadaniami `paused`, `skills/<name>/SKILL.md`, `.openteleport.json` z `id`, `cronJobIds` (3), `memoryEntries` (4), `skills` (2 hashe); wynik `done`, `approximated` zawiera wpis o personie i instrukcjach w jednym pliku, ostrzeżenia o restarcie gatewaya i o skanerach; `enableRoutines: true` → nadal `paused` + `approximated` z `hermes cron resume <id>` dla każdego zadania; drugi `write` tego samego id z 2 faktami i zmienionym skillem → ten sam katalog (brak `ada-2`), 2 wpisy pamięci (stare zastąpione, obcy wpis dodany ręcznie między zapisami zostaje), 3 nowe zadania zamiast starych (obce zadanie zostaje), skill nadpisany w miejscu; skill wyedytowany ręcznie między zapisami → `<name>-2` z ostrzeżeniem; inny agent o nazwie „Ada" (profil bez znacznika) z `update` → `profiles/ada-2/` + ostrzeżenie; `copy` → `ada-2`; `replace` profilu ze znacznikiem → katalog usunięty i zapisany od nowa; `replace` profilu bez znacznika → błąd „Refusing to replace"; rutyna `at` z przeszłości → `skipped` „Hermes rejects past one-off jobs"; 20 faktów po 200 znaków przy limicie 2200 → część w pliku, reszta `skipped` z `fact:<n>`; istniejący profil: `config.yaml` nietknięty i `approximated` „kept the profile's own model"; nazwa `***` → błąd (Review Focus 2); nazwa `default` → błąd; `targetDir` wskazujący katalog bez plików profilu → `detect.found === false`; dowiązanie w miejscu `profiles/ada` → nie jest śledzone (zapisane jako `ada-2` z ostrzeżeniem).

- [ ] **Step 7: Uruchom, FAIL; zaimplementuj `write.ts` i `index.ts`; rejestracja w `src/adapters/index.ts`; lista w `test/commands/adapters.test.ts`; uruchom, PASS.**

- [ ] **Step 8: Test CLI** (w `write.test.ts` lub `test/commands/move.test.ts`): `openteleport move --from folder --agent <ADA_DIR> --to hermes` w sandboxie (`HERMES_HOME` z `config.yaml`) → kod 0, raport z „handoff"/„done" poprawnie (`done`), katalog `profiles/ada`; `--json` zawiera `outcome: "done"`.

- [ ] **Step 9: `npm run lint && npm test`; commit** `feat(hermes): write profiles, with paused cron jobs and a marker`.

### Task 4: Adapter `codex`

Po zadaniu 1. Równolegle z 2, 3, 5, 8.

**Files:**
- Create: `src/adapters/codex/index.ts`, `paths.ts`, `read.ts`, `write.ts`; `test/adapters/codex/paths.test.ts`, `read.test.ts`, `write.test.ts`; `test/fixtures/codex/home/.codex/**`, `test/fixtures/codex/home/.agents/skills/**`, `test/fixtures/codex/README.md`
- Modify: `src/adapters/index.ts`, `test/commands/adapters.test.ts`

**Interfaces:**
- Consumes: `readIds`, `recordId` (Task 1 `marker.ts`); `mergeInstructions`, `splitInstructions`; `smol-toml` (`parse`, `stringify`); wzorzec `placeSkill`/`holdsSkill` (jak w Task 3).
- Produces `paths.ts`: `export function codexHome(ctx: Ctx): string` (`sourceDir ?? targetDir ?? ctx.env.CODEX_HOME ?? join(ctx.home, ".codex")`); `export function userSkillsDir(ctx: Ctx): string` (`join(ctx.home, ".agents", "skills")`); `export function legacySkillsDir(home: string): string`; `export function agentsDir(home: string): string`; `export const IDS_FILE = "openteleport-ids.json"`; `export const DEFAULT_AGENT = "default"`; `export const DETECT_FILES = ["config.toml", "AGENTS.md", "auth.json", "agents", "memories"] as const`.
- Produces `read.ts`: `export async function listCodexAgents(ctx: Ctx): Promise<AgentRef[]>` (`default` z `name: "Codex (global)"`, potem pliki `agents/*.toml` w kolejności nazw, `id` = nazwa pliku bez `.toml`, `name` = pole `name` lub id); `export async function readCodexAgent(ctx: Ctx, agent: string): Promise<{ bundle: Bundle; warnings: string[] }>`; `export async function codexCacheIdentity(ctx: Ctx, agent: string): Promise<string>`; `export type CodexAgentFile = { name: string; description: string; developer_instructions: string; model?: string; model_reasoning_effort?: string; nickname_candidates?: string[] }`; `export function parseAgentToml(text: string, file: string): { agent: CodexAgentFile; rest: Record<string, unknown> }` (błąd parsowania → `Error` z nazwą pliku).
- Produces `write.ts`: `export async function writeCodexAgent(ctx: Ctx, bundle: Bundle, opts: WriteOpts): Promise<WriteResult>`; `export function renderAgentToml(agent: CodexAgentFile, rest?: Record<string, unknown>): string` (`smol-toml.stringify`; wieloliniowe `developer_instructions` jako łańcuch wieloliniowy TOML `"""..."""` lub ucieczki: cokolwiek wybierze `smol-toml`, byle `parse(render(x)) ≡ x`); `export function agentSlug(name: string): string` (`[a-z0-9-]`, błąd dla pustego i dla `default`).
- Produces `index.ts`: `codexAdapter` z `name: "codex"`, `displayName: "Codex"`, capabilities ze spec 5.4, `createsOnWrite: false`.

- [ ] **Step 1: Fixture**: `home/.codex/AGENTS.md` w układzie `# Persona` / `# Instructions` z CRLF; `home/.codex/AGENTS.override.md` nieobecny; `config.toml` z `model = "gpt-5.5"`, `model_reasoning_effort = "high"`, `approval_policy = "on-request"`, komentarzem i tabelą `[mcp_servers.x]`; `agents/reviewer.toml` z `name`, `description`, `developer_instructions` (bez układu), `model`, `nickname_candidates`; `memories/MEMORY.md`; przestarzałe `skills/old/SKILL.md`; `home/.agents/skills/new/SKILL.md` i `home/.agents/skills/old/SKILL.md` (inna treść niż przestarzały). `README.md` z C1–C5, C7, C9–C12.

- [ ] **Step 2: Testy `paths` i `read`**: `codexHome` z `CODEX_HOME`, bez, z `sourceDir`; `list` → `default` + `reviewer`; `read("default")`: persona i instrukcje rozdzielone mimo CRLF (Review Focus 1), `skills` = `["new", "old"]` z treścią `old` z `~/.agents` i ostrzeżeniem o kolizji, `notes` = `[{ name: "codex-memory" }]` + ostrzeżenie „machine-generated", `models` = `[{ model: "gpt-5.5" }]`, `x-codex.reasoningEffort === "high"`, `x-codex.approvalPolicy === "on-request"`, `routines: []`, `facts: []`; `read("reviewer")`: `instructions` = `developer_instructions`, brak persony, `skills: []`, `x-codex.nickname_candidates`; `AGENTS.override.md` niepusty → ma pierwszeństwo; `AGENTS.override.md` pusty → `AGENTS.md`; `agents/broken.toml` (niepoprawny TOML) → `list` pomija z ostrzeżeniem, `read("broken")` → błąd z nazwą pliku; `detect` na katalogu z samym `auth.json` → `found: true`; `manifest.id` z `openteleport-ids.json` dla `reviewer`, puste dla `default`; fixture nietknięty po `read`.

- [ ] **Step 3: Uruchom, FAIL; zaimplementuj `paths.ts`, `read.ts`; PASS; commit** `feat(codex): read the global setup and custom agents`.

- [ ] **Step 4: Testy `write`** (`CODEX_HOME` z samym `config.toml`; bundle „Ada" z persona, instrukcjami, 2 skillami, 3 faktami, `models: [{ provider: "openai", model: "gpt-5.5" }]`, `x-codex: { reasoningEffort: "medium" }`): `agents/ada.toml` parsuje się (`smol-toml`) do `name: "Ada"`, `description` = `title` lub pierwsza linia instrukcji ≤120, `developer_instructions` = `mergeInstructions` + `\n\n# Facts\n- ...` (3 punkty), `model: "gpt-5.5"`, `model_reasoning_effort: "medium"`; `openteleport-ids.json` ma `ada: <id>`; `~/.agents/skills/<name>/SKILL.md` dla obu skilli; `config.toml` bajt w bajt niezmieniony; `AGENTS.md` nie powstał; wynik `done`, `approximated` o personie i o faktach, ostrzeżenie o współdzielonych skillach i o `@ada`; drugi `write` tego samego id → ten sam plik (brak `ada-2.toml`); cudzy `agents/ada.toml` bez wpisu w mapie z `update` → `ada-2.toml` + ostrzeżenie; `replace` nad cudzym → błąd „Refusing to replace"; `replace` nad własnym → nadpisany; skill o tej samej nazwie i innej treści w `~/.agents/skills` → `<name>-2` i oryginał nietknięty; nazwa `***` → błąd (Review Focus 2); `developer_instructions` z cudzysłowami, `\` i `"""` wewnątrz → round-trip przez `parse` daje ten sam tekst.

- [ ] **Step 5: Uruchom, FAIL; zaimplementuj `write.ts`, `index.ts`, rejestracja, lista w `adapters.test.ts`; PASS.**

- [ ] **Step 6: Test CLI**: `move --from folder --agent <ADA_DIR> --to codex` → kod 0, `agents/ada.toml` w `CODEX_HOME`, skille w `<home>/.agents/skills`.

- [ ] **Step 7: `npm run lint && npm test`; commit** `feat(codex): write agents as custom agent files`.

### Task 5: Adapter `letta`

Po zadaniu 1. Równolegle z 2, 3, 4, 8.

**Files:**
- Create: `src/adapters/letta/index.ts`, `paths.ts`, `memfs.ts`, `crons.ts`, `read.ts`, `write.ts`; `test/adapters/letta/memfs.test.ts`, `crons.test.ts`, `read.test.ts`, `write.test.ts`; `test/fixtures/letta/home/.letta/**`, `test/fixtures/letta/README.md`
- Modify: `src/adapters/index.ts`, `test/commands/adapters.test.ts`

**Interfaces:**
- Consumes: `readMarker`, `writeMarker` (Task 1); `everyToCron`, `describeSchedule` (`schedule.ts`); `factsToProse`, `proseToFacts` (`text.ts`); `parseAgentFile`/`renderAgentFile` z `src/adapters/claude-code/frontmatter.ts` tylko jeśli obsługują dowolny frontmatter YAML; inaczej własny `parseFrontmatter(text): { data: Record<string, unknown>; body: string }` w `memfs.ts` na pakiecie `yaml`.
- Produces `paths.ts`: `export function lettaDir(ctx: Ctx): string` (`sourceDir ?? targetDir ?? join(ctx.home, ".letta")`); `export function localBackendDir(ctx: Ctx, letta: string): string` (`ctx.env.LETTA_LOCAL_BACKEND_DIR ?? join(letta, "lc-local-backend")`); `export function cloudAgentsDir(letta: string): string`; `export const CRONS_FILE = "crons.json"`.
- Produces `memfs.ts`: `export type MemFs = { persona?: { name?: string; description?: string; body: string }; instructions?: string; human?: string; rootNotes: Note[]; referenceNotes: Note[]; skills: Skill[]; warnings: string[] }`; `export async function readMemFs(dir: string): Promise<MemFs>`; `export function renderMemFs(bundle: Bundle): FileEntry[]` (ścieżki względem `memory/`: `MEMORY.md` z listą plików i jednolinijkowymi opisami, `persona.md` z frontmatterem `name`/`description`, `instructions.md`, `human.md` = `factsToProse(facts)`, `reference/MEMORY.md` + `reference/<note>.md`, `skills/<name>/<pliki>`); `export const RESERVED_ROOT = ["MEMORY.md", "persona.md", "human.md", "instructions.md"] as const`.
- Produces `crons.ts`: `export type LettaCronTask = Record<string, unknown> & { id: string; agent_id: string; name: string; prompt: string; status: string }`; `export async function readCrons(file: string): Promise<{ tasks: LettaCronTask[] } | { error: string }>`; `export function taskToRoutine(task: LettaCronTask): { routine: Routine; extra: Record<string, unknown> } | null` (`cron` + `timezone` → cron; `scheduled_for` → `at`; `status` `active`/`paused` → `enabled`; `fired`/`missed`/`cancelled` → `null`); `export function cronAddCommand(routine: Routine, promptFile: string, shell: "sh" | "ps1"): string` (jedna linia `letta cron add ...` z cytowaniem dla danej powłoki; `every` → `--cron "<everyToCron>"`; `at` → `--at "<ISO>"`).
- Produces `read.ts`: `listLettaAgents`, `readLettaAgent`, `lettaCacheIdentity` (realpath katalogu `memory/`).
- Produces `write.ts`: `writeLettaAgent(ctx, bundle, opts): Promise<WriteResult>` (katalog `<targetDir ?? cwd>/<slug>-letta-memory/` z `memory/`, `routines/<slug>.txt`, `letta-commands.sh`, `letta-commands.ps1`, `README.md`, `.openteleport.json`; `renderCommands(bundle, dir, shell): string`).
- Produces `index.ts`: `lettaAdapter` z `name: "letta"`, `displayName: "Letta Code"`, capabilities ze spec 8.4, `createsOnWrite: true`.

- [ ] **Step 1: Fixture**: `lc-local-backend/agents/agent-local-1111.json` (rekord ze spec 8.1 z `system: "You review PRs."`, `model: "anthropic/claude-sonnet-4-5"`, `tags: ["review"]`), `lc-local-backend/memfs/agent-local-1111/memory/` (`MEMORY.md`, `persona.md` z frontmatterem `name: Reviewer`, `description: ...` i BOM, `human.md` z dwoma punktami i akapitem prozy, `reference/MEMORY.md`, `reference/style.md`, `skills/triage/SKILL.md`, `notes.md` w korzeniu); `agents/agent-cloud-2222/memory/` (tylko `MEMORY.md`, `persona.md` bez frontmattera, `human.md` pusty); `crons.json` ze spec 8.1 z trzema zadaniami dla `agent-local-1111` (`active` cron, `paused` cron, `scheduled_for` `fired`) i jednym dla innego agenta. `README.md` z L5, L9, L10, L12, L15–L20.

- [ ] **Step 2: Testy `memfs`, `crons`, `read`**: `readMemFs` daje personę bez BOM z `name: "Reviewer"` (Review Focus 1), `human` z tekstem, `rootNotes` = `["notes"]`, `referenceNotes` = `["style"]`, `skills` = `["triage"]`; `renderMemFs(bundle)` → round-trip `readMemFs(render)` zachowuje personę, instrukcje, fakty (`proseToFacts(human)`), notatki, skille; `taskToRoutine` dla trzech wariantów (`fired` → `null`); `cronAddCommand` dla `sh` i `ps1` z nazwą zawierającą `"` i `$`; `readCrons` na uszkodzonym pliku → `{ error }` (Review Focus 3); `list` → `[{ id: "agent-local-1111", name: "Reviewer", title }, { id: "agent-cloud-2222", name: "agent-cloud-2222" }]`; `read(local)`: `instructions === "You review PRs."`, `persona`, `facts` = 2, `notes` = `["human", "notes", "reference--style"]` (nazwa notatki z prozy `human.md` = `human`), `routines` = 2 (`enabled` true/false), `models` = `[{ provider: "anthropic", model: "anthropic/claude-sonnet-4-5" }]`, `x-letta.backend === "local"`, `x-letta.tags`, ostrzeżenie o pominiętym zadaniu `fired`; `read(cloud)`: `instructions === ""`, `models: []`, `x-letta.backend === "cloud"`; fixture nietknięty.

- [ ] **Step 3: Uruchom, FAIL; zaimplementuj `paths.ts`, `memfs.ts`, `crons.ts`, `read.ts`; PASS; commit** `feat(letta): read Letta Code agents from MemFS and crons.json`.

- [ ] **Step 4: Testy `write`** (bundle „Ada" z persona, instrukcjami, 3 faktami, 2 notatkami, 1 skillem, 3 rutynami (cron enabled, every disabled, at), `models: [{ provider: "anthropic", model: "claude-opus-5-5" }]`): katalog `ada-letta-memory/` z `memory/` (`persona.md` frontmatter `name: Ada`, `instructions.md`, `human.md` z 3 punktami, `reference/<note>.md` ×2, `reference/MEMORY.md`, `MEMORY.md` wymieniający `persona.md`, `instructions.md`, `human.md`, `reference/`), `skills/<name>/SKILL.md` w `memory/skills/`, `routines/<slug>.txt` ×3, `letta-commands.sh` zawierający `letta agents create --name "Ada"` z `--model "anthropic/claude-opus-5-5"`, linię `read -r -p`, `letta memory restore --agent "$AGENT_ID" --from "<abs>/memory" --force`, dwie aktywne linie `letta cron add` (cron i `--at`) i jedną zakomentowaną z `# paused in the source`, `every "30m"` jako `--cron "*/30 * * * *"`; `letta-commands.ps1` z `Read-Host` i `(Get-Content -Raw ...)`; `.openteleport.json` w korzeniu, nie w `memory/`; wynik `handoff` z `artifactPath` i `nextStep` ze spec 8.4, `approximated` o instrukcjach, o modelu i o `every`→cron, dwa ostrzeżenia ze spec 8.4; drugi `write` tego samego id → ten sam katalog nadpisany; cudzy katalog `ada-letta-memory` bez znacznika → `ada-letta-memory-2`; `replace` cudzego → błąd; prompt wieloliniowy w `routines/<slug>.txt` bajt w bajt.

- [ ] **Step 5: Uruchom, FAIL; zaimplementuj `write.ts`, `index.ts`, rejestracja, lista; PASS.**

- [ ] **Step 6: Test CLI**: `import <ADA_DIR> --to letta` w sandboxie bez `~/.letta` → kod 0 (`createsOnWrite`), katalog w `cwd`, raport z `handoff` i `nextStep`.

- [ ] **Step 7: `npm run lint && npm test`; commit** `feat(letta): hand off a MemFS folder and the commands that load it`.

### Task 6: Adapter `openbot`

Po zadaniach 1 i 2. Równolegle z 7.

**Files:**
- Create: `src/adapters/openbot/index.ts`, `paths.ts`, `db.ts`, `read.ts`, `write.ts`; `test/adapters/openbot/paths.test.ts`, `db.test.ts`, `read.test.ts`, `write.test.ts`; `test/fixtures/openbot/schema.sql`, `test/fixtures/openbot/seed.sql`
- Modify: `src/adapters/index.ts`, `test/commands/adapters.test.ts`, `test/fixtures/openbot/README.md`

**Interfaces:**
- Consumes: `readOpenBotZip`, `writeOpenBotImportZip`, `openBotModelPref` (Task 2); `fromOpenBotSchedule` (Task 2); `readMarker`-podobna kontrola artefaktu przez odczyt manifestu zipa (`readOpenBotZip` zwraca `manifest.id`); `VERSION` z `src/index.ts`.
- Produces `paths.ts`: `export function openBotUserData(ctx: Ctx, platform: NodeJS.Platform = process.platform): string` (`sourceDir ?? targetDir` gdy katalog; `win32`: `join(ctx.env.APPDATA ?? join(ctx.home, "AppData", "Roaming"), "OpenBot")`; `darwin`: `join(ctx.home, "Library", "Application Support", "OpenBot")`; inaczej `join(ctx.home, ".config", "OpenBot")`); `export const DB_FILE = "openbot.db"`; `export const KNOWN_SCHEMA_VERSION = 47`; `export async function zipSource(ctx: Ctx): Promise<string | undefined>` (`sourceDir` będący plikiem `.zip`).
- Produces `db.ts`: `export type OpenBotDbRoutine = { id: string; name: string; instruction: string; active: boolean; timezone: string; schedule: unknown; limitPolicy?: unknown; missedPolicy?: unknown }`; `export type OpenBotDbAgent = { id: string; name: string; title?: string; description?: string; provider?: string; model?: string; reasoningEffort?: string; avatarSeed?: unknown; avatarHue?: unknown; avatar?: string; workspacePath?: string; notifications?: unknown; memories: string[]; routines: OpenBotDbRoutine[] }`; `export async function loadSqlite(): Promise<typeof import("node:sqlite")>` (import leniwy; na czas importu `process.emitWarning` zastąpione filtrem pomijającym `name === "ExperimentalWarning"` z `/SQLite/` w treści, potem przywrócone; brak modułu → `Error` „node:sqlite is not available; use Node 24 or pass --source-dir <export.zip>"); `export async function withDatabaseCopy<T>(userData: string, fn: (db: import("node:sqlite").DatabaseSync) => T): Promise<T>` (kopiuje `openbot.db`, `-wal`, `-shm` do `mkdtemp`, otwiera `new DatabaseSync(copy, { readOnly: true })`, sprząta zawsze); `export function schemaVersion(db): number` (`SELECT MAX(version) FROM schema_migrations`); `export function assertSchema(db): void` (cztery tabele i wymagane kolumny przez `PRAGMA table_info`; brak → `Error` ze spec 6.2); `export function readDbAgents(db): OpenBotDbAgent[]`.
- Produces `read.ts`: `listOpenBotAgents`, `readOpenBotAgent` (z bazy lub zipa wg `zipSource`), `openBotCacheIdentity` (`<realpath userData>#<agent_id>` lub `zip:<format>:<key>`).
- Produces `write.ts`: `writeOpenBotAgent(ctx, bundle, opts): Promise<WriteResult>` (zip do `<targetDir ?? cwd>/<slug>-openbot-import.zip`, konflikt wg spec 3.4; `handoff` z `nextStep` „Open OpenBot, go to Server settings, choose Import and pick <plik>").
- Produces `index.ts`: `openbotAdapter` z `name: "openbot"`, `displayName: "OpenBot"`, capabilities ze spec 6.4, `createsOnWrite: true`.

- [ ] **Step 1: Schemat i seed**: `test/fixtures/openbot/schema.sql` z `CREATE TABLE` dla `schema_migrations`, `projection_agents(agent_id TEXT PRIMARY KEY, model TEXT, agent_json TEXT NOT NULL)`, `projection_agent_memories(agent_id, text, origin, normalized_text, UNIQUE(agent_id, normalized_text))`, `projection_agent_routines(routine_id TEXT PRIMARY KEY, agent_id, name, instruction, active INTEGER, timezone, limit_policy TEXT, missed_policy TEXT)`, `projection_routine_triggers(routine_id, schedule_json TEXT NOT NULL CHECK(json_valid(schedule_json)))`, skopiowane z `src/backend/openbot-database-schema.ts` repo `nightly-labs/openbot` (pobierz surowy plik; zapisz w `README.md` datę i commit) i uzupełnione o `INSERT INTO schema_migrations` do 47; `seed.sql` z dwoma agentami (`agent_json` wg `AgentSummary`: `ada` z `provider: "claude"`, `model: "claude-opus-5-5"`, `reasoningEffort: "high"`, `avatarSeed`, `avatarHue`, `avatarUrl: null`, `workspacePath`; `min` minimalny), 3 wspomnieniami `ada` (jedno 600 znaków), 4 rutynami `ada` z czterema kształtami w `schedule_json`, jedną nieaktywną z `limit_policy`.

- [ ] **Step 2: Testy `db` i `paths`**: `openBotUserData` dla trzech platform i `APPDATA`; `loadSqlite()` działa i po wywołaniu `process.emitWarning` jest tym samym obiektem co przed; `withDatabaseCopy` na bazie zbudowanej w teście (`DatabaseSync` w pamięci? nie: plik w `mkdtemp` + `exec(schema.sql)` + `exec(seed.sql)`) zwraca 2 agentów z polami jak w seedzie, 3 wspomnienia, 4 rutyny; oryginalny plik jest otwarty przez test na wyłączność (`fs.openSync` + na Windows `flags: "r+"` z `fs.constants.O_EXCL`? jeśli blokada nie jest osiągalna przenośnie, test sprawdza przynajmniej, że `DatabaseSync` nie była otwarta na oryginalnej ścieżce przez podmianę `DatabaseSync` w module przez `vi.mock`) ; `schemaVersion` = 47; baza bez `projection_routine_triggers` → `assertSchema` rzuca „schema not recognised"; `schema_migrations` z 52 → `readOpenBotAgent` daje ostrzeżenie „newer (schema 52) than this adapter knows (47)".

- [ ] **Step 3: Uruchom, FAIL; zaimplementuj `paths.ts`, `db.ts`; PASS; commit** `feat(openbot): read the projection tables from a copy of openbot.db`.

- [ ] **Step 4: Testy `read` i `write`**: `list` z `sourceDir` = katalog z bazą → 2 agentów; `read("ada")` → `instructions` = description, `facts` 2 + `notes` `["memory-3"]`, `routines` 4 z `x-openbot.routines[name].limitPolicy`, `models[0]` = `{ runtime: "claude-code", provider: "anthropic", model: "claude-opus-5-5" }`, `x-openbot.reasoningEffort`, `skills: []` z ostrzeżeniem ze spec 6.2, `files` tylko z `--include-files` (workspace w `mkdtemp` z jednym plikiem); `list`/`read` z `sourceDir` = zip importu (fixture z Task 2) i zip transferu; `detect` bez bazy → `found: false` z `hint`; `write` bundle'a → plik `ada-openbot-import.zip`, `readOpenBotZip` na nim daje `manifest.id === bundle.manifest.id`, wynik `handoff` z `artifactPath` i `nextStep`; drugi `write` tego samego id → ten sam plik nadpisany; plik o tej nazwie z innym id → `ada-openbot-import-2.zip`; `replace` pliku bez `x-openteleport` → błąd; `--json` CLI `list --from openbot --source-dir <zip>` → stderr bez `ExperimentalWarning` (uruchom też na bazie, bo to tam import następuje).

- [ ] **Step 5: Uruchom, FAIL; zaimplementuj `read.ts`, `write.ts`, `index.ts`, rejestracja, lista; PASS.**

- [ ] **Step 6: `npm run lint && npm test`; commit** `feat(openbot): list and read agents, hand off an import zip`.

### Task 7: Adapter `grok-bot`

Po zadaniach 1 i 2. Równolegle z 6.

**Files:**
- Create: `src/adapters/grok-bot/index.ts`, `read.ts`, `write.ts`; `test/adapters/grok-bot/read.test.ts`, `write.test.ts`
- Modify: `src/adapters/index.ts`, `test/commands/adapters.test.ts`

**Interfaces:**
- Consumes: `readOpenBotZip` (Task 2); `describeSchedule`; `readMarker`, `writeMarker` (Task 1); `factsToProse`.
- Produces `read.ts`: `listGrokBots(ctx)`, `readGrokBot(ctx, agent)`, `grokBotCacheIdentity(ctx, agent)` (`zip:<format>:<key>`), `detectGrokBot(ctx)` (`found` tylko z `sourceDir` = zip; `hint` ze spec 7.1).
- Produces `write.ts`: `writeGrokBot(ctx, bundle, opts): Promise<WriteResult>`; `export function renderPastePack(bundle: Bundle): FileEntry[]` (`README.md`, `1-paste-into-chat.md`, `2-memory.txt`, `3-routines.md`, `skills/<name>/...` wg spec 7.2; teksty dokładnie jak w spec).
- Produces `index.ts`: `grokBotAdapter` z `name: "grok-bot"`, `displayName: "Grok Bot"`, capabilities ze spec 7.2, `createsOnWrite: true`.

- [ ] **Step 1: Testy `read`**: `detect` bez `sourceDir` → `{ found: false, hint }`; z zipem → `{ found: true, location }`; `list` z zipem importu z Task 2 → 2 Boty; `read("ada")` → `manifest.origin.app === "grok-bot"`, rutyny 8, skille 2; zip transferu (`source.app` inne) → ostrzeżenie, nie błąd; `sourceDir` = katalog → błąd „Grok Bot keeps agents in the cloud...".

- [ ] **Step 2: Uruchom, FAIL; zaimplementuj `read.ts`; PASS; commit** `feat(grok-bot): read Bots from the OpenBot export zip`.

- [ ] **Step 3: Testy `write`** (bundle „Ada": persona, instrukcje, 2 skille, 3 fakty, 3 rutyny (cron, every, at; jedna wyłączona)): katalog `ada-for-grok-bot/` z pięcioma elementami; `1-paste-into-chat.md` zaczyna się od „From now on, this is who you are and how you work:", zawiera personę, instrukcje i „Remember these facts:" z 3 punktami; `2-memory.txt` = 3 linie; `3-routines.md` = 3 linie z `describeSchedule(..., tz)` i `(paused)` przy wyłączonej; `README.md` z pięcioma krokami; `.openteleport.json` z id; wynik `handoff`, `artifactPath`, `nextStep` ze spec 7.2; drugi `write` tego samego id → nadpisany; cudzy katalog → `-2`; `replace` cudzego → błąd.

- [ ] **Step 4: Uruchom, FAIL; zaimplementuj `write.ts`, `index.ts`, rejestracja, lista; PASS.**

- [ ] **Step 5: Test CLI**: `import <ADA_DIR> --to grok-bot` bez instalacji → kod 0, katalog w `cwd`, raport `handoff`.

- [ ] **Step 6: `npm run lint && npm test`; commit** `feat(grok-bot): hand off a paste pack for a Bot`.

### Task 8: CLI: kreator, domyślny bieżący katalog, pomoc podstawowa i pełna

Po zadaniu 1. Równolegle z 2–5.

**Files:**
- Create: `src/commands/wizard.ts`, `test/commands/wizard.test.ts`, `test/commands/help.test.ts`
- Modify: `src/cli.ts`, `src/commands/export.ts`, `src/commands/import.ts`, `src/commands/shared.ts`, `test/commands/export.test.ts`, `test/commands/import.test.ts`, `README.md` (tylko sekcja Usage, jeśli pokazuje `--help`)

**Interfaces:**
- Consumes: `listAdapters`, `getAdapter` (`registry.ts`); `moveCommand`, `exportCommand`; `buildCtx`, `sideOf`, `fileSlug` (`shared.ts`); `@clack/prompts` (`intro`, `select`, `confirm`, `note`, `outro`, `isCancel`).
- Produces `src/commands/wizard.ts`:
  - `export const CANCELLED: unique symbol`
  - `export type Choice<T> = { value: T; label: string; hint?: string; disabled?: boolean }`
  - `export type Prompter = { select<T>(message: string, choices: Choice<T>[]): Promise<T | typeof CANCELLED>; confirm(message: string): Promise<boolean | typeof CANCELLED>; note(text: string): void; intro(text: string): void; outro(text: string): void }`
  - `export function clackPrompter(): Prompter`
  - `export type WizardDeps = { adapters: () => Adapter[]; move: typeof moveCommand; exportTo: typeof exportCommand; isTTY: () => boolean }`
  - `export async function runWizard(prompter: Prompter, opts: CommonOptions, deps?: Partial<WizardDeps>): Promise<"done" | "cancelled">` (przebieg ze spec 10.1; anulowanie w dowolnym kroku → `prompter.outro("Cancelled.")`, zwrot `"cancelled"`, nic nie zapisane)
  - `export const JETPACK_TARGET = "__jetpack__"` (wartość pozycji „Save as a .jetpack file")
- Produces w `src/cli.ts`: brak argumentów + TTY → `runWizard(clackPrompter(), {})` (kod 0 także po anulowaniu); brak argumentów bez TTY → pomoc na stdout, kod 2, z `--json` → `writeJson({ error: { code: 2, message: "No command given" } })`; globalna opcja `--help-all`; opcje zaawansowane (`--source-dir`, `--target-dir`, `--copy`, `--replace`, `--yes`, `--enable-routines`, `--keep`, `--quiet`) i polecenia `validate`, `adapters` ukryte w zwykłej pomocy; stopka zwykłej pomocy: „More: `openteleport --help-all` lists every command and flag."; pełna pomoc dodaje sekcję „Environment:" z `OPENTELEPORT_HOME` i `OPENTELEPORT_EXTRA_ADAPTER`.
- Produces w `export.ts`: `from` opcjonalne (`ExportOptions.from?: string`); bez `--from` → adapter `folder`, agent `.`; brak `AGENTS.md` w `cwd` → `UsageError("No AGENTS.md here; pass --from <app> or run from an agent folder")`.
- Produces w `import.ts`: `to` opcjonalne; bez `--to` → `folder`.

- [ ] **Step 1: Testy kreatora** (`wizard.test.ts`, sztuczny `Prompter` z kolejką odpowiedzi i zapisem wywołań; adaptery pamięciowe z `createMemoryAdapter`): dwa znalezione adaptery i jeden nieznaleziony → `select` źródła dostaje 3 pozycje, nieznaleziony z `disabled: true` i `hint`; po wyborze źródła z dwoma agentami → `select` agenta; z jednym agentem → brak pytania, `note` z nazwą; cele = znalezione + `createsOnWrite` + pozycja `.jetpack`; podsumowanie zawiera „Routines arrive disabled." i dla celu `handoff` (adapter z `outcome: "handoff"`) zdanie o dodatkowym kroku; `confirm` true → `deps.move` wołane z `{ from, to, agent, ... }` bez `--replace`; wybór `.jetpack` → `deps.exportTo` z `out: "<slug>.jetpack"`; `CANCELLED` na każdym z czterech pytań → `"cancelled"`, `move`/`exportTo` nie wołane, `outro("Cancelled.")` (Review Focus 5).

- [ ] **Step 2: Uruchom, FAIL; zaimplementuj `wizard.ts`; PASS; commit** `feat(cli): a wizard for the no-argument run`.

- [ ] **Step 3: Testy CLI** (`help.test.ts`, `export.test.ts`, `import.test.ts` przez `run()` z sandboxu, `stdin: "ignore"` = brak TTY): `openteleport` bez argumentów → kod 2, stdout zawiera „Usage:" i „More: `openteleport --help-all`"; z `--json` → `{ error: { code: 2, message: "No command given" } }`; `--help` nie zawiera `--source-dir`, `validate`, `adapters`; `--help-all` zawiera wszystkie trzy i „Environment:"; `move --help` nie zawiera `--replace`, `move --help-all` zawiera; `export` w katalogu z `AGENTS.md` bez `--from` → plik `<slug>.jetpack`; w pustym katalogu → kod 2 z komunikatem ze spec 10.2; `import <ADA_DIR>` bez `--to` → katalog `<cwd>/ada/`.

- [ ] **Step 4: Uruchom, FAIL; zaimplementuj zmiany w `cli.ts`, `export.ts`, `import.ts`; PASS.**

- [ ] **Step 5: `npm run lint && npm test`; commit** `feat(cli): export and import default to the current folder; basic and full help`.

### Task 9: Rejestracja, dokumentacja, wersja

Po scaleniu zadań 2–8 i 10 do `v0.2`. Dodatkowo: `handoff: true` na adapterach `letta`, `openbot`, `grok-bot` (pole `Adapter.handoff` dodane w zadaniu 8) z testem, że każdy adapter z `handoff: true` zwraca `outcome: "handoff"` z `write` na przykładowym bundle, i adnotacja w spec 9.2, że kształt `advanced` na drucie jest zagnieżdżony (`days: { kind, days }`, `time: { kind: "at-time", time }`).

**Files:**
- Modify: `src/adapters/index.ts`, `test/commands/adapters.test.ts`, `README.md`, `CHANGELOG.md`, `docs/STATUS.md`, `docs/design.md`, `docs/demo.md`, `CONTRIBUTING.md`, `src/index.ts` (eksport nowych adapterów i typów `Adapter.createsOnWrite`, jeśli `index.ts` eksportuje adaptery)

- [ ] **Step 1: Kolejność rejestracji** `folder`, `openclaw`, `claude-code`, `hermes`, `codex`, `openbot`, `grok-bot`, `letta`; `test/commands/adapters.test.ts` oczekuje tej listy (plus `memory` z dodatkowego adaptera); komentarz w `index.ts` wymienia wszystkie.

- [ ] **Step 2: README**: „Quick start" zaczyna się od `npx openteleport` (kreator, 3 zdania co pokazuje), potem trzy polecenia jak dziś; tabela „Supported apps" z ośmioma wierszami (kolumny: Adapter | Read | Write | Result | Notes; `Result` = `done` lub `handoff: <jeden krok>`); „Coming next" usunięte; sekcja o zmiennych środowiska wymienia `HERMES_HOME`, `CODEX_HOME`, `LETTA_LOCAL_BACKEND_DIR`; akapit „Not affiliated" rozszerzony o Nous Research, OpenAI, xAI, Letta.

- [ ] **Step 3: CHANGELOG** sekcja `## [0.2.0] - unreleased` nad `0.1.0` z „Added" (pięć adapterów, kreator, `--help-all`, domyślny bieżący katalog, `createsOnWrite` dla autorów adapterów), „Fixed" (EPIPE exit code, cache identity, fakty w raporcie).

- [ ] **Step 4: `docs/STATUS.md`** wg spec 12; **`docs/design.md`** sekcja 8 z odsyłaczem do spec v0.2 i pkt 4 listy adapterów zastąpiony; **`docs/demo.md`** po jednym scenariuszu na nowy adapter (polecenie, wynik, co jest `handoff`) i tabela „could not verify" rozszerzona o pięć wierszy (układy z dokumentacji); **`CONTRIBUTING.md`** „Writing an adapter": `src/adapters/marker.ts`, `createsOnWrite`, checklista = spec sekcja 3.

- [ ] **Step 5: `npm run lint && npm test`; `node dist/cli.js adapters` pokazuje 8 wierszy; commit** `docs: v0.2 adapters, wizard and status`.

### Task 10: Konsolidacja zduplikowanych helperów adapterów

Po scaleniu zadań 2–8 do `v0.2`, przed zadaniem 9. Dodane w trakcie wykonania (ruling kontrolera po przeglądzie zadania 4): adaptery pisane równolegle skopiowały te same helpery z adaptera Claude Code, bo nie mogły ich współdzielić bez konfliktów.

**Files:**
- Create: `src/adapters/skill-files.ts` (czytnik katalogów skilli z dysku), `test/adapters/skill-files.test.ts`
- Modify: `src/adapters/marker.ts` (eksport `replaceFile`), `src/adapters/fs.ts` lub `src/adapters/names.ts` (wspólne `freeName`, `recordedCopy`, `ULID_PATTERN` jeśli potrzebne), `src/adapters/claude-code/read.ts`, `src/adapters/claude-code/write.ts`, `src/adapters/openclaw/read.ts`, `src/adapters/folder/index.ts` (`lstatOrUndefined` → `lstatIfAny`), `src/adapters/codex/*`, `src/adapters/hermes/*`, `src/adapters/letta/*` i ich testy tylko tam, gdzie zmienia się import

**Interfaces:**
- Produces `src/adapters/skill-files.ts`: `export async function readSkillFolders(dir: string, opts?: { skipHidden?: boolean; nested?: boolean }): Promise<{ skills: Skill[]; warnings: string[] }>` (jedna implementacja tego, co dziś robią `readSkills`/`skillFiles`/`linkWarning` w claude-code, openclaw, codex, hermes, letta; dowiązania nigdy nie są śledzone; `nested` dla kategorii Hermesa).
- Produces w `marker.ts`: `export async function replaceFile(file: string, content: string | Uint8Array): Promise<void>` (dzisiejszy prywatny `replaceFile`; `writeAtomically` w adapterach znika).
- Produces wspólne `freeName(dir, base, ext)` i `recordedCopy(...)` sparametryzowane rozszerzeniem, z wariantem `.isFile()` jako zachowaniem wspólnym.

- [ ] **Step 1:** Spis kopii: `grep -n "function readSkills\|function skillFiles\|function writeAtomically\|function freeName\|function recordedCopy\|lstatOrUndefined\|ULID_PATTERN" src -r` i zapis listy w raporcie.
- [ ] **Step 2:** Test wspólnego czytnika (przypadki z istniejących testów adapterów: skill z plikami w podkatalogach, dowiązanie pomijane z ostrzeżeniem, katalog bez `SKILL.md` pomijany, ukryty katalog z `skipHidden`, kategorie z `nested`).
- [ ] **Step 3:** Implementacja i przełączenie każdego adaptera; żaden test adaptera nie zmienia oczekiwań poza nazwą importu; `npm run lint && npm test` zielone.
- [ ] **Step 4: Commit** `refactor(adapters): one skill-folder reader, one atomic file writer, shared conflict names`.

### Task 11: Przegląd całej gałęzi i PR

- [ ] **Step 1:** Przegląd całej gałęzi `v0.2` względem `main` przez świeżego recenzenta na najmocniejszym modelu (pakiet przeglądu: spec, plan, `git diff main...v0.2`, Review Focus); poprawki w jednej fali; ponowny przegląd.
- [ ] **Step 2:** `git push -u origin v0.2`; PR do `main` tytułem „v0.2: Hermes, Codex, OpenBot, Grok Bot and Letta adapters; wizard" z opisem wg szablonu PR (bez stopek atrybucji); CI na trzech systemach zielone; scalenie przez właściciela lub za jego zgodą.

## Self-review (wykonany przy pisaniu planu)

- **Pokrycie spec:** sekcja 3 → Task 1 (3.4, 3.4a, 3.12, 11) i każdy adapter (3.1–3.3, 3.5–3.15); 4 → Task 3; 5 → Task 4; 6 → Task 6; 7 → Task 7; 8 → Task 5; 9 → Task 2 (9.4 w 6 i 7); 10 → Task 8; 11 → Task 1; 12 → Task 9 (rejestracja po jednej linii w 3–7); 13 → Task 9 (STATUS); 14 → decyzje wykonawców wymienione w Interfaces; 15 → kolejność tu.
- **Typy:** `Prompter`, `Choice`, `OpenBotSchedule`, `OpenBotZipAgent`, `HermesJob`, `LettaCronTask`, `CodexAgentFile`, `Marker`, `ZipPolicy` zdefiniowane raz i używane pod tymi nazwami.
- **Review Focus:** 1 → Task 3 (BOM w `SOUL.md`, CRLF w `memory.test.ts`), Task 4 (CRLF w `AGENTS.md`), Task 5 (BOM w `persona.md`); 2 → Task 3 i 4; 3 → Task 3 i 5; 4 → Task 2; 5 → Task 8.
- **Proporcja:** plan ≈ 1,8× spec; kod jest w sygnaturach i asercjach, nie w ciałach.
