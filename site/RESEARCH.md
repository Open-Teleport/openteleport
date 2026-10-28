# Research: strona openteleport.dev

Stan na 2026-10-28. Zasada z zadania: tylko biblioteki na licencjach MIT, Apache-2.0 lub ISC, sprawdzone w pliku `LICENSE` repozytorium, nie w opisach.

## Decyzja: stack

**Astro 7 (static) + własny CSS + wanilowy TypeScript.** Bez CMS, bez backendu, bez frameworka UI w runtime.

Dlaczego Astro, a nie Vite + React:

- Strona ma jedną podstronę i prawie żadnego stanu. Astro domyślnie wysyła zero JS; skrypt dostaje tylko ten fragment, który go potrzebuje (hero). Vite + React wysłałby runtime Reacta (ok. 45 kB gzip) na każdą wizytę, co od razu kosztuje w Lighthouse.
- Vercel wykrywa Astro bez adaptera; statyczny `dist/` idzie na CDN. Adapter `@astrojs/vercel` jest potrzebny tylko dla Web Analytics lub Image Optimization ([docs](https://docs.astro.build/en/guides/integrations-guide/vercel/)).
- Komponenty `.astro` z scoped CSS wystarczą; Tailwind jest możliwy (`@tailwindcss/vite` 4.3.3, MIT), ale dla strony z własnym systemem tokenów zwykły CSS jest krótszy i bez kroku kompilacji klas.
- Wersje w dniu researchu: `astro` 7.4.2, `motion` 14.7.1, `lenis` 1.3.27, `tailwindcss` 4.3.3, `@astrojs/vercel` 11.0.16.

Konfiguracja Vercel: katalog główny projektu (Root Directory) ustawić na `site/`; komenda `astro build`, wyjście `dist/`. Repo pakietu npm zostaje nietknięte.

## Biblioteki: co wolno, co odpada

| Biblioteka | Do czego | Licencja (plik LICENSE) | Werdykt |
| --- | --- | --- | --- |
| [Astro](https://github.com/withastro/astro) | generator strony | MIT | używamy |
| [Motion](https://github.com/motiondivision/motion) (`motion`, dawniej framer-motion) | sprężyny, `animate()`, `scroll()`; wersja wanilowa bez Reacta ok. 5 kB | MIT | opcjonalnie, tylko jeśli potrzebna sprężyna sterowana gestem |
| [Lenis](https://github.com/darkroomengineering/lenis) | płynny scroll | MIT | nie używamy: natywny scroll jest szybszy i lepszy dla dostępności; zostaje jako opcja |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | komponenty React | MIT | nie używamy (brak Reacta), wzorzec stylistyczny OK |
| [Magic UI](https://github.com/magicuidesign/magicui) | animowane komponenty React, w tym [Terminal](https://magicui.design/docs/components/terminal) | MIT | wzorzec dla hero z terminalem; przeniesiony do wanilowego TS |
| [termynal](https://github.com/ines/termynal) | animowany terminal w czystym JS (2 kB) | MIT | wzorzec; własna implementacja jest krótsza niż integracja |
| [asciinema-player](https://github.com/asciinema/asciinema-player) | odtwarzacz nagrań terminala | Apache-2.0 | nie na landing (ciężki); dobry do strony "Demo" z nagraniem z `docs/demo.md` |
| [Tailwind CSS 4](https://github.com/tailwindlabs/tailwindcss) | utility CSS | MIT | nie używamy (własne tokeny CSS) |
| [React Bits](https://github.com/DavidHDev/react-bits) | animowane komponenty | MIT + Commons Clause | odpada (klauzula zakazu sprzedaży, poza regułą zadania) |
| [Animate UI](https://github.com/imskyleen/animate-ui) | animowane komponenty shadcn | MIT + Commons Clause | odpada (jak wyżej) |
| [Aceternity UI](https://ui.aceternity.com) | efekty hero | brak jasnej licencji na darmowe komponenty, Pro płatne | odpada |
| [GSAP](https://gsap.com/community/standard-license/) | animacje | "Standard No-Charge" (własnościowa, od 2025 darmowa także komercyjnie, nie open source) | odpada według reguły zadania; w razie potrzeby CSS + Web Animations API wystarczą |

Źródła licencji: pliki `LICENSE`/`LICENSE.md` pobrane z `raw.githubusercontent.com` dla każdego repo 2026-10-28. GSAP: [ogłoszenie Webflow](https://webflow.com/blog/gsap-becomes-free), [klasyfikacja ScanCode](https://scancode-licensedb.aboutcode.org/gsap-standard-no-charge-2025.html).

## Platformowe zamiast bibliotek

To, co zwykle bierze się z biblioteki, przeglądarki mają dziś wbudowane:

- **Scroll-driven animations** (`animation-timeline: scroll()` / `view()`): Chrome, Edge, Safari 26; Firefox za flagą. Fallback: stan końcowy bez animacji (`@supports not (animation-timeline: scroll())`).
- **Web Animations API** (`element.animate`) do sekwencji w hero, z `prefers-reduced-motion` jako wyłącznikiem.
- **View Transitions** niepotrzebne na jednej podstronie.
- **Pointer Events + `setPointerCapture`** do przeciągania (koncepcja B), z projekcją pędu według wzoru Apple (`v/1000 * d/(1-d)`, `d = 0.998`).
- Czcionki: `system-ui` jako podstawa (Apple radzi system font, bo ma optical sizing), ewentualnie jedna czcionka z Google Fonts z `font-display: swap`.

## Wzorce: landingi narzędzi CLI i dev-tools

Badanie Evil Martians ("We studied 100 dev tool landing pages", 2025): wygrywa hero z jedną komendą lub jednym zrzutem produktu i jednym CTA; animowany produkt pokazuje więcej, ale kosztuje więcej pracy ([artykuł](https://evilmartians.com/chronicles/we-studied-100-devtool-landing-pages-here-is-what-actually-works-in-2025)).

Strony warte obejrzenia jako punkt odniesienia (styl, nie kopiowanie):

- [bun.sh](https://bun.sh): komenda instalacji w hero, benchmark zamiast opisu.
- [astral.sh/uv](https://astral.sh/uv) i [astral.sh/ruff](https://astral.sh/ruff): bardzo czysta typografia, jedna kolumna, terminal jako obraz produktu.
- [charm.sh](https://charm.sh): terminal jako medium całej strony.
- [warp.dev](https://www.warp.dev): ciemny, produktowy hero z animowanym terminalem.
- [biomejs.dev](https://biomejs.dev), [oxc.rs](https://oxc.rs), [vite.dev](https://vite.dev): standard "docs-first" dla narzędzi OSS.
- [zed.dev](https://zed.dev), [linear.app](https://linear.app): najbliżej "Apple w webie": system font, ujemny tracking w nagłówkach, dużo światła, jedna oś.
- [mise.jdx.dev](https://mise.jdx.dev): minimalny landing narzędzia CLI z jedną komendą.

Wzorzec "terminal hero" (komenda, której wynik widać od razu): Magic UI Terminal i termynal animują pisanie linii; lepsza wersja dla OpenTeleport to komenda, która **sama się składa** z wyboru użytkownika (skąd, dokąd) i od razu drukuje raport przeniesienia, czyli to, co produkt naprawdę robi.

Odniesienie wskazane przez właściciela: szablon [VOIDEN (Modulify)](https://voiden-template.modulify.website/work/slow-fire): czarne tło, cienki serif w wersalikach, mono etykiety, obiekt WebGL i licznik sprzężony ze scrollem. Próbka w tym duchu dla OpenTeleport: koncepcja A poniżej.

## Trzy koncepcje UI (próbki jako artefakty, do wyboru przez właściciela)

Dwa odniesienia wskazał właściciel (szablony Modulify: [VOIDEN](https://voiden-template.modulify.website/work/slow-fire) i [Cipher](https://cipher-template.modulify.website/)), trzecia koncepcja jest własna.

| | A. Void | B. Cipher mono | C. The Move |
| --- | --- | --- | --- |
| Próbka | https://claude.ai/artifact/P5HjYaRkt4wmHkWGzLDzwF | https://claude.ai/artifact/4CcH7GpGVZVRazUXrda8nq | https://claude.ai/artifact/HRSoFdgWBpjZ43GxQjAn1n |
| Wzorzec | VOIDEN | Cipher, w bieli, szarości i czerni | Apple (system font, ujemny tracking, kafle) |
| Nastrój | kinowy, ciemny, kosmiczny | monochromatyczny, pikselowy nagłówek, terminal ASCII | jasny/ciemny, cichy, jeden obiekt w hero |
| To, czego nie było | przelot przez portal sprzężony ze scrollem, licznik "transfer" | terminal ASCII, który przy przewijaniu rozsypuje się i składa w kolejny ekran (list, move, folder) | komendę składa się przeciągnięciem agenta między aplikacjami; raport drukuje się po upuszczeniu |
| Główna prostota | jedna kolumna tekstu na pustce | przypięty obiekt + trzy sekcje | jeden gest |
| Ryzyko | tekst na animowanym tle, najdalej od "Apple" | 11 px mono na telefonie, pikselowy font to wyraźny styl | drag na telefonie i klawiaturze potrzebuje alternatywy (jest: tap na kafel, Enter) |
| Koszt JS | canvas, ok. 4 kB | canvas, ok. 3 kB | pointer events + sprężyna, ok. 3 kB |
| Tryb jasny i ciemny | tylko ciemny (zamierzony) | oba | oba |

Czcionki: A: Cormorant Garamond + IBM Plex Mono; B: Pixelify Sans + Geist + JetBrains Mono (wszystkie OFL, Google Fonts); C: system font + system mono (zero pobierania).
