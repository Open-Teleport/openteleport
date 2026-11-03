# Grok Bot 0.78.1 memory import inspection

The user supplied the installed Windows Grok Bot shortcut. Executable metadata reports 0.78.1. Read-only inspection of its packaged `resources/app.asar` identified the General settings import component and its text-to-prompt helper. No user data, tokens, bot memories or sessions were opened.

The component renders a textarea, checks a 100,000-character limit, trims the pasted text and rejects empty input. It wraps nonempty text as imported memory and sends a prompt to a selected personal Bot. Its instructions request one fact per entry through UpdateMemory with user scope, making those facts available across the user's Bots; a fallback uses the default scope when user scope is unavailable. The component does not parse a memory-file schema or directly persist a file.

The generated handoff now says to paste the contents of `2-memory.txt`, explains shared user scope, and asks the user to verify the Bot's confirmation. This corrects an inaccurate claim of direct file import without claiming persistence was tested.

Evidence locations in the installed 0.78.1 package: `dist/renderer/assets/chunk-general-pane-BoaLGkwd.js` (import component), `dist/renderer/assets/index.eager-app-D25OYGQG.js` (memory prompt construction and instructions). Proprietary bundled code is not copied into this repository.

## Still open: issue #17

A genuine Bot-produced OpenBot export ZIP and a live memory import/recollection check remain required. Both supported computer-use entry points failed during kernel initialization with `failed to write kernel assets` / Windows error 3, including a reset/retry. No UI action or model request was sent. This inspection is evidence about the installed implementation, not a live end-to-end pass.
