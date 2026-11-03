# OpenTeleport Probe 20261104 for Grok Bot

Grok Bot cannot import a Bot from a file, so OpenTeleport wrote everything the Bot needs to hear
in a conversation. This folder is not a Bot yet: follow the five steps below.

1. In Grok Bot, create a new Bot named "OpenTeleport Probe 20261104".
2. Paste the whole of `1-paste-into-chat.md` into the Bot's chat as the first message. It tells the Bot who it is, how it works and which facts to remember.
3. This Bot has no skills, so there is nothing to save.
4. This Bot has no routines, so there is nothing to create.
5. Optional, only if these facts should be shared across your Bots: open Settings > General > Import, paste the contents of `2-memory.txt` into the import text box, then choose Add to Memory. This sends a request to a Bot to save shared user memory; it is not a direct file import. Review the Bot's confirmation and check what it remembers. The first chat message already asks it to remember these facts.

Good to know:

- Grok Bot has no instructions field and no import for Bots, so a Bot keeps what it is told in
  its memory. Ask it what it remembers to check.
- `.openteleport.json` lets a later move of the same Bot update this folder in place. Leave it where
  it is.
