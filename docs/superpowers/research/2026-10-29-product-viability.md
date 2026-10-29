# OpenTeleport: sens projektu i weryfikacja zapotrzebowania

Data badania: 2026-10-29. Dokument strategiczny, niezależny od zmian adapterów.

## Ocena

**OpenTeleport ma sens techniczny jako przenośny pakiet konfiguracji agenta i jawna konwersja między aplikacjami. Zapotrzebowanie na osobny produkt oraz gotowość do płacenia pozostają niepotwierdzone.** Kontynuowałbym niewielki projekt open source i sprawdził go na rzeczywistych użytkownikach. Wstrzymałbym rozbudowę platformy, rejestru i kolejnych integracji do uzyskania dowodów powtarzalnego użycia.

Największe ryzyko: użytkownik ma już importer w aplikacji docelowej albo wystarczają mu Git i wspólny katalog skilli. Przewaga OpenTeleport musi wynikać z konkretnego scenariusza, w którym przenośna paczka wybranego agenta oszczędza pracę, daje większą kontrolę lub pozwala użyć tego samego zestawu w kilku środowiskach.

Najbardziej obiecująca hipoteza: autorzy i małe zespoły, które utrzymują nazwanego specjalistę, np. recenzenta kodu, i chcą przekazać jego instrukcje oraz skille osobie używającej innej aplikacji. To hipoteza do sprawdzenia, nie rozpoznany rynek.

## Metoda i granice

- Przejrzano publiczną dokumentację producentów, konkurencyjne repozytoria oraz publiczne zgłoszenie potrzeby przenośnych agentów.
- Ocenę implementacji odniesiono do lokalnie dostępnego commita `87f34b08e133b2947894f5e1ceac6a86bd592688`, zawierającego v0.2 i poprawki adaptera Codexa. Nie oznacza to, że commit został scalony lub wydany.
- Uwzględniono wcześniejsze próby OpenTeleport na rzeczywistych instalacjach Codexa i Hermesa. Nie wykonano w tym badaniu porównawczego testu działania wszystkich konkurentów.
- Dokumentacja konkurencji jest dowodem deklarowanych funkcji, nie ich niezawodności ani popularności. Nie przeprowadzono wywiadów, badań konwersji ani pomiarów gotowości do płacenia.
- Fakty źródłowe, wnioski autora i proponowane eksperymenty są rozdzielone. Stan dokumentacji może zmieniać się szybciej niż lokalne instalacje.

## Co już rozwiązuje ten problem

| Rozwiązanie | Potwierdzony zakres | Znaczenie dla OpenTeleport |
| --- | --- | --- |
| [Import w Codex](https://learn.chatgpt.com/docs/import) | Import z Claude Code i Cursor; aplikacja desktopowa uwzględnia też Claude Cowork. Zakres obejmuje m.in. instrukcje, skille, konfigurację i wybrane dane użytkownika; różni się między interfejsami. | Przejście do Codexa ma natywną ścieżkę. Sam taki importer nie stanowi mocnej przewagi. |
| [Import w Claude Code](https://code.claude.com/docs/en/commands) | `/import` obsługuje Codex, Gemini i Cursor oraz opcję `--dry-run`; przenosi m.in. instrukcje, MCP, komendy, subagentów i skille. Dostępność zależy od środowiska. | Także kierunek do Claude ma bezpośrednią alternatywę. |
| [OpenClaw migrate](https://docs.openclaw.ai/cli/migrate) | Dostawcy migracji dla Claude, Codex CLI i Hermesa; planowanie, podgląd, zastosowanie zmian i mechanizmy ochrony istniejącego stanu. Dostawców mogą dodawać pluginy. | Raport i ostrożny zapis nie są samodzielnie unikalne. Integracja z istniejącym mechanizmem może być kanałem dystrybucji. |
| [Hermes agent-importers](https://hermes-agent.nousresearch.com/docs/plugins/agent-importers) | Oficjalny plugin importuje OpenClaw, Claude Code, Codex CLI i Cursor. Ma podgląd, `--dry-run` i synchronizację części źródeł. | Kolejny silny konkurent w migracji do pojedynczej aplikacji. Dokumentacja pluginu nie oznacza dostępności w każdej starszej instalacji Hermesa. |
| [AgentSync migrate](https://github.com/chrisleekr/agentsync/blob/main/docs/migrate.md) | Deklaruje migracje między Claude, Cursor, Codex, Copilot, VS Code i OpenCode; obejmuje reguły, MCP, komendy, skille i agentów oraz podgląd zmian. | Bezpośrednia konkurencja dla niezależnego narzędzia konwersji. W tym badaniu nie sprawdzono jakości wykonania ani adopcji. |
| [Vercel skills](https://github.com/vercel-labs/skills) | Instalacja i zarządzanie skillami w różnych aplikacjach agentowych. | Jeżeli użytkownik potrzebuje tylko przenieść skille, dodatkowy format paczki może być zbędny. |
| Git i wspólne pliki instrukcji | [AGENTS.md](https://agents.md/) standaryzuje plik instrukcji; [Agent Skills](https://agentskills.io/specification) opisuje katalog ze `SKILL.md`, skryptami i zasobami. | Proste konfiguracje mogą być utrzymywane bez konwersji. OpenTeleport powinien wykorzystywać istniejące standardy. |

Wniosek: kategoria problemu istnieje, lecz rynek nie jest pusty. Natywne importery potwierdzają znaczenie migracji i jednocześnie odbierają część powodów do instalowania osobnego narzędzia. Nie ma podstaw, by reklamować OpenTeleport jako pierwszy lub jedyny sposób przenoszenia agentów.

## Czy ktoś tego potrzebuje?

Publiczne [zgłoszenie OpenClaw #97885](https://github.com/openclaw/openclaw/issues/97885) prosi o przenośne pakiety agentów: odtwarzanie konfiguracji, workspace, skilli i zależności między instalacjami. [Drugi użytkownik](https://github.com/openclaw/openclaw/issues/97885#issuecomment-6072301862) opisał przenoszenie zespołu agentów z laptopa na serwer. To konkretne przykłady problemu, ale bardzo mała próba.

[Odpowiedź opiekuna](https://github.com/openclaw/openclaw/issues/97885#issuecomment-6379109376) zwraca uwagę na szeroki kontrakt przenośności i poświadczeń oraz sugeruje plugin lub bardziej skupioną propozycję. Stan sprawdzony przez API GitHub: zgłoszenie zamknięte jako `not_planned` 2026-10-24. Nie jest to akceptacja funkcji ani rekomendacja OpenTeleport.

**Dowody wystarczają do uzasadnienia eksperymentu, nie do twierdzenia o dużym rynku.** Nie wiadomo jeszcze, jak często problem występuje, czy dotyczy migracji między aplikacjami czy głównie między komputerami, ile czasu kosztuje i czy użytkownik wraca po pierwszym imporcie.

| Sytuacja użytkownika | Ocena dopasowania — hipoteza |
| --- | --- |
| Przekazywanie wybranego specjalisty w zespole korzystającym z różnych aplikacji | Najlepszy kandydat do pilota: potrzeba selekcji, współdzielenia i powtarzalności. |
| Powtarzane odtwarzanie konfiguracji na nowym komputerze lub serwerze | Możliwa wartość; trzeba porównać z Git, backupem i migracją natywną. |
| Jednorazowe przejście z Claude do Codexa | Słabsza propozycja: użytkownik ma natywny import. |
| Instalacja kilku publicznych skilli | Zwykle wystarczy istniejący instalator skilli. |
| Przeniesienie historii rozmów, aktywnych zadań i pełnego stanu aplikacji | Obecna paczka profilu nie powinna obiecywać takiego rezultatu. |

## Czy architektura jest logiczna?

Tak. Wspólny model pośredni i adaptery ograniczają powielanie konwersji. Przy ośmiu adapterach można mieć do 16 granic odczytu/zapisu zamiast 56 osobnych kierunkowych konwerterów. Nadal istnieje do 56 kierunków, których zachowanie trzeba oceniać, dodatkowo z różnymi wersjami aplikacji i systemami operacyjnymi. Nie wszystkie kierunki oznaczają automatyczny import.

W analizowanym kodzie osiem adapterów oznacza **siedem nazwanych aplikacji i adapter folderu**. OpenBot, Grok Bot i Letta korzystają ze ścieżki przekazania pakietu z dalszym krokiem. Liczba adapterów nie jest liczbą zweryfikowanych automatycznych migracji.

Przydatne elementy obecnego projektu:

- Paczka `.jetpack` oddziela reprezentację danych od aplikacji źródłowej i docelowej.
- Instrukcje, persona, fakty, notatki, skille i rutyny mają wspólną reprezentację.
- Raport rozróżnia `moved`, `approximated`, `skipped` i `warnings`; wynik może wskazywać konieczny dalszy krok.
- Można analizować pakiet bez traktowania go jako pełnej kopii katalogu aplikacji.

Najtrudniejszym problemem pozostaje znaczenie przenoszonych danych:

| Element | Co da się przenieść | Czego sam zapis nie gwarantuje |
| --- | --- | --- |
| Instrukcje i persona | Tekst i część struktury | Tej samej hierarchii instrukcji i zachowania modelu |
| Skill | Instrukcje, skrypty, zasoby | Dostępności narzędzi, bibliotek, sieci i poprawnych ścieżek |
| Pamięć | Fakty i notatki | Tego samego indeksowania, wyszukiwania i wykorzystania w rozmowie |
| Rutyna | Opis zadania i harmonogram | Równoważnej strefy czasowej, uprawnień i sposobu uruchamiania |
| Deklarowane możliwości | Nazwy i metadane | Faktycznego przyznania uprawnień i podłączenia usług |

Dlatego właściwy kontrakt produktu brzmi: **przeniesienie obsługiwanego profilu agenta z jawnym raportem różnic**. Zachowanie tej samej tożsamości, pamięci operacyjnej i jakości pracy wymaga osobnego sprawdzenia w aplikacji docelowej. [MCP](https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro) może łączyć aplikację z narzędziami i danymi; nie zastępuje całego kontraktu przenośnego profilu.

## Luki ważniejsze od kolejnych adapterów

Poniższe punkty są rekomendacjami. Nie należy przedstawiać ich jako już dostępnych funkcji.

1. **Podgląd przed zapisem.** W sprawdzonym CLI `inspect` i `validate` nie zastępują planu zmian w konkretnym katalogu docelowym. Użytkownik powinien widzieć tworzone i zastępowane pliki, konflikty, pominięcia i wymagane działania.
2. **Sprawdzenie po imporcie.** Czy aplikacja rzeczywiście odkrywa agenta? Czy agent widzi wymagany skill? Czy eksport po imporcie zachowuje obsługiwaną zawartość? Testy struktury plików nie wystarczą.
3. **Rozdzielenie prywatnej migracji od publicznego szablonu.** Fakty i notatki mogą zawierać dane osobowe mimo braku kluczy API. Skaner sekretów nie jest anonimizacją pamięci ani kontrolą bezpieczeństwa skryptów. Tryb udostępniania powinien domyślnie wykluczać osobistą pamięć i wymagać świadomego wyboru zawartości.
4. **Zależności i utracone znaczenie.** Paczka powinna wyraźnie wskazywać wymagane narzędzia, zmienne środowiska i konfigurację oraz to, co zostało tylko zapisane jako opis.
5. **Odtwarzanie poprzedniego stanu.** Potrzebny jest jasny plan backupu lub cofania zapisów, z zakresem odpowiedzialności opisanym dla każdego adaptera.
6. **Macierz dowodów zgodności.** Oddzielić „z dokumentacji”, „testy na fixture”, „odczyt przez prawdziwą aplikację” i „wykonanie zadania”. Podawać wersje aplikacji, system i sprawdzony kierunek.

Wcześniejsze próby Codexa wykryły kolizję nazwy roli i utratę powiązania skilli przy ponownym eksporcie, mimo rozbudowanych testów jednostkowych. Poprawki znajdują się w analizowanym commicie. To dowód kosztu utrzymania kompatybilności, a nie argument przeciw samemu formatowi pośredniemu.

## Co zrobiłbym teraz

Domknąłbym v0.2 z uczciwym opisem obsługi i wybrał dwa lub trzy scenariusze do weryfikacji na żywych aplikacjach. Następnie przeprowadziłbym dwutygodniowy pilotaż przed zwiększaniem liczby adapterów.

**Tydzień 1: potrzeba i porównanie.** Znaleźć 10 osób, które rzeczywiście używają co najmniej dwóch środowisk lub wielokrotnie odtwarzają agentów. Poprosić o ostatni konkretny przypadek, obecną metodę, częstotliwość i najtrudniejszy element. Nie pytać tylko „czy używałbyś takiego narzędzia?”. Wybrać pięć rzeczywistych transferów. Dla każdego porównać OpenTeleport z najlepszą dostępną alternatywą, w tym importerem natywnym lub Git.

**Tydzień 2: wynik i powrót.** Zmierzyć czas do działającego agenta, liczbę ręcznych poprawek, nieoczekiwane utraty danych i pomoc autora projektu. Sprawdzić zachowanie na zadaniu właściwym dla danego agenta. Po kilku dniach sprawdzić, kto samodzielnie ponownie użył paczki lub przekazał ją współpracownikowi.

Proponowane progi decyzji, ustalone przed eksperymentem — nie benchmarki branżowe:

- Co najmniej pięć zakończonych transferów na rzeczywistych konfiguracjach.
- Co najmniej trzy osoby ponownie używają narzędzia lub przekazują pakiet dalej bez prowadzenia krok po kroku przez autora.
- Brak niewyjaśnionych krytycznych utrat danych w tych próbach; każda zaobserwowana strata jest raportowana i rozumiana przez użytkownika.
- W co najmniej trzech przypadkach istnieje udokumentowana przewaga nad alternatywą: krótszy czas, mniej poprawek lub potrzebny rezultat niedostępny w obecnej metodzie.

Brak spełnienia tych progów powinien prowadzić do zawężenia zastosowania i kolejnego małego testu, zanim powstanie następna fala integracji. Szczególnie ważny sygnał do zmiany kierunku: użytkownicy chcą głównie historii rozmów albo wszystkie ich potrzeby załatwia importer natywny.

## Czy z tego może być biznes?

Na dziś brak wystarczających dowodów. Darmowe narzędzie open source może być wartościowe nawet przy okazjonalnym użyciu. Sam jednorazowy import ma słabą hipotezę abonamentową: korzyść może kończyć się po migracji, a producent aplikacji docelowej ma motywację, by oferować import bez dodatkowej opłaty.

Potencjalny płatny obszar to utrzymywanie zatwierdzonych, wersjonowanych profili w zespole: powtarzalne wdrożenia, kontrola zmian, wsparcie i odpowiedzialność za zgodność. To osobny produkt i osobna hipoteza. Sprawdzałbym ją dopiero u zespołów, które już wracają do narzędzia. Dwa konkretne płatne pilotaże lub zatwierdzone budżety byłyby silniejszym sygnałem niż deklaracje zainteresowania. Nie ma podstaw do wyceny rynku ani prognozy przychodów.

## Decyzja

Kontynuować jako mały projekt z mierzalną obietnicą: spakować wybranego agenta, przenieść obsługiwane elementy, pokazać różnice i sprawdzić wynik. Najbliższy wysiłek przeznaczyć na wiarygodność kilku scenariuszy i obserwację użytkowników. Rozbudowę platformy uzależnić od dowodu, że ludzie rzeczywiście potrzebują niezależnego pakietu i wracają do niego.
