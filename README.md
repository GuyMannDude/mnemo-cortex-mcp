# mnemo-cortex-mcp

> **Claude Desktop integration temporarily pulled (v2.3.0, April 7 2026).**

Anthropic's Claude Desktop (v2.1.87+) moved session storage from disk JSONL to internal IndexedDB. The automatic session watcher that captured conversations into Mnemo broke silently. Rather than ship a known-broken integration, we pulled it until a reliable capture path exists.

**Claude Code and OpenClaw integrations are unaffected.** See [mnemo-cortex](https://github.com/GuyMannDude/mnemo-cortex).

## Status

- The MCP server tools (recall, search, save, brain files) worked correctly
- The session watcher (auto-capture) is what broke
- Tracking the fix in the main repo

This repo is archived and will not receive updates.
