# OpenTeleport v0.2: pięć adapterów, prostsze CLI, dwie poprawki

Data: 2026-10-28. Status: obowiązujący dokument projektowy v0.2. Uzupełnia `docs/design.md` (v0.1); tam, gdzie się różnią, obowiązuje ten dokument dla v0.2.

Research, na którym opiera się ten dokument: `docs/superpowers/research/2026-10-28-v0.2-adapters-research.md` (dalej: „research", odsyłacze `[H13]`, `[C1]`, `[G12]`, `[L10]`, `[O1]` są z niego) oraz Załącznik A planu v0.1 (`docs/superpowers/plans/2026-10-27-openteleport-v0.1.md`) dla OpenBota.

## 1. Po co v0.2 i co zmienił research

v0.1 przenosi agenta między katalogiem, OpenClaw i Claude Code. v0.2 ma pokryć resztę aplikacji z listy w `docs/design.md`, sekcja 8: Hermes, Codex, OpenBot, Grok Bot, Letta, bo obietnica „dla wszystkich agentów" jest obietnicą tego projektu, nie jednej aplikacji. Do tego CLI ma stać się tak proste, że `npx openteleport` bez argumentów wystarcza, i wchodzą dwie jednolinijkowe poprawki z ledgera v0.1.

Research z 28.10.2026 zmienił cztery założenia z `docs/design.md`:

1. **Letta: format `.af` jest wycofany.** README `letta-code` mówi, że eksport i import AgentFile zostały usunięte z CLI [L5]; stary serwer V1 jest zarchiwizowany [L4]. „Agent Lettego" to dziś agent Letta Code: pamięć w katalogu MemFS (repozytorium git), harmonogramy w `~/.letta/crons.json`. Adapter celuje w MemFS. Import `.af` wypada ze scope (sekcja 2.2).
2. **Grok Bot nie ma importu, CLI ani API.** Jedyna działająca droga wyjścia to skill, który sam Bot uruchamia i który pakuje agentów do zipa w formacie `openbot-agent-import` v1 [G12]. Jedyna droga wejścia to rozmowa z Botem i ręczny import pamięci w ustawieniach [G2]. Adapter czyta zip, a zapis to `handoff` z przygotowanym pakietem do wklejenia.
3. **Codex nie ma nazwanego agenta ani oficjalnego formatu harmonogramów.** Katalog skilli użytkownika to `~/.agents/skills`, nie `~/.codex/skills` [C1][C10]. Automatyzacje istnieją tylko w nieoficjalnym `automation.toml` [C12]. Adapter obsługuje instrukcje, skille i pliki agentów (`agents/*.toml`); harmonogramów nie zapisuje.
4. **Team API OpenBota nie działa bezgłowo na desktopie** (port losowy na loopbacku, tylko przy działającej usłudze hosta, token sesji członka) [O1][O5][O6]. Zapis do OpenBota to zip + `handoff`, tak jak zakładał `docs/design.md`, sekcja 12, pkt 2.

Hermes okazał się najczystszym przypadkiem: profil to katalog, odczyt i zapis nie potrzebują demona [H4].

## 2. Zakres

### 2.1 Wchodzi

1. **Pięć adapterów**: `hermes`, `codex`, `openbot`, `grok-bot`, `letta` (sekcje 4–8). Każdy ma `detect`, `list`, `read`, `write` zgodnie z interfejsem `Adapter` z `src/adapters/types.ts`, który się nie zmienia.
2. **Wspólny moduł formatu OpenBota** `src/formats/openbot-zip.ts`: czytanie zipów `openbot-agent-import` v1 i `openbot-instance-transfer` v1, pisanie `openbot-agent-import` v1 (sekcja 9). Używają go `openbot` i `grok-bot`.
3. **Prostsze CLI** (sekcja 10): kreator po `npx openteleport` bez argumentów, `export` i `import` domyślnie na bieżącym katalogu, pomoc podzielona na podstawową i pełną.
4. **Dwie poprawki** (sekcja 11): kod wyjścia przy EPIPE; `cacheIdentity` tylko, gdy agent nie ma jeszcze id.
5. **Dokumentacja** (sekcja 12): README (tabela adapterów, kreator), `CHANGELOG.md` (0.2.0, niewydane), `docs/STATUS.md`, `docs/design.md` (odsyłacz do tego dokumentu), `docs/demo.md` (scenariusze dla nowych adapterów).

### 2.2 Nie wchodzi (i dlaczego)

- **Import `.af` Letty**: format wycofany z CLI, bez gwarancji zgodności schematu (roadmapa [L1]); pisanie parsera dla martwego formatu to koszt bez użytkowników. Jeśli ktoś zgłosi potrzebę, to osobny adapter `letta-af` tylko do odczytu.
- **Zapis harmonogramów Codexa**: format nieoficjalny, źródło prawdy niejasne (TOML czy SQLite) [C12][C14]. Odczytu też nie robimy, bo bez zapisu nie da się przetestować round-tripu, a błędny odczyt to fałszywe „moved".
- **Nieoficjalne API Grok Bota** (`gbot`, `grokbot-bridge`): odtworzone z aplikacji, kruche, prawdopodobnie sprzeczne z regulaminem [G14][G17]. Nie wchodzą do rdzenia; ewentualnie zewnętrzny adapter przez `OPENTELEPORT_EXTRA_ADAPTER`.
- **Letta Cloud REST**: wymaga klucza API i sieci; nagłówek autoryzacji i `agents.update` nieweryfikowane [ZAŁ w research 7.4]. v0.3, po weryfikacji na prawdziwym koncie.
- **Zapis do pamięci Codexa** (`~/.codex/memories/`): stan generowany, dokumentacja odradza edycję [C9].
- **Transport SSH, podpis Ed25519, plugin OpenClaw**: v0.3, bez zmian.
- **Bump wersji w `package.json`**: zostaje `0.1.0` do decyzji właściciela (sekcja 13).

### 2.3 Anty-cele

- Adapter, który zgłasza `done`, choć aplikacja agenta nie widzi. Jeśli nie da się tego zagwarantować bez demona lub konta, wynik to `handoff` z jednym konkretnym następnym krokiem.
- Adapter, który uruchamia prawdziwy binarny plik aplikacji w testach albo pisze do prawdziwego katalogu domowego.
- Dodanie do rdzenia pola, które ma sens tylko w jednej aplikacji (zasada uniwersalności z `docs/design.md`, sekcja 7). Wszystko takie idzie do `x-<vendor>` w manifeście.

## 3. Reguły wspólne dla nowych adapterów

Obowiązują wszystkie Global Constraints planu v0.1 (`docs/superpowers/plans/2026-10-27-openteleport-v0.1.md`, sekcja „Global Constraints"). Ledger v0.1 z rulingami nie jest w repozytorium (katalog `.superpowers/` jest ignorowany); **kod v0.1 jest formą obowiązującą**: tam, gdzie ten dokument mówi „jak w v0.1", wzorcem jest `src/adapters/openclaw/*`, `src/adapters/claude-code/*`, `src/adapters/folder/index.ts` i `src/core/engine.ts`, a plan v0.2 przepisuje najważniejsze rulingi do swoich Global Constraints. Dodatkowo:

1. **Żadnych binarnych plików aplikacji.** Pięć nowych adapterów czyta i pisze wyłącznie pliki. Uzasadnienie: żadna z pięciu aplikacji nie ma CLI z wyjściem JSON dla operacji, których potrzebujemy (Hermes: `cron list` bez `--json` [H9]; Codex: brak podkomend dla skilli i agentów [C6]; Letta: `agents create` bez promptu systemowego [L9]; Grok Bot i OpenBot: brak CLI). `detect` nie uruchamia niczego; `version` zostaje puste, chyba że da się je odczytać z pliku.
2. **Katalog domowy aplikacji tylko z `ctx.home` i `ctx.env`**, nigdy z `os.homedir()` ani `process.env`. Ścieżki na Windows: tam, gdzie aplikacja używa `%LOCALAPPDATA%` lub `%APPDATA%`, adapter bierze je z `ctx.env` z fallbackiem na `<home>/AppData/Local` lub `<home>/AppData/Roaming`.
3. **`--source-dir` i `--target-dir`** wskazują katalog domowy aplikacji (Hermes: `HERMES_HOME`; Codex: `CODEX_HOME`; Letta: `~/.letta`; OpenBot: `userData`), a dla `openbot` i `grok-bot` `--source-dir` może też wskazywać plik zip (sekcja 9.4). Zmienne `HERMES_HOME` i `CODEX_HOME` z `ctx.env` są honorowane, ale `--source-dir`/`--target-dir` mają pierwszeństwo.
4. **Znacznik tożsamości.** v0.1 ma dwa sprawdzone wzorce i oba zostają: znacznik w katalogu agenta (`.openteleport.json` z `{ id, movedAt }` w workspace OpenClaw, funkcje `carriesMarker` i zapis w `finishWrite` w `src/adapters/openclaw/write.ts`) oraz mapa slug → id w jednym pliku obok danych aplikacji (`openteleport-ids.json`, funkcje `readIds` i `recordId` w `src/adapters/claude-code/write.ts`). Zadanie wstępne wyciąga oba do `src/adapters/marker.ts` (`readMarker(dir)`, `writeMarker(dir, marker)`, `readIds(path)`, `recordId(path, slug, id, items)`), a adaptery v0.1 zaczynają ich używać bez zmiany zachowania (ich testy przechodzą bez zmian w fixture'ach). Hermes używa znacznika w katalogu profilu (rozszerzonego o to, co zapisał: id zadań cron, treść wpisów pamięci, skille z hashem treści); Codex używa mapy `<CODEX_HOME>/openteleport-ids.json` (slug pliku agenta → id). Znacznik jest jedynym dowodem, że „to ten sam agent" przy `update` i `replace`. **`read` zwraca id ze znacznika** (jak `markerId` w `openclaw/read.ts` i `recordedId` w `claude-code/read.ts`), żeby „popraw w aplikacji, przenieś ponownie" aktualizowało w miejscu zamiast tworzyć `-2`; gdzie znacznika nie ma (baza OpenBota, zip, MemFS Letty), id jest puste, a engine bierze je z `~/.openteleport/ids.json` pod kluczem `cacheIdentity`.
   Artefakty `handoff` (zip OpenBota, katalog Grok Bota, katalog Letty) też niosą znacznik: zip ma `x-openteleport: { id }` w manifeście (albo `agents/<key>/files/.openteleport.json`, 9.3), katalog ma `.openteleport.json` w korzeniu. Przy `update` artefakt o tej samej nazwie i tym samym id jest nadpisywany; o innym id lub bez znacznika dostaje `-N`; `replace` nadpisuje tylko artefakt ze znacznikiem (dowolnym id), inaczej odmawia; `copy` zawsze `-N`.
4a. **Cel bez instalacji.** `Adapter` dostaje opcjonalne pole `createsOnWrite?: boolean`: `true` znaczy „zapis tworzy cel, instalacja aplikacji nie jest potrzebna", więc `ensureDetected` w `src/commands/shared.ts` pomija kontrolę po stronie celu (dziś robi to zbiór `CREATED_ON_WRITE` tylko dla `folder`; zbiór zostaje zastąpiony polem, a `folder` dostaje `createsOnWrite: true`). `openbot`, `grok-bot` i `letta` mają `true` (produkują plik lub katalog); `hermes` i `codex` mają `false` (piszą do katalogu aplikacji, więc jej katalog domowy musi istnieć). Kreator (10.1) jako cele pokazuje adaptery znalezione lub z `createsOnWrite`.
5. **Konflikty nazw, jak w v0.1**: `update` pisze w miejsce tylko nad agentem o tym samym id (ze znacznika); inny agent o tej samej nazwie dostaje `-N`; `replace` usuwa tylko to, co OpenTeleport sam zapisał (dowód ze znacznika), inaczej odmawia; `copy` zawsze `-N`. Skille w katalogu **współdzielonym z innymi narzędziami** (Codex `~/.agents/skills`) nigdy nie są usuwane ani nadpisywane: istniejący skill o tej samej treści jest używany ponownie, o innej treści dostaje `-N` (reguła z adaptera Claude Code). Skille w katalogu, **który OpenTeleport sam utworzył** (profil Hermesa), są zapisane w znaczniku z hashem SHA-256 treści (`skills: { "<nazwa>": "<hex>" }`): przy `update` skill, którego treść na dysku nadal odpowiada zapisanemu hashowi, jest nadpisywany w miejscu (to my go napisaliśmy, użytkownik go nie ruszał); skill zmieniony przez użytkownika dostaje `-N` z ostrzeżeniem; skill bez wpisu w znaczniku podlega regule z Claude Code. `replace` profilu usuwa cały katalog profilu, bo znacznik dowodzi, że jest nasz.
6. **Zapisy atomowe**: plik tymczasowy w tym samym katalogu plus `rename`; przed nadpisaniem pliku, który aplikacja sama utrzymuje (`cron/jobs.json`, `crons.json`), kopia `<plik>.bak.<timestamp>` (Hermes sam tak robi przy imporcie [H1]).
7. **Nieznane pola zachowane.** Czytając plik aplikacji, którego część przepisujemy (`jobs.json`, `crons.json`, `config.toml`), adapter zachowuje wpisy i pola, których nie rozumie, bajt po bajcie tam, gdzie się da, a przynajmniej semantycznie (JSON: wszystkie klucze; TOML/YAML: wszystkie klucze przez parser i serializator, komentarze mogą zginąć, co raport wymienia jako ostrzeżenie przy pierwszym zapisie).
8. **Dane vendorowe w manifeście.** Pola bez odpowiednika w `Bundle` trafiają do `x-<vendor>` w manifeście (`x-hermes`, `x-codex`, `x-openbot`, `x-grok-bot`, `x-letta`). Rutyny są obiektami ścisłymi (`RoutineSchema`), więc ich dodatkowe pola idą do `x-<vendor>.routines["<nazwa rutyny>"]`. Przy zapisie do tej samej aplikacji adapter odtwarza je; przy zapisie do innej są ignorowane bez ostrzeżenia (to normalne, nie strata).
9. **Persona i instrukcje w jednym polu.** Hermes i Codex nie mają osobnego miejsca na `instructions` obok `persona`. Adapter używa istniejących `mergeInstructions(persona, instructions)` i `splitInstructions(text)` z `src/core/text.ts` (układ: H1 `# Persona`, potem H1 `# Instructions`; to samo robi adapter Claude Code). Przy odczycie tekst w tym układzie jest dzielony z powrotem; tekst w innym układzie znaczy to, co w danej aplikacji znaczy domyślnie: w Hermesie cały `SOUL.md` to persona, w Codexie cały `AGENTS.md` lub `developer_instructions` to instrukcje. Zapis w tym układzie trafia do raportu jako `approximated` („persona and instructions share one file").
10. **Rutyny lądują wyłączone**, chyba że `--enable-routines` (reguła v0.1). Sposób „wyłączenia" jest per aplikacja (sekcje 4–8).
11. **Skaner sekretów** działa jak w v0.1 na całym `Bundle` przed `write`; adaptery nie dodają własnego.
12. **Limity aplikacji są egzekwowane przy zapisie**, a nie ignorowane: co nie mieści się w limicie, trafia do `items.skipped`. Fakt pominięty ma `field: "fact:<n>"` (n = indeks w `bundle.facts`, od 1) i `detail: "<pierwsze 60 znaków>… (<powód>)"`, np. `(Hermes memory limit: 2200 chars)`. Engine (`movedItems` w `src/core/engine.ts`) dziś odejmuje części tylko dla skilli, rutyn i notatek; v0.2 dodaje fakty: liczba przeniesionych faktów = `facts.length` minus liczba pominiętych `fact:<n>`, a przy zerze linia faktów znika z raportu. To zmiana w rdzeniu z własnym testem (zadanie wstępne).
13. **Fixture'y z dokumentacji, nie z instalacji.** Żadna z pięciu aplikacji nie jest zainstalowana na maszynie, na której powstaje v0.2. Fixture'y odtwarzają układy opisane w research (z numerami źródeł w komentarzu `README.md` fixture'a). `docs/STATUS.md` wymienia każdy adapter jako „układ z dokumentacji i kodu źródłowego, nieweryfikowany na prawdziwej instalacji" do czasu, aż ktoś to sprawdzi; szablon issue „Bug report" prosi o taką weryfikację.
14. **`read` nigdy nie modyfikuje źródła**, również nie tworzy znacznika ani katalogów (reguła v0.1).
15. **Odczyt dużych plików**: jak w v0.1 (2 MiB na plik tekstowy, 100 MB na `files/`), bez wyjątków.

## 4. Adapter `hermes` (Hermes Agent)

Nazwa CLI `hermes`, `displayName` „Hermes Agent". Pewność researchu: wysoka.

### 4.1 Położenie i wykrywanie

- Katalog domowy: `ctx.env.HERMES_HOME`, inaczej na Windows `%LOCALAPPDATA%\hermes` (z `ctx.env.LOCALAPPDATA`, fallback `<home>\AppData\Local\hermes`), na pozostałych systemach `<home>/.hermes` [H16]. `--source-dir`/`--target-dir` nadpisują.
- Katalog jest profilem, jeśli zawiera jeden z plików `config.yaml`, `.env`, `SOUL.md`, `profile.yaml`, `auth.json`, `state.db` [H4].
- `detect`: `found` = katalog domowy jest profilem; `location` = ten katalog; `hint` = „Install Hermes Agent or pass --source-dir <HERMES_HOME>".

### 4.2 `list`

- Agent = profil. `default` to sam katalog domowy; profile nazwane to podkatalogi `profiles/<name>/`, które są profilami [H4]. `id` = `default` lub nazwa katalogu; `name` = `display_name` z `profile.yaml` (YAML, pakiet `yaml`) albo id; `title` = `description` z `profile.yaml`, jeśli jest; `location` = ścieżka profilu.

### 4.3 `read`

| `Bundle` | Hermes | Reguła |
|---|---|---|
| `persona` | `SOUL.md` | Część przed znacznikiem instrukcji (reguła 3.9); brak pliku = brak persony. |
| `instructions` | sekcja po znaczniku w `SOUL.md`; inaczej `agent.system_prompt` z `config.yaml`, jeśli jest łańcuchem [H18]; inaczej pusty łańcuch | `AGENTS.md` w Hermesie jest plikiem projektu, nie profilu [H11]. |
| `skills` | `skills/**/SKILL.md` | Nazwa skilla = nazwa katalogu ze `SKILL.md`; kategorie pośrednie [H6] są spłaszczane (kolizje nazw → ostrzeżenie, drugi dostaje `-N`). Pomijane: `skills/.hub/` oraz **skille dostarczone z Hermesem**, czyli wymienione w `skills/.bundled_manifest` [H6][H17] (plik czytany jako JSON; nazwy lub ścieżki z tablicy najwyższego poziomu albo z pola `skills`; format do potwierdzenia w kodzie Hermesa przez wykonawcę, a nieczytelny manifest = nic nie jest pomijane); ostrzeżenie podaje, ile skilli dostarczonych zostało na miejscu. Katalogi `*-imports/` są czytane normalnie. Limit 32 jak w formacie: nadmiar → ostrzeżenie i pominięcie. |
| `routines` | `cron/jobs.json` → `jobs[]` [H13] | Patrz 4.5. |
| `facts` | wpisy `memories/MEMORY.md` i `memories/USER.md`, rozdzielone `"\n§\n"` [H14], ≤500 znaków | Kolejność: MEMORY.md, potem USER.md. BOM usuwany. |
| `notes` | wpisy dłuższe niż 500 znaków | Nazwa `memory-<n>` (MEMORY.md) / `user-<n>` (USER.md), n od 1. |
| `models` | `config.yaml`: `model.default` → `model`, `model.provider` → `provider` [H18] | Jedna preferencja; `model.base_url` → `x-hermes.baseUrl`. |
| `avatar` | brak | Brak udokumentowanego pola [H10]. |
| `files` | brak | `workspace/` nie jest częścią profilu [H12]. |
| manifest `name` | `display_name` z `profile.yaml` albo id profilu | |
| `x-hermes` | `{ profile: "<id>", baseUrl?, timezone?, routines: { "<name>": { deliver?, workdir?, skills?, enabled_toolsets?, repeat?, origin? } } }` | |

`cacheIdentity` = rzeczywista ścieżka profilu (`realpath`), bo `default` w dwóch `HERMES_HOME` to dwa różne agenty.

### 4.4 `write`

- Cel: **profil nazwany** `profiles/<slug>/` w katalogu domowym, nigdy profil domyślny (zapis do `default` nadpisywałby konfigurację użytkownika). `slug` jak w adapterze `folder`. Nowy profil dostaje `profile.yaml` z `display_name: <name>` i, jeśli manifest ma `title`, `description: <title>`.
- `SOUL.md` = persona + sekcja instrukcji (3.9). `config.yaml`: w nowym profilu `model: { default, provider }` z pierwszej preferencji, która ma `model`; w istniejącym profilu `config.yaml` nie jest dotykany, a model trafia do `approximated` („kept the profile's own model").
- Skille → `skills/<name>/` w profilu (reguła 3.5 dla kolizji; `.hub/` nietykane).
- Fakty → wpisy `memories/MEMORY.md` (rozdzielacz `\n§\n`), do limitu `memory.memory_char_limit` z `config.yaml` profilu (domyślnie 2200) [H3][H5], liczonego na całym pliku po zapisie. Przy `update` wpisy OpenTeleportu z poprzedniego zapisu są zastępowane (lista wpisów w znaczniku), wpisy obce zostają. Nadmiar → `skipped`. Notatki → `skipped` (`notes: false`), bo Hermes nie ma na nie miejsca, które by czytał.
- Rutyny → `cron/jobs.json` (4.5), **zawsze wstrzymane**: `enabled: false`, `state: "paused"`, `paused_reason: "imported by OpenTeleport; resume with: hermes cron resume <id>"`, `next_run_at: null` [H13]. Powód: `next_run_at` liczy Hermes przy tworzeniu i wznawianiu zadania, a OpenTeleport nie ma silnika cron, żeby policzyć je poprawnie w strefie profilu; zły termin odpaliłby zadanie natychmiast. `--enable-routines` daje więc dla Hermesa wpis `approximated` („Hermes jobs are written paused; resume them with `hermes cron resume <id>`") i ostrzeżenie z gotowymi poleceniami, po jednym na rutynę. Rutyna, która w Hermesie ma wrócić do życia, wraca przez `hermes cron resume`, które liczy termin po stronie Hermesa.
- Znacznik `.openteleport.json` w katalogu profilu: `{ id, movedAt, cronJobIds: string[], memoryEntries: string[], skills: Record<string, string> }` (reguły 3.4 i 3.5). Nie jest jednym z sześciu plików, po których Hermes poznaje profil [H4], więc niczego w Hermesie nie zmienia. Przy `update` zadania o zapisanych id i wpisy o zapisanej treści są zastępowane, reszta zostaje.
- Wynik: `done`. Ostrzeżenia zawsze: „Restart the Hermes gateway (if it is running) so it picks up the profile and its cron jobs" i „Hermes scans memory entries and cron prompts for prompt injection; an entry it rejects is dropped on its side" [H7][H14]. Nie próbujemy wykrywać działającego gatewaya (brak udokumentowanego sposobu [ZAŁ]).
- `capabilities`: `persona: true, instructions: true, skills: true, routines: true, facts: true, notes: false, files: false, avatar: false, models: true, schedules: ["cron","every","at"]`.

### 4.5 Harmonogramy

Hermes `schedule.kind` ↔ `Schedule`:

| Hermes [H13] | `Schedule` | Uwagi |
|---|---|---|
| `cron {expr, display}` | `{kind:"cron", expression: expr}` | `display` odtwarzane z wyrażenia przy zapisie. |
| `interval {minutes}` | `{kind:"every", every}` | Minuty → `Nd` gdy podzielne przez 1440, `Nh` gdy przez 60, inaczej `Nm`; odwrotnie przy zapisie. |
| `once {run_at}` | `{kind:"at", at}` | `run_at` bez offsetu interpretowany w strefie Hermesa (4.5, strefa); zapisany jako ISO z offsetem. Przy zapisie termin z przeszłości → `skipped` („Hermes rejects past one-off jobs"). |

Strefa czasowa Hermesa jest globalna: `ctx.env.HERMES_TIMEZONE`, inaczej `timezone` z `config.yaml` profilu, inaczej strefa procesu (`Intl.DateTimeFormat().resolvedOptions().timeZone`) [H15]. Przy odczycie każda rutyna dostaje tę strefę. Przy zapisie rutyna z inną strefą niż strefa profilu jest zapisana bez zmian wyrażenia i oznaczona `approximated` („Hermes has one time zone per profile; this routine assumed <tz>").

Pola zadania przy zapisie: `id` (12 znaków hex, losowe), `name`, `prompt` = `instruction`, `schedule` (z `display` = `describeSchedule`), `schedule_display` (to samo), `enabled: false`, `state: "paused"`, `paused_at` (ISO), `paused_reason`, `created_at` (ISO), `next_run_at: null`, `last_run_at: null`, `last_status: null`, `repeat: null`, `origin: "openteleport"`, `deliver: "local"`, reszta z `x-hermes.routines[name]`, jeśli jest (wartości z `x-hermes` nie nadpisują `enabled`, `state`, `next_run_at`). Wykonawca sprawdza w `cron/jobs.py` [H13] nazwy i wartości domyślne pól i poprawia listę, jeśli kod mówi inaczej. Plik zapisany jako `{"jobs": [...], "updated_at": "<ISO>"}`; przy odczycie dopuszczalny też goły `[...]` [H13][H20]. Zadania obce w pliku zostają bajt w bajt na poziomie wartości (to samo JSON po ponownej serializacji).

### 4.6 Testy

Fixture `test/fixtures/hermes/home/` z profilem domyślnym i jednym nazwanym (`SOUL.md` ze znacznikiem i bez, `memories/MEMORY.md` z trzema wpisami, w tym jednym >500 znaków, `cron/jobs.json` z trzema rodzajami harmonogramu, `skills/` z kategorią i `.hub/`, `config.yaml` z `model`, `timezone`, `memory.memory_char_limit`). Testy: `list`, `read` → oczekiwany `Bundle`, `write` nowego profilu, `update` tego samego id (bez `-N`), kolizja nazwy, limit pamięci, strefa, atomowość (`.bak`), Windows `%LOCALAPPDATA%`.

## 5. Adapter `codex` (OpenAI Codex)

Nazwa CLI `codex`, `displayName` „Codex". Pewność: wysoka dla instrukcji i skilli, niska dla pamięci.

### 5.1 Położenie i wykrywanie

- Katalog domowy: `ctx.env.CODEX_HOME`, inaczej `<home>/.codex` (także na Windows [C12]).
- Katalog skilli użytkownika: `<home>/.agents/skills` [C1]; przestarzały `<CODEX_HOME>/skills` jest czytany, nigdy zapisywany [C10].
- `detect`: `found` = w katalogu domowym istnieje którykolwiek z `config.toml`, `AGENTS.md`, `auth.json`, `agents/`, `memories/` (świeża instalacja ma tylko `auth.json` [C5]); `hint` = „Install Codex or pass --source-dir <CODEX_HOME>".

### 5.2 `list`

- `default`: globalna konfiguracja (`AGENTS.md` + skille użytkownika). Nazwa „Codex (global)".
- Każdy plik `<CODEX_HOME>/agents/<plik>.toml` [C7]: `id` = nazwa pliku bez rozszerzenia, `name` = pole `name`, `title` = `description`.

### 5.3 `read`

| `Bundle` | `default` | `agents/<x>.toml` |
|---|---|---|
| `persona` | sekcja przed znacznikiem w `AGENTS.md`, jeśli znacznik jest; inaczej brak | j.w. w `developer_instructions` |
| `instructions` | `AGENTS.override.md`, jeśli niepusty, inaczej `AGENTS.md` [C2]; część po znaczniku lub cały plik | `developer_instructions` (część po znaczniku lub całość) |
| `skills` | `~/.agents/skills/*/SKILL.md` + `<CODEX_HOME>/skills/*/SKILL.md` (kolizja nazw → skill z `~/.agents` wygrywa, ostrzeżenie) | brak (skille są globalne; `skills.config` z pliku agenta → `x-codex.skillsConfig`) |
| `routines` | brak | brak |
| `facts` | brak | brak |
| `notes` | `<CODEX_HOME>/memories/MEMORY.md` jako jedna notatka `codex-memory`, jeśli istnieje, z ostrzeżeniem „Codex memory is machine-generated; carried as a note" [C9][C13] | brak |
| `models` | `config.toml`: `model` → `model`, `model_provider` → `provider` (jeśli jest) [C3] | `model` z pliku agenta |
| `x-codex` | `{ reasoningEffort: model_reasoning_effort?, approvalPolicy?, sandboxMode? }` | `{ reasoningEffort?, nickname_candidates?, skillsConfig? }` |
| manifest `name` | „Codex" | `name` z pliku |

TOML przez pakiet `smol-toml` (parser i serializator, ESM, bez zależności). `cacheIdentity` = rzeczywista ścieżka `CODEX_HOME` (dla `default`) lub pliku agenta.

### 5.4 `write`

- Cel: zawsze **plik agenta** `<CODEX_HOME>/agents/<slug>.toml` [C7] z polami `name` (= `manifest.name`), `description` (= `title` albo pierwsza linia instrukcji, ≤120 znaków), `developer_instructions` (= persona + sekcja instrukcji, 3.9), `model` (pierwsza preferencja z `model`), `model_reasoning_effort` (z `x-codex.reasoningEffort`, jeśli jest). Fakty → na końcu `developer_instructions` jako sekcja `# Facts` z listą punktów (`approximated`). Nigdy nie piszemy do `AGENTS.md` ani `config.toml` użytkownika: to by nadpisało jego globalną konfigurację jednym poleceniem.
- Skille → `<home>/.agents/skills/<name>/` (reguła 3.5). Ostrzeżenie zawsze przy skillach: „Codex skills are shared by every tool reading ~/.agents/skills" [C1][G10].
- Mapa `<CODEX_HOME>/openteleport-ids.json` (slug pliku agenta → id; reguła 3.4). Codex czyta z `agents/` tylko pliki `.toml` [C7], a plik mapy leży poziom wyżej, więc nie koliduje.
- Wynik: `done`; `nextStep` nie jest potrzebny, ale raport dostaje ostrzeżenie „Use the agent in Codex as @<slug> (custom agents need `agents.enabled`, on by default)" [C4][C7].
- `capabilities`: `persona: true` (przybliżona do `developer_instructions`), `instructions: true, skills: true, routines: false, facts: true` (przybliżone), `notes: false, files: false, avatar: false, models: true, schedules: []`.

Uzasadnienie wyboru pliku agenta jako celu: to jedyny obiekt w Codexie, który ma nazwę, opis, własne instrukcje i model, czyli jedyny, który odpowiada „agentowi" z `.jetpack`, i jedyny, którego zapis niczego użytkownikowi nie psuje.

### 5.5 Testy

Fixture `test/fixtures/codex/` z `home/.codex/` (`AGENTS.md` ze znacznikiem, `config.toml` z `model`, `agents/reviewer.toml`, `memories/MEMORY.md`, przestarzałe `skills/old/SKILL.md`) i `home/.agents/skills/new/SKILL.md`. Testy: `list` (default + reviewer), `read` obu, `write` nowego agenta (plik TOML parsowalny przez `smol-toml`, pola w komplecie), `update`, kolizja skilla o innej treści (`-N`), nieznane klucze w `config.toml` nietknięte (nie piszemy go wcale: test sprawdza, że bajty są identyczne po `write`).

## 6. Adapter `openbot` (OpenBot)

Nazwa CLI `openbot`, `displayName` „OpenBot". Pewność: wysoka dla formatu zipa, średnia dla bazy SQLite (schemat bez wersji).

### 6.1 Położenie i wykrywanie

- `userData` Electrona: Windows `%APPDATA%\OpenBot` (z `ctx.env.APPDATA`, fallback `<home>\AppData\Roaming\OpenBot`), macOS `<home>/Library/Application Support/OpenBot`, Linux `<home>/.config/OpenBot` (Załącznik A). Plik bazy: `<userData>/openbot.db` (sprawdzone 28.10.2026 w `src/backend/database/database-core.ts`: `join(options.userDataPath, "openbot.db")`; dziennik WAL `openbot.db-wal`). Schemat jest wersjonowany tabelą `schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT)`; ostatnia znana migracja to 47 (`src/backend/openbot-database-schema.ts`, 28.10.2026). Tabele z Załącznika A istnieją; `projection_agent_routines` ma dodatkowe kolumny `limit_policy` i `missed_policy`; `projection_agent_memories` ma `UNIQUE(agent_id, normalized_text)`. Żadna tabela w tym pliku nie wiąże agenta ze skillami.
- `--source-dir` wskazuje `userData` albo plik zip (sekcja 9.4).
- `detect`: `found` = plik bazy istnieje; `hint` = „Install OpenBot, or pass --source-dir <export.zip> (OpenBot: Server settings → Export; Grok Bot: the OpenBot export skill)".

### 6.2 `list` i `read` z bazy

- Baza jest **kopiowana** (plik + `-wal` + `-shm`, jeśli istnieją) do katalogu tymczasowego i otwierana **tylko do odczytu** przez wbudowany moduł `node:sqlite` (Node 24.11 ma go bez flagi, ale import wypisuje na stderr `ExperimentalWarning: SQLite is an experimental feature`; sprawdzone 28.10.2026). Import jest leniwy (dopiero w `list`/`read`), a na czas `await import("node:sqlite")` adapter podmienia `process.emitWarning` na filtr, który pomija ostrzeżenie o nazwie `ExperimentalWarning` z „SQLite" w treści, i przywraca oryginał zaraz po imporcie; test CLI sprawdza, że stderr nie zawiera `ExperimentalWarning`. Nigdy nie otwieramy pliku, którego używa działająca aplikacja. Jeśli `node:sqlite` nie jest dostępny (starszy Node), `list`/`read` z bazy zgłasza błąd z podpowiedzią „Use Node 24 or pass --source-dir <export.zip>".
- Tabele (Załącznik A): `projection_agents(agent_id, model, agent_json)` → `agent_json` `{ name, title, description, provider, model, reasoningEffort, avatarSeed, avatarHue, avatar, workspacePath, notifications }`; `projection_agent_memories(agent_id, text, origin)`; `projection_agent_routines(routine_id, agent_id, name, instruction, active, timezone)`; `projection_routine_triggers(routine_id, schedule_json)`.
- Mapowanie: `description` → `instructions`; brak persony (`SOUL.md` nie istnieje w OpenBocie); `memories.text` → `facts` (≤500) lub `notes` (`memory-<n>`); rutyny → sekcja 9.2 (`limit_policy`, `missed_policy` → `x-openbot.routines[name]`); `provider` w OpenBocie to **runtime**, nie dostawca modelu (Załącznik A), więc `models[0] = { runtime, provider?, model }` wg tabeli: `claude` → `runtime: "claude-code", provider: "anthropic"`; `codex` → `"codex"`, `"openai"`; `gemini` → `"gemini-cli"`, `"google"`; `grok` → `"grok"`, `"xai"`; `opencode`, `cursor`, `cline` i każda inna wartość → `runtime` równy tej wartości, bez `provider` (wielodostawcze); `model` zawsze przepisany. Ta sama tabela w `src/formats/openbot-zip.ts` dla pliku transferu (9.2), jako jedna funkcja `openBotModelPref(provider, model)`; `reasoningEffort`, `avatarSeed`, `avatarHue`, `notifications`, `workspacePath` → `x-openbot`; `avatar` (jeśli to ścieżka do pliku ≤512 KB PNG/JPEG/WebP) → `avatar`; skille: baza nie wiąże agenta ze skillami, więc z bazy nie są czytane, z ostrzeżeniem „skills are not readable from the OpenBot database; export from the app (a transfer zip) carries them"; pliki: `workspacePath` → `files` tylko z `--include-files`.
- Przed odczytem adapter sprawdza `MAX(version)` w `schema_migrations`: większa niż 47 → ostrzeżenie „OpenBot database is newer (schema 52) than this adapter knows (47); check the result"; brak którejś z czterech tabel lub kolumny → błąd „OpenBot database schema not recognised; export from the app and pass --source-dir <zip>". Schemat (CREATE TABLE czterech tabel plus `schema_migrations`) jest zapisany w `test/fixtures/openbot/schema.sql` i to z niego test buduje bazę.

### 6.3 `list` i `read` z zipa

Sekcja 9. Oba formaty (`openbot-agent-import` i `openbot-instance-transfer`).

### 6.4 `write`

- Buduje zip `openbot-agent-import` v1 (9.3) do `<targetDir ?? cwd>/<slug>-openbot-import.zip` (konflikt nazwy pliku wg reguły 3.4 o artefaktach `handoff`: ten sam id w `x-openteleport` → nadpisanie przy `update`, inaczej `-N`).
- Wynik: `handoff`, `artifactPath` = ten plik, `nextStep` = „Open OpenBot → Server settings → Import and choose <plik>". Team API nie jest używane (sekcja 1, pkt 4).
- `capabilities`: `persona: true` (sklejana z instrukcjami do `description`, `approximated`), `instructions: true, skills: true, routines: true, facts: true, notes: false` (OpenBot ma tylko krótkie wspomnienia), `files: true, avatar: true, models: false` (zip nie ma pola modelu), `schedules: ["cron","every"]`.

### 6.5 Testy

Fixture: mała baza SQLite zbudowana w teście przez `node:sqlite` z tabelami z Załącznika A (dwóch agentów, trzy wspomnienia, rutyny każdego rodzaju), zip importu i zip transferu (9.5). Testy: `list`/`read` z bazy, z obu zipów, `write` → zip, którego `openbot-import.json` przechodzi walidację limitów z 9.3, round-trip zip → Bundle → zip bez zmian w polach, odmowa przy nieznanym schemacie, kopia bazy (oryginał nie jest otwierany: test zamyka plik bazy na wyłączność na Windows i sprawdza, że `read` działa na kopii).

## 7. Adapter `grok-bot` (Grok Bot, xAI)

Nazwa CLI `grok-bot`, `displayName` „Grok Bot". Pewność: wysoka dla zipa, brak dla czegokolwiek innego.

### 7.1 Wykrywanie i odczyt

- Grok Bot nie ma lokalnego magazynu agentów [G16]. `detect` zawsze `found: false`, `hint` = „Grok Bot keeps agents in the cloud. Ask your Bot to run the OpenBot export skill, then pass --source-dir <openbot-export-*.zip>". Z `--source-dir <zip>` `detect` zwraca `found: true`, `location` = zip.
- `list`/`read`: wyłącznie z zipa `openbot-agent-import` v1 (9.1). `source.app` w manifeście zipa inne niż `grok-bot` → ostrzeżenie, nie błąd. `origin.app` w manifeście `.jetpack` = `grok-bot`.

### 7.2 `write`: pakiet do wklejenia

Grok Bot nie importuje niczego poza pamięcią w ustawieniach [G2]. Zapis tworzy katalog `<targetDir ?? cwd>/<slug>-for-grok-bot/` (`-N` przy kolizji) z:

- `README.md`: kroki po kolei: 1) utwórz Bota o nazwie `<name>`; 2) wklej treść `1-paste-into-chat.md` jako pierwszą wiadomość; 3) dla każdego skilla wklej `skills/<name>/SKILL.md` z poleceniem „Save this as a skill named <name>"; 4) dla każdej rutyny wklej linię z `3-routines.md`; 5) opcjonalnie Settings → General → Import → Add to Memory z plikiem `2-memory.txt`.
- `1-paste-into-chat.md`: „From now on, this is who you are and how you work:", persona, instrukcje, potem „Remember these facts:" z listą faktów.
- `2-memory.txt`: fakty, jeden na linię (format importu pamięci nie jest udokumentowany; tekst jest najbezpieczniejszy).
- `3-routines.md`: jedna linia na rutynę: „Create a routine named "<name>" that runs <harmonogram słowami>: <instrukcja>", plus „(paused)" dla wyłączonych. Harmonogram słowami z istniejącego `describeSchedule(schedule, timezone)` w `src/core/schedule.ts`.
- `skills/<name>/` skopiowane w całości.
- `.openteleport.json` w korzeniu katalogu (reguła 3.4 o artefaktach `handoff`: ten sam id → nadpisanie przy `update`, inaczej `-N`).
- Wynik: `handoff`, `artifactPath` = katalog, `nextStep` = „Open <katalog>/README.md and follow the five steps in Grok Bot".
- `capabilities`: `persona: true, instructions: true, skills: true, routines: true, facts: true, notes: false, files: false, avatar: false, models: false, schedules: ["cron","every","at"]`.

To jest szczere „jedno polecenie plus kilka wklejeń". README mówi wprost, że Grok Bot nie ma importu, więc OpenTeleport przygotowuje wszystko, czego Bot potrzebuje w rozmowie.

### 7.3 Testy

Fixture: zip `openbot-agent-import` z `source.app = "grok-bot"` (9.5). Testy: `detect` bez i z zipem, `list`/`read`, `write` → katalog z pięcioma elementami, treść `3-routines.md` dla trzech rodzajów harmonogramu, `-N`.

## 8. Adapter `letta` (Letta Code)

Nazwa CLI `letta`, `displayName` „Letta Code". Pewność: średnia. Zapis to `handoff`, bo nie ma udokumentowanej, bezpiecznej drogi do utworzenia agenta z promptem systemowym z plików (sekcja 1, pkt 1; research 4.5).

### 8.1 Położenie i wykrywanie

- Katalog: `<home>/.letta` (brak udokumentowanej zmiennej; `--source-dir` nadpisuje).
- Agenci Cloud z lokalną pamięcią: `<letta>/agents/<agentId>/memory/` [L18]. Agenci backendu lokalnego: `<letta>/lc-local-backend/agents/<agentId>.json` (rekord `{ id, name, description, system, tags, model, model_settings, hidden, compaction_settings }`) i `<letta>/lc-local-backend/memfs/<agentId>/memory/` [L15][L16]; `ctx.env.LETTA_LOCAL_BACKEND_DIR` nadpisuje katalog backendu.
- Harmonogramy: `<letta>/crons.json` `{ version: 1, tasks[] }` [L17].
- `detect`: `found` = istnieje `agents/` lub `lc-local-backend/` lub `crons.json`; `hint` = „Install Letta Code (npm i -g @letta-ai/letta-code) or pass --source-dir <~/.letta>".

### 8.2 `list`

- Backend lokalny: każdy `lc-local-backend/agents/*.json` → `id` = `id` z rekordu, `name` = `name`, `title` = `description`, `location` = katalog MemFS.
- Cloud: każdy `agents/<agentId>/` z katalogiem `memory/` → `id` = `agentId`, `name` = `name` z frontmattera `memory/persona.md`, jeśli jest, inaczej `agentId`; `location` = katalog. Rekordu z nazwą nie ma lokalnie [ZAŁ research 7.4], więc nazwa jest przybliżona.

### 8.3 `read`

| `Bundle` | Letta Code MemFS [L10] | Reguła |
|---|---|---|
| `persona` | `memory/persona.md` (treść bez frontmattera) | Frontmatter `name`, `description` → manifest `name`, `title`, gdy rekordu brak. |
| `instructions` | `system` z rekordu lokalnego; dla Cloud: `memory/instructions.md`, jeśli istnieje (plik, który sam zapisujemy); inaczej pusty | |
| `skills` | `memory/skills/<name>/SKILL.md` [L13] | Skille maszyny (`~/.letta/skills`) i projektu nie są czytane (nie należą do agenta). |
| `routines` | `crons.json` → `tasks[]` z `agent_id` = id agenta [L17] | `cron` + `timezone` → `{kind:"cron"}`; `scheduled_for` (ISO UTC) → `{kind:"at"}`; `status` `active` → `enabled: true`, `paused` → `false`; `fired`, `missed`, `cancelled` → pominięte z ostrzeżeniem. `description`, `conversation_id` → `x-letta.routines[name]`. |
| `facts` | linie-punkty (`- ` lub `* `) z `memory/human.md`, ≤500 znaków | Reszta `human.md` → notatka `human`. |
| `notes` | każdy inny plik `.md` w korzeniu `memory/` (poza `MEMORY.md`, `persona.md`, `human.md`, `instructions.md`) oraz `memory/reference/*.md` | Nazwa = ścieżka względna bez `.md`, `/` → `--` (notatki są płaskie). `MEMORY.md` (indeks MemFS) nie jest przenoszony: to spis treści, nie treść. |
| `models` | `model` z rekordu (uchwyt `provider/model` [L20]) → `{ provider, model }` | Cloud bez rekordu: brak. |
| `x-letta` | `{ agentId, backend: "local"|"cloud", tags?, model_settings?, routines }` | |
| `avatar`, `files` | brak | |

`cacheIdentity` = rzeczywista ścieżka katalogu `memory/`.

### 8.4 `write`

- Tworzy katalog `<targetDir ?? cwd>/<slug>-letta-memory/` (`-N` przy kolizji) w układzie MemFS v2: `MEMORY.md` (indeks: lista plików z jednolinijkowym opisem, format z [L10]), `persona.md` (frontmatter `name`, `description` + persona), `instructions.md` (instrukcje; plik w korzeniu jest pamięcią rdzeniową ładowaną co turę [L10], więc działa jak instrukcje; `approximated`), `human.md` (fakty jako punkty), `reference/<note>.md` (notatki, z własnym `reference/MEMORY.md` jako indeksem), `skills/<name>/`.
- Obok: `letta-commands.sh` (i `letta-commands.ps1`) jako **skrypt do uruchomienia, nie do edycji**: 1) `letta agents create --name "<name>" --description "<title>" [--model "<provider/model>"]` (model z pierwszej preferencji, która ma `provider` i `model` [L9][L20]; `approximated`, bo uchwyt może nie istnieć w Lecie); 2) pytanie o id: `read -r -p "Agent id printed above: " AGENT_ID` / `$AGENT_ID = Read-Host "Agent id printed above"` (kształt JSON z `agents create` nie jest potwierdzony, więc skrypt nie parsuje go sam); 3) `letta memory restore --agent "$AGENT_ID" --from "<katalog>/memory" --force` [L19]; 4) po jednym `letta cron add --name "..." --prompt "$(cat "<katalog>/routines/<slug>.txt")" --cron "..." --agent "$AGENT_ID"` (lub `--at "<ISO>"`) na rutynę [L9][L12], z instrukcją w pliku `routines/<slug>.txt` (prompt wieloliniowy w ps1: `(Get-Content -Raw ...)`); rutyny wyłączone są w skrypcie zakomentowane z linią `# paused in the source; uncomment to add it` (CLI nie ma flagi pauzy [L9]). Układ MemFS leży w podkatalogu `memory/`, żeby `restore --from` dostał czysty katalog pamięci. `every` → cron (`*/30 * * * *` dla `30m`, `0 */2 * * *` dla `2h`, `0 0 */3 * *` dla `3d`), `approximated`.
- `.openteleport.json` w korzeniu katalogu (reguła 3.4 o artefaktach `handoff`), poza `memory/`, żeby nie trafił do MemFS.
- Wynik: `handoff`, `artifactPath` = katalog, `nextStep` = „Run <katalog>/letta-commands.sh (or .ps1): it creates the agent, restores its memory and adds the routines". Ostrzeżenia: „`letta memory restore` replaces the agent's whole memory directory; the script runs it on the new agent only" [L19] oraz „Letta's `memory restore --from <dir>` is documented for backups made by `memory backup`; a plain memory folder is assumed to work (unverified)".
- `capabilities`: `persona: true, instructions: true` (przybliżone), `skills: true, routines: true, facts: true, notes: true, files: false, avatar: false, models: true` (przybliżone: trafiają do `--model`), `schedules: ["cron","every","at"]`.

Uzasadnienie `handoff`: zapis bezpośredni do `lc-local-backend/` wymagałby odtworzenia rekordu agenta z kodu bez wersji schematu i commitów w repozytorium git MemFS, których wymogi nie są potwierdzone [ZAŁ research 7.4]. Trzy polecenia CLI, które Letta sama dokumentuje, są bezpieczniejsze. Awans do `done` to kandydat v0.3 po weryfikacji na prawdziwej instalacji.

### 8.5 Testy

Fixture `test/fixtures/letta/home/.letta/` z jednym agentem lokalnym (rekord + MemFS z `persona.md`, `human.md`, `reference/notes.md`, `skills/x/SKILL.md`) i jednym Cloud (tylko `agents/<id>/memory/`), `crons.json` z trzema zadaniami (active, paused, scheduled_for). Testy: `list`, `read` obu, `write` → katalog + skrypty (treść poleceń, cytowanie argumentów z cudzysłowami i znakami nowej linii; w skrypcie prompt wieloliniowy jest zapisany do pliku i przekazany przez `--prompt "$(cat ...)"` w sh / `(Get-Content -Raw ...)` w ps1), round-trip MemFS → Bundle → MemFS.

## 9. Moduł `src/formats/openbot-zip.ts`

Jeden moduł, bez zależności od adapterów, z testami własnymi w `test/formats/openbot-zip.test.ts`.

### 9.1 Odczyt `openbot-agent-import` v1 [G12]

`readOpenBotImportZip(bytes): { agents: ImportedAgent[]; channels: unknown[]; warnings: string[] }`, gdzie `ImportedAgent` to `Bundle` bez manifestu plus `key`. Czyta `openbot-import.json` (`format: "openbot-agent-import"`, `version: 1`, `source.app`, `source.exportedAt`), per agent: `key`, `name`, `title`, `description` → `instructions` (jeśli jest `agents/<key>/files/INSTRUCTIONS.md`, bierze pełny tekst stamtąd), `avatar`, `skills[]` → katalogi `agents/<key>/skills/<name>/`, `routines[]` (9.2), `memories[]` → `facts`, `files` → `files` (tylko gdy wołający poda `includeFiles`). Kanały są zwracane surowo (bez mapowania; `warnings` mówi, że kanały nie są przenoszone). Zip czytany tą samą dwuprzebiegową, limitowaną ścieżką co `.jetpack` (`src/core/bundle.ts` eksportuje czytnik zipów lub wykonawca wyciąga go do `src/core/zip.ts`; limity: 500 MB i 5000 plików dla tego formatu [G12], ale nasze 100 MB na `files/` i 2 MiB na plik tekstowy zostają).

### 9.2 Odczyt `openbot-instance-transfer` v1 (Załącznik A)

`readOpenBotTransferZip(bytes)`: `openbot-transfer.json` (`format: "openbot-instance-transfer"`, `version: 1`, `source { appVersion, exportedAt }`, `agents[]`, `settings`, `shared` (`null` lub `"shared"`), `signedIn[]`; sprawdzone 28.10.2026 w `src/main/instance-transfer-manifest.ts`), `agents[]` z `key, name, title, description, avatarSeed, avatarHue, avatar, provider, model, reasoningEffort, notifications, busyMessageMode?, taskLimit?, skills[], files, routines[] (key, name, instruction, active, timezone, schedule, limitPolicy?, missedPolicy?), oneTimeRoutines?[], memories[] ({ text, inclusion?: "essential" | "searchable" })`. Ścieżki `avatar`, `files`, `skills[]` zaczynają się od `agents/<key>/`. Mapowanie jak 9.1 plus `provider`/`model` → `models`, `reasoningEffort`, `avatarSeed`, `avatarHue`, `notifications`, `busyMessageMode`, `taskLimit` → `x-openbot`, `limitPolicy`, `missedPolicy` → `x-openbot.routines[name]`, `oneTimeRoutines` → rutyny `at` (`once {date, time}` w strefie rutyny), `inclusion` → `x-openbot.memories` (lista `{ text, inclusion }` tylko dla wpisów z `inclusion`). `settings`, `shared/` i `signedIn` ignorowane z ostrzeżeniem.

Harmonogramy OpenBota ↔ `Schedule`:

| OpenBot | `Schedule` |
|---|---|
| `hourly{minute}` | cron `M * * * *` |
| `daily{time: "HH:MM"}` | cron `m h * * *` |
| `weekdays{time}` | cron `m h * * 1-5` |
| `weekly{weekday 0–6, time}` | cron `m h * * W` |
| `monthly{day, time}` | cron `m h D * *` |
| `interval{amount, unit: minutes|hours|days, anchorAt?}` | `every` `Nm`/`Nh`/`Nd` (min. 3 minuty przy zapisie: mniejsze → `skipped`; `anchorAt` → `x-openbot.routines[name]`) |
| `advanced{months[], days[], time}` | cron `m h D1,D2,... M1,M2,... *` (listy w polach dnia i miesiąca) |
| `custom{expression}` | cron `expression` |
| `once{date: "YYYY-MM-DD", time}` (tylko transfer; `oneTimeRoutines[]`) | `at` = `date`T`time` w strefie rutyny, zapisane jako ISO z offsetem |

Kształty `schedule` pochodzą z `packages/contracts/src/ipc-routines.ts` (28.10.2026): `hourly`, `daily`, `weekdays`, `weekly`, `monthly`, `interval`, `advanced`, `custom`, `once`; `once` nie występuje w formacie importu. Przy zapisie w drugą stronę cron jest rozpoznawany: pięć pól, gdzie pasuje do jednego z wzorców wyżej (także `advanced` dla list w polach dnia i miesiąca z `*` w dniu tygodnia), wraca do kształtu nazwanego, inaczej `custom`. Funkcje mapujące (`fromOpenBotSchedule`, `toOpenBotSchedule`) żyją w `src/core/schedule.ts` jako czyste funkcje z testami, nie w module zipa.

### 9.3 Zapis `openbot-agent-import` v1

`writeOpenBotImportZip(bundles: Bundle[], opts: { app: string; includeFiles: boolean }): { bytes: Uint8Array; items: WriteResult["items"] }`. Reguły i limity [G12]:

- `key` = slug nazwy (≤64, `[a-z0-9-]`), `name` ≤80, `title` ≤120.
- `description` = persona + pusta linia + instrukcje; gdy >2000 znaków: pierwsze 2000 znaków przycięte do ostatniej pełnej linii, a pełny tekst w `agents/<key>/files/INSTRUCTIONS.md` (`approximated`).
- `avatar` → `agents/<key>/avatar.<ext>` (≤512 KB, PNG/JPEG/WebP; inne → `skipped`).
- `skills` ≤32 (nadmiar → `skipped`), każdy folder ≤10 MB i ≤200 plików (większy → `skipped`).
- `routines` ≤64; `enabled` → `active`; harmonogram wg 9.2; `at` → `skipped`.
- `memories` = `facts` ≤64 × ≤500 (nadmiar → `skipped`); notatki nie mają miejsca → to engine je zdejmuje (`notes: false`).
- `files` tylko z `includeFiles`; odrzucane ścieżki jak w `.jetpack` (`.env*`, klucze prywatne, archiwa, `.git`, `node_modules`).
- `source: { app: opts.app, exportedAt: ISO }`. Dodatkowo manifest zipa dostaje `x-openteleport: { id: <jetpack id>, version: <wersja OpenTeleportu> }` (klucz spoza schematu OpenBota; wykonawca sprawdza w `agent-import-v1.ts`, czy importer odrzuca nieznane klucze; jeśli tak, id trafia do `agents/<key>/files/.openteleport.json` zamiast do manifestu).

### 9.4 `--source-dir` jako zip

Dla `openbot` i `grok-bot`: gdy `ctx.sourceDir` wskazuje plik (nie katalog) z rozszerzeniem `.zip`, `list` zwraca agentów z zipa (`id` = `key`, `name`, `title`, `location` = `<zip>#<key>`), `read` czyta po `key` lub nazwie. Format rozpoznawany po obecności `openbot-import.json` lub `openbot-transfer.json` w korzeniu. `manifest.id` = `x-openteleport.id` z manifestu zipa, jeśli jest (zip, który OpenTeleport sam zbudował), inaczej puste. `cacheIdentity` dla zipa = `zip:<format>:<key>` (bez daty eksportu i bez ścieżki), żeby ponowny eksport tego samego Bota i ponowne `move` aktualizowały cel w miejscu, a nie tworzyły `-2`; dla bazy OpenBota = `<realpath userData>#<agent_id>`.

### 9.5 Fixture'y

`test/fixtures/openbot/`: katalog `import-v1/` (dwóch agentów: jeden pełny z avatarem, skillami, ośmioma rutynami po jednej na rodzaj harmonogramu importu, 3 wspomnieniami, plikami; drugi minimalny; plus jeden kanał) i `transfer-v1/` (jeden agent z `oneTimeRoutines`, `advanced` i `settings`). Zipy nie są wersjonowane: helper `test/helpers/zip.ts` (`zipDirectory(dir): Promise<Uint8Array>` i `zipDirectoryToFile(dir, file)`) pakuje katalog fixture'a w teście, więc diff w PR pokazuje pliki, nie bajty.

## 10. Prostsze CLI

### 10.1 Kreator: `npx openteleport` bez argumentów

- Warunek: brak argumentów i `process.stdin.isTTY && process.stdout.isTTY`. Bez TTY: pomoc na stdout i kod 2 (z `--json`: `{ error: { code: 2, message: "No command given" } }`).
- Przebieg (`@clack/prompts`, już w zależnościach): `intro("OpenTeleport")` → `detect` wszystkich adapterów równolegle → wybór źródła spośród adapterów z `found: true` (pozostałe wyszarzone z `hint`; adaptery czytające tylko zip, jak `grok-bot`, mają w `hint` polecenie `openteleport list --from grok-bot --source-dir <zip>`) → `list` → wybór agenta (gdy jeden, wybierany bez pytania, ale pokazany) → wybór celu: adaptery znalezione lub z `createsOnWrite` (reguła 3.4a) plus pozycja „Save as a .jetpack file" (→ `export` do `<slug>.jetpack` w bieżącym katalogu) → podsumowanie jednym zdaniem („Move Reviewer from Claude Code to Hermes Agent. Routines arrive disabled. An agent of the same name is updated." albo dla celu `handoff`: „... OpenBot needs one more step after this, which the report names.") → `confirm` → wykonanie `moveCommand`/`exportCommand` z domyślnymi opcjami → zwykły raport. Każdy `isCancel` → „Cancelled.", kod 0.
- Kreator nie ma własnej logiki poza wyborem: woła te same funkcje z `src/commands/`, więc raport i kody wyjścia są identyczne z trybem poleceń.
- Tryb automatyczny testuje się przez wstrzyknięcie odpowiedzi: kreator przyjmuje interfejs `Prompter` (`select`, `confirm`), a `src/commands/wizard.ts` eksportuje `runWizard(prompter, ctx)`; testy podają sztuczny `Prompter`. Test CLI sprawdza tylko ścieżkę bez TTY (pomoc + kod 2).

### 10.2 Domyślnie bieżący katalog

- `export` bez `--from`: `--from folder`, agent = bieżący katalog (adapter `folder` już to obsługuje przez `--agent .`); wymaga `AGENTS.md` w bieżącym katalogu, inaczej błąd „No AGENTS.md here; pass --from <app> or run from an agent folder" (kod 2).
- `import <plik>` bez `--to`: `--to folder`, cel = `<cwd>/<slug>/` (jak dziś z `--to folder`).
- `move` nadal wymaga `--from` i `--to` (nie ma sensownego domyślnego celu).

### 10.3 Pomoc podstawowa i pełna

- `openteleport --help` pokazuje: polecenia `move`, `export`, `import`, `list`, `inspect` i flagi `--from`, `--to`, `--agent`, `--out`, `--include-files`, `--json`; na końcu linię „More: `openteleport --help-all` lists every command and flag".
- `openteleport --help-all` (oraz `<polecenie> --help-all`) pokazuje wszystko: `validate`, `adapters`, `--source-dir`, `--target-dir`, `--copy`, `--replace`, `--yes`, `--enable-routines`, `--keep`, `--quiet`, zmienne `OPENTELEPORT_HOME`, `OPENTELEPORT_EXTRA_ADAPTER`.
- Mechanika: opcje i polecenia zaawansowane są rejestrowane z `hideHelp()` / `{ hidden: true }`; `--help-all` to globalna opcja, która przed wypisaniem pomocy odkrywa je (commander `configureHelp` lub ponowne zbudowanie programu z flagą `showAll`). Wykonawca wybiera prostszy wariant; test sprawdza obecność i brak nazw w obu wyjściach.

## 11. Dwie poprawki

1. `src/commands/shared.ts`, `exitOnBrokenPipe`: `process.exit(0)` → `process.exit()`, żeby zachować `process.exitCode` ustawiony wcześniej (np. `validate` z błędem w potoku). Test: `validate` na niepoprawnym pliku z zamkniętym stdout kończy się kodem 1, nie 0.
2. `src/core/engine.ts`, `withId`: `cacheIdentity` jest wołane tylko, gdy `manifest.id === ""` (agent bez id), bo tylko wtedy klucz w `ids.json` jest potrzebny; adapter `folder` nie robi wtedy zbędnego `realpath`. Test: adapter pamięciowy z licznikiem wywołań `cacheIdentity`.

## 12. Dokumentacja i rejestracja

- `src/adapters/index.ts`: rejestracja pięciu adapterów w kolejności `folder`, `openclaw`, `claude-code`, `hermes`, `codex`, `openbot`, `grok-bot`, `letta` (`adapters` wypisuje w tej kolejności).
- README: tabela „Supported apps" z ośmioma wierszami (adapter | read | write | wynik `done`/`handoff` | uwagi), sekcja „Coming next" usunięta, sekcja „Quick start" zaczyna się od `npx openteleport` (kreator), poniżej trzy polecenia jak dziś.
- `CHANGELOG.md`: sekcja `0.2.0 (unreleased)` nad `0.1.0`.
- `docs/STATUS.md`: nowe adaptery w „What is done" z adnotacją „layout from documentation and source code, not yet verified on a real install" i osobną listą w „What is not verified yet"; obie poprawki znikają z „Known small issues"; „What comes next" → v0.3 (SSH, podpis, plugin OpenClaw, Letta Cloud REST, awans Letty i OpenBota do `done`, Codex automations po oficjalnym formacie).
- `docs/design.md`: na początku sekcji 8 jedno zdanie z odsyłaczem do tego dokumentu; pkt 4 listy adapterów („v0.2: ...") zastąpiony odsyłaczem.
- `docs/demo.md`: po jednym scenariuszu na nowy adapter (polecenie, oczekiwany wynik, co jest `handoff`).
- `CONTRIBUTING.md`, sekcja „Writing an adapter": odsyłacz do `src/adapters/marker.ts` i do sekcji 3 tego dokumentu jako checklisty.

## 13. Wersja i wydanie

`package.json` zostaje na `0.1.0`. v0.1.0 nie jest jeszcze wydane (brak `NPM_TOKEN`, daty w CHANGELOG i tagu). Właściciel ma dwie drogi: otagować `v0.1.0` na commicie sprzed scalenia v0.2 (f1ad906) i wydać dwie wersje, albo wydać od razu `0.2.0`. Decyzja należy do właściciela; `docs/STATUS.md` wymienia obie drogi.

## 14. Co zostaje wykonawcy

- Sygnatury helperów po wyciągnięciu z adapterów v0.1 (znacznik, 3.4; czytnik zipów, 9.1), byle oba adaptery v0.1 przeszły swoje testy bez zmian w fixture'ach.
- Mechanika `--help-all` w commanderze (10.3).
- Nazwa pliku bazy OpenBota i powiązanie agent→skill w bazie (6.2): do odczytania z repo `nightly-labs/openbot`; jeśli powiązania nie da się ustalić w rozsądnym czasie, skille z bazy nie są czytane, a ostrzeżenie z 6.2 to pokrywa.
- Czy importer OpenBota przyjmuje nieznany klucz `x-openteleport` w `openbot-import.json` (9.3).
- Układ fixture'ów i skrypt budujący zipy (9.5).

## 15. Kolejność i równoległość

1. Zadanie wstępne (sekwencyjne): `src/adapters/marker.ts`, `src/core/zip.ts` (czytnik), `createsOnWrite` (3.4a), fakty w `movedItems` (3.12), dwie poprawki z sekcji 11, zależność `smol-toml`, zmienne środowiska nowych adapterów w `test/helpers/cli.ts`. Potem wszystko inne może iść równolegle w osobnych worktree, bo każdy adapter to własny katalog `src/adapters/<name>/` i `test/adapters/<name>/`; jedyny wspólny plik to `src/adapters/index.ts` (jedna linia na adapter; kolizje scala kontroler).
2. `src/formats/openbot-zip.ts` + mapowanie harmonogramów w `src/core/schedule.ts` przed `openbot` i `grok-bot`.
3. Adaptery: `hermes`, `codex`, `letta` równolegle; `openbot` i `grok-bot` po module z pkt 2.
4. CLI (sekcja 10) równolegle z adapterami (dotyka `src/cli.ts`, `src/commands/`).
5. Rejestracja, README, CHANGELOG, STATUS, demo na końcu, po scaleniu (jeden plik `src/adapters/index.ts` i jedna tabela README zmieniane raz, nie pięć razy).
6. Przegląd całej gałęzi, PR do `main` (gałąź chroniona: CI na trzech systemach musi być zielone).
