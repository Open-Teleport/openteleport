# OpenTeleport: dokument projektu

Data: 2026-10-27. Status: do zatwierdzenia przez właściciela projektu przed pierwszym kodem.
Research, z którego wynika ten dokument: `docs/research/2026-10-27-open-projects-research.md`.

## 1. Jedno zdanie

Przenosisz swojego agenta AI z jednej aplikacji do drugiej jednym poleceniem.

```bash
npx openteleport move --from claude-code --to openclaw --agent reviewer
```

Działa dla każdego agenta, nie dla jednej aplikacji: źródłem i celem może być dowolny katalog projektu z `AGENTS.md` i skillami, OpenClaw, Claude Code, a w kolejnych wersjach OpenBot, Hermes, Codex, Grok Bot i Letta.

## 2. Po co to robimy

Agent AI w OpenBocie, OpenClaw, Hermesie czy Claude Code to zestaw: rola, instrukcje, skille, zaplanowane zadania, zapamiętane fakty, wymagane uprawnienia. Dziś ten zestaw żyje w formacie jednej aplikacji. Przeniesienie go gdzie indziej to ręczne przepisywanie.

Stan rynku (zweryfikowany 27.10.2026):

- OpenBot importuje z Grok Bota (zip z manifestem). Jednokierunkowo.
- Hermes importuje z OpenClaw, Claude Code, Codex, Cursor. Jednokierunkowo, do siebie.
- OpenClaw nie ma eksportu. Maintainer zamknął 24.10.2026 prośbę o "portable Agent Bundles" i wskazał: plugin albo nowa propozycja.
- Letta Agent File (.af): format tylko dla Letta, repo nieaktywne od roku.

Nie istnieje neutralny format, który działa między wieloma aplikacjami w obie strony. Każdy vendor buduje importer do siebie. Za pół roku każdy będzie miał własny format i neutralny nie będzie już możliwy. Dlatego teraz.

## 3. Cele

1. Jedno polecenie, zero konfiguracji: narzędzie samo wykrywa zainstalowane aplikacje i ich dane.
2. Nic nie ginie po cichu. Jeśli aplikacja docelowa czegoś nie obsługuje, użytkownik dostaje raport, co zostało pominięte i dlaczego.
3. Format jest otwarty, wersjonowany i opisany JSON Schema, tak żeby każdy vendor mógł go wspierać bez naszego udziału.
4. Sekrety nigdy nie trafiają do pliku. Plik agenta można bezpiecznie wysłać komuś.
5. Pierwsze trzy adaptery (`folder`, OpenClaw, Claude Code) działają w obie strony na prawdziwych danych, nie na przykładach.
6. Żadna aplikacja nie jest wyznacznikiem. Format opiera się na standardach, które już istnieją między narzędziami (AGENTS.md, Agent Skills, MEMORY.md), a nie na formacie jednego vendora.

## 4. Nie-cele (świadomie poza zakresem v0.x)

- Katalog, giełda, "zatrudnianie" agentów. To osobny projekt.
- Historia pracy, reputacja, podpisane paragony. To osobny projekt.
- Uruchamianie agentów. OpenTeleport tylko przenosi.
- Synchronizacja na żywo między aplikacjami. Przenosimy migawkę.
- Przenoszenie historii czatu. Przenosimy fakty wyciągnięte z pamięci, nie rozmowy.
- Przenoszenie wektorów/embeddingów pamięci. Tylko tekst.
- Przenoszenie sekretów (klucze API, tokeny, hasła, cookies).
- Własne GUI. Interfejsem jest jedno polecenie w terminalu. GUI może powstać później jako osobny pakiet.

## 5. Anty-cele (porażka, nawet jeśli "działa")

- Użytkownik traci skille albo instrukcje i dowiaduje się o tym po tygodniu.
- Plik agenta zawiera klucz API, bo ktoś wkleił go w instrukcje, a my nie sprawdziliśmy.
- Format ma pola, które mają sens tylko w jednej aplikacji, i reszta vendorów go odrzuca jako "format OpenBota w przebraniu".
- Instalacja wymaga konta, chmury albo pliku konfiguracyjnego.

## 6. Jak to ma działać dla użytkownika

Trzy polecenia. Resztę narzędzie wykrywa samo.

```bash
# przenieś agenta z Claude Code do OpenClaw (eksport + import w jednym kroku)
npx openteleport move --from claude-code --to openclaw --agent reviewer

# zapisz agenta z dowolnego katalogu projektu do pliku, żeby go komuś wysłać lub zarchiwizować
npx openteleport export --from folder --source-dir ./agents/ada --out ada.jetpack

# wczytaj agenta z pliku do aplikacji
npx openteleport import --to openclaw ada.jetpack
```

Pomocnicze: `inspect <plik>` (co jest w środku), `validate <plik>` (czy zgodny ze schematem, czy nie ma sekretów), `list --from openclaw` (jacy agenci są dostępni).

Po każdym `move` i `import` drukuje się **raport przeniesienia**: co przeniesiono 1:1, co przeniesiono z przybliżeniem (np. rutyna cron zamieniona na format docelowy), co pominięto i dlaczego. Raport jest też zapisywany: przy `export` jako `move-report.md` obok pliku, przy `move` i `import` (które nie mają pliku obok) w `~/.openteleport/reports/<data>-<agent>.md` (decyzja z wdrożenia v0.1).

Gdy brakuje argumentu (np. `--agent`), narzędzie pyta interaktywnie z listą do wyboru. Gdy terminal nie jest interaktywny, kończy się błędem z czytelnym komunikatem.

## 7. Format pliku agenta

Zasada uniwersalności: **format nie wymyśla własnych nazw plików tam, gdzie branża już ma standard.** Rozpakowany `.jetpack` jest sam w sobie działającym katalogiem agenta dla każdego narzędzia, które czyta `AGENTS.md` i skille w formacie Agent Skills, czyli dla Claude Code, Codex, Cursor, Gemini CLI, Cline, OpenClaw i Hermesa. Jedyne, co dodajemy, to manifest, rutyny i pliki.

Plik `.jetpack` to archiwum zip. Po rozpakowaniu to katalog o stałej strukturze, czytelny dla człowieka i dla gita:

```
jetpack.json            manifest (wersja schematu, tożsamość, rola, preferencje modeli/runtime, uprawnienia)
AGENTS.md               jak agent pracuje: instrukcje systemowe (standard AGENTS.md, Agentic AI Foundation)
SOUL.md                 kim agent jest: persona, ton (opcjonalny; konwencja OpenClaw i Hermesa)
skills/<nazwa>/SKILL.md skille w formacie Agent Skills (ten sam, który czytają OpenClaw, Hermes, Claude Code, Codex, Cursor)
MEMORY.md               zapamiętane fakty, jeden punkt listy na fakt, limit 500 znaków na fakt (konwencja OpenClaw i Claude Code)
memory/<nazwa>.md       pamięć w prozie, przenoszona bez zmian (dzienniki, notatki)
routines/<nazwa>.json   zaplanowane zadania: prompt, harmonogram (cron / every / at), strefa czasowa, włączone/wyłączone
files/                  opcjonalne pliki workspace, tylko z flagą --include-files
avatar.png              opcjonalny, PNG/JPEG/WebP, do 512 KB
```

Aplikacja, która ma jedno pole na instrukcje, dostaje SOUL.md i AGENTS.md sklejone z nagłówkami. Aplikacja, która ma tylko fakty strukturalne, dostaje `memory/*.md` pocięte po akapitach i punktach do 500 znaków, z wpisem w raporcie. Narzędzie nigdy nie woła modelu językowego: wszystko jest deterministyczne i działa bez klucza API.

Konsekwencja: katalog bez `jetpack.json` też jest poprawnym źródłem. Adapter `folder` syntetyzuje manifest z nazwy katalogu i zawartości. Dzięki temu "dla wszystkich" nie zależy od tego, ile adapterów napisaliśmy: każdy agent trzymany w katalogu projektu da się przenieść od pierwszego dnia.

`jetpack.json`, pola v0.1:

- `schemaVersion`: "0.1"
- `id`: stabilny identyfikator (ulid), nadawany przy pierwszym eksporcie i zachowywany przy kolejnych
- `name`, `title` (rola jednym zdaniem), `description`
- `models`: lista preferencji w kolejności, każda z opcjonalnym `runtime`, bo w OpenBocie agent nie "używa claude-opus", tylko "działa przez Claude Code na planie Claude, a po limicie przeskakuje na Codex". Np. `[{runtime:"claude-code", provider:"anthropic", model:"claude-opus-5-5"}, {runtime:"codex", provider:"openai", model:"gpt-5.5"}]`. Aplikacja docelowa wybiera pierwszy wpis, który obsługuje; brak `runtime` znaczy "dowolny".
- `capabilities`: czego agent potrzebuje: `browser`, `shell`, `filesystem`, `network`, `computerUse`, `scheduler`. Deklaracja wymagań, nie uprawnienia; aplikacja docelowa decyduje, co przyznać.
- `origin`: skąd wyeksportowano (aplikacja, wersja, data). Informacyjne.
- `x-<vendor>`: przestrzeń na pola specyficzne dla vendora, które inni ignorują. Dzięki temu format pozostaje neutralny, a nic nie ginie.

Zasady:

- Schemat publikowany jako JSON Schema w repo i pod `openteleport.dev/schema/0.1/jetpack.json`.
- Zmiany łamiące podnoszą wersję schematu. Narzędzie czyta wszystkie starsze wersje.
- Walidator odrzuca plik, jeśli znajdzie: pliki `.env*`, klucze prywatne, tokeny o znanych wzorcach (np. `sk-`, `ghp_`, `xoxb-`), zagnieżdżone archiwa, `.git`, `node_modules`. To samo robi OpenBot przy imporcie, więc jesteśmy zgodni.
- Nazwa `.jetpack` jest rozszerzeniem; w środku jest zwykły zip, który każdy otworzy.

## 8. Jak to jest zbudowane

### Język i dystrybucja (mój wybór, do podmiany)

TypeScript na Node.js 24 LTS, pakiet `openteleport` na npm, uruchamiany przez `npx openteleport`, bez instalacji. Powody: OpenBot i OpenClaw są w TypeScript, Claude Code i jego ekosystem też, nazwa `openteleport` na npm jest wolna, `npx` daje "zero instalacji". Hermes jest w Pythonie, ale adapter Hermesa czyta i pisze pliki, nie musi być w Pythonie. Jeśli kiedyś potrzebny będzie pojedynczy binarny plik, da się go zbudować z tego samego kodu.

### Trzy warstwy

1. **core**: schemat, walidacja, czytanie i pisanie archiwum `.jetpack`, wykrywanie sekretów, raport przeniesienia. Zero wiedzy o konkretnych aplikacjach.
2. **adapters**: jeden moduł na aplikację. Każdy implementuje ten sam interfejs: `detect()` (czy aplikacja jest zainstalowana i gdzie ma dane), `list()`, `read(agent) → bundle`, `write(bundle) → report`. Adapter deklaruje, które pola obsługuje; core na tej podstawie buduje raport pominięć.
3. **cli**: cienka warstwa poleceń nad core i adapterami. Żadnej logiki biznesowej.

Nowy adapter to jeden katalog z jednym plikiem interfejsu i katalogiem fixture'ów. To ma być tak proste, żeby społeczność pisała adaptery sama.

### Testy

Każdy adapter ma fixture'y nagrane z prawdziwej instalacji aplikacji (katalog danych OpenBota, workspace OpenClaw), z usuniętymi danymi osobowymi. Test: `read` na fixture daje oczekiwany bundle; `write` bundle'a daje katalog zgodny z tym, co aplikacja sama by wytworzyła. Test round-trip: OpenBot → jetpack → OpenClaw → jetpack daje to samo co pierwszy eksport, poza polami, które raport pominięć wymienia.

### Pierwsze adaptery, kolejność

Zasada: żadna aplikacja nie jest wyznacznikiem. Najpierw to, co obejmuje najwięcej narzędzi naraz, potem największe społeczności, potem reszta.

1. **`folder`**: uniwersalny. Czyta i pisze zwykły katalog w układzie z sekcji 7 (z manifestem lub bez). Obejmuje każde narzędzie, które pracuje na katalogu projektu z `AGENTS.md` i `skills/`: Codex, Cursor, Gemini CLI, Cline, workspace Hermesa i OpenClaw. Jeden adapter, kilkanaście aplikacji.
2. **OpenClaw**: największa społeczność (ok. 390 tys. gwiazdek). Odczyt: `openclaw.json` + workspace (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `MEMORY.md`, `memory/`, `skills/`) + `openclaw automations list --json`. Zapis: przez oficjalne CLI (`openclaw agents add`, `agents set-identity`, `automations add`), bo od wersji 2026.6 automatyzacje żyją w bazie stanu, nie w pliku. Dostarczyć też jako plugin OpenClaw, bo maintainer o to prosił.
3. **Claude Code**: najwięcej programistów. Agent = plik `.claude/agents/<nazwa>.md` (frontmatter `name`, `description`, `tools`, `model` + treść jako instrukcje), skille w `.claude/skills/`, pamięć w `~/.claude/projects/<projekt>/memory/` z `MEMORY.md` jako indeksem faktów. Rutyny Claude Code (zadania w chmurze) poza v0.1, raportowane jako pominięte.
4. v0.2: **OpenBot** (zapis przez udokumentowany zip importu `openbot-agent-import` v1; odczyt z pliku transferu instancji `openbot-instance-transfer` v1 albo z bazy SQLite przez `node:sqlite`; notatki z researchu kodu są w planie, w załączniku), **Hermes** (`~/.hermes`), **Codex** (`~/.codex` + skille), **Grok Bot** (przez format zip OpenBota, który Grok Bot już eksportuje), **Letta .af** (import).

### Co jest poza v0.1, ale format ma na to miejsce

- Podpis autora (Ed25519) w `jetpack.json`, żeby plik z katalogu był weryfikowalny. Pole zarezerwowane, nieużywane.
- Pola `x-<vendor>`.

## 9. Organizacja, licencja, repo

- GitHub: organizacja `Open-Teleport`, repo `Open-Teleport/openteleport`. Jedno repo na start (core + adapters + cli w jednym pakiecie, podział na pakiety dopiero gdy będzie potrzebny).
- Licencja: Apache 2.0.
- Domeny: openteleport.dev (główna), openteleport.io i openteleport.ai (przekierowania). Do zarejestrowania przez właściciela.
- npm: `openteleport`. Do zarezerwowania publikacją wersji 0.0.1 z samym README.
- Język repo, README, kodu, issues: angielski. Dokumenty projektowe dla zespołu: polski.
- Nazewnictwo: produkt i narzędzie to **OpenTeleport** (organizacja, npm, polecenie `openteleport`, domena). Spakowany agent to plik **`.jetpack`** z manifestem `jetpack.json`. Historia jest spójna: pakujesz agenta w jetpack, teleportujesz go do innej aplikacji. Jedna nazwa produktu, jedna nazwa formatu, bez trzeciej.
- Polecenie nazywa się `openteleport`, nigdy `teleport`: ta komenda należy do Teleport firmy Gravitational (dostęp do infrastruktury) i leży na PATH u wielu devopsów.
- README zawiera jedno zdanie: "Not affiliated with Teleport by Gravitational."

## 10. Co znaczy sukces

- W ciągu 4 tygodni: `npx openteleport move --from claude-code --to openclaw --agent reviewer` oraz `--from folder` działają na prawdziwych instalacjach, nagrane demo z pięcioma agentami przenoszonymi między trzema narzędziami, post na X i w społecznościach OpenClaw i Claude Code, plugin zgłoszony do OpenClaw.
- W ciągu 8 tygodni: pięć adapterów (folder, OpenClaw, Claude Code, OpenBot, Hermes), pierwszy adapter napisany przez kogoś spoza zespołu.
- Co czyni projekt unikalnym i co trzeba utrzymać: jedyny format neutralny wobec vendora, działający w obie strony między wieloma aplikacjami, którego rozpakowany plik jest sam w sobie działającym katalogiem agenta. Każda decyzja projektowa, która wiąże format z jedną aplikacją, jest regresją.
- Miara, której nie uznajemy za sukces: gwiazdki bez działających przeniesień.

## 11. Decyzje zostawione builderowi

- Układ modułów wewnątrz pakietu, framework testów, bundler.
- Sposób wykrywania katalogów danych aplikacji na macOS, Windows i Linux.
- Dokładny kształt JSON Schema w granicach pól z sekcji 7.
- Format `routines/*.json` (cron vs. interwał), byle był bezstratnie mapowalny na OpenBot i OpenClaw.
- Jak nagrywać i anonimizować fixture'y.

## 12. Rozstrzygnięcia po sprawdzeniu dokumentu przez buildera (moje decyzje, do podmiany)

Niezależny builder przeczytał dokument i zgłosił dziewięć miejsc, w których musiałby zgadywać. Siedem rozstrzygam tu, dwa (sekcja 14) wymagają odpowiedzi właściciela.

1. **Ta sama maszyna czy zdalnie.** v0.1 działa na lokalnym systemie plików. Każdy adapter przyjmuje `--source-dir` i `--target-dir`, więc OpenClaw w Dockerze z zamontowanym wolumenem albo na dysku sieciowym też działa. Dla instalacji zdalnej ścieżka to: `export` na laptopie, skopiowanie pliku, `npx openteleport import` na serwerze. README mówi to wprost. Transport przez SSH to kandydat na v0.2, nie v0.1.
2. **Co znaczy `write()`.** Adapter zwraca jeden z dwóch wyników: `done` (agent widoczny w aplikacji) albo `handoff` (plik gotowy plus dokładnie jeden następny krok dla użytkownika). `folder` i Claude Code jako cel: `done` (zapis plików). OpenClaw jako cel: `done` przez CLI, z ostrzeżeniem o restarcie Gateway, jeśli działa. OpenBot (v0.2) jako cel: `handoff`, bo import odbywa się w aplikacji (Server settings → Import), chyba że lokalne Team API `/v1/agent-import/stage|apply` okaże się dostępne bezgłowo. Raport i README zawsze mówią, który wynik nastąpił. "Jedno polecenie plus jedno kliknięcie" jest akceptowalne tam, gdzie aplikacja nie daje innej drogi.
3. **Stabilny `id` i ponowny import.** Pierwszy eksport nadaje ULID i zapisuje go w pliku. Adapter docelowy zachowuje go w metadanych agenta, jeśli aplikacja ma na to miejsce (np. `x-openteleport.id` w jej konfiguracji); adapter źródłowy przy kolejnym eksporcie najpierw szuka tam. Dodatkowo lokalny cache `~/.openteleport/ids.json`; jego utrata oznacza tylko nowy identyfikator, nigdy błąd. Gdy w celu istnieje agent o tym `id`: domyślnie aktualizacja w miejscu, jeśli adapter to umie, inaczej kopia z sufiksem; flagi `--replace` i `--copy` wymuszają zachowanie. Raport mówi, co się stało. Iteracyjne "popraw w OpenBocie, przenieś ponownie" jest normalnym użyciem, więc aktualizacja w miejscu jest częścią interfejsu adaptera i testu round-trip.
4. **Rutyny po przeniesieniu.** `move` nie modyfikuje źródła (jest kopią migawki; nazwa zostaje, bo tak mówią użytkownicy). Rutyny trafiają do celu **wyłączone** i są wymienione w raporcie z instrukcją włączenia. Flaga `--enable-routines` włącza je od razu. Dzięki temu ta sama rutyna nigdy nie wykona się w dwóch aplikacjach bez wiedzy użytkownika.
5. **`files/`.** Domyślnie nic. Z `--include-files` kopiowany jest workspace bez `.git`, `node_modules`, archiwów i plików z sekretami, z limitem 100 MB (tyle przyjmuje import OpenBota). Powyżej limitu narzędzie odmawia i wypisuje największe pliki. Obietnica "plik można bezpiecznie wysłać" dotyczy eksportu bez `--include-files`; z flagą raport dodaje ostrzeżenie o danych osobowych.
6. **`models` z wymiarem `runtime`.** Dodane do schematu v0.1 (sekcja 7), żeby kluczowy atrybut OpenBota nie lądował w polu vendorowym.
7. **Persona osobno od instrukcji, pod nazwami, które branża już zna.** `SOUL.md` i `AGENTS.md` (sekcja 7), żeby round-trip z OpenClaw i Hermesem nie zależał od pola vendorowego, a rozpakowany plik działał w każdym narzędziu czytającym `AGENTS.md`.
8. **Bez modelu językowego, pamięć w prozie.** Narzędzie nigdy nie woła LLM. Pamięć strukturalna idzie do `MEMORY.md`, proza do `memory/*.md`; mapowanie opisane w sekcji 7.
9. **OpenBot przesunięty do v0.2.** Research kodu OpenBota (27.10.2026) pokazał, że odczyt jest wykonalny dwiema drogami: udokumentowany plik transferu instancji (`openbot-transfer.json`) i baza SQLite z tabelami `projection_agents`, `projection_agent_memories`, `projection_agent_routines`, `projection_routine_triggers`. Notatki są w załączniku planu. Nie trafia do v0.1, bo nie jest wyznacznikiem: v0.1 to `folder`, OpenClaw i Claude Code. Kto dostarcza instalacje i agentów do demo: sekcja 14.

## 13. Decyzje właściciela (moje wybory, zaznaczone jako takie)

- TypeScript/Node/npm (sekcja 8). Alternatywa: Go z jednym binarnym plikiem. Wybrałem TS ze względu na ekosystem i nazwę na npm.
- Jedno repo na start zamiast monorepo z pakietami.
- Fakty z pamięci jako markdown (jeden na linię), nie JSON. Łatwiej czytać i edytować ręcznie.
- Rozszerzenie `.jetpack` zamiast `.zip`. Rozpoznawalność kosztem jednego kroku "to jest zip".

## 14. Pytania tylko do właściciela (otwarte)

1. **Instalacje do pracy i do demo.** Claude Code masz (ta sesja w nim działa). Czy masz OpenClaw, czy stawiamy go od zera? Gdzie stoi (lub stanie): ten sam komputer, serwer, Docker? Od tego zależy, czy demo pokazuje `move` lokalnie, czy ścieżkę `export`, kopia, `import` na serwerze, i czy pierwszy tydzień schodzi na stawianie środowisk.
2. **Podział ról w "sukcesie na 4 tygodnie".** Kod, testy, fixture'y i teksty (README, post, scenariusz demo, zgłoszenie pluginu) są po stronie buildera. Kto nagrywa demo i publikuje posty na X i w społecznościach: Ty, czy przygotować wszystko do publikacji i czekać na Twoje "wysyłaj"?
