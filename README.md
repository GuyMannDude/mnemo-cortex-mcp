# mnemo-cortex-mcp

MCP server bridge that connects Claude Desktop (or any MCP client) to [Mnemo Cortex](https://github.com/GuyMannDude/mnemo-cortex) — giving your AI persistent semantic memory across sessions.

## What it does

Without this server, every Claude Desktop conversation starts from zero. With it, Claude can:

- **Recall** past conversations by meaning, not just keywords
- **Search** across multiple agents (Opie, CC, Rocky, or your own)
- **Save** summaries and key facts for future sessions
- **Read/write brain files** — markdown files that serve as persistent identity and state

## Tools (7)

| Tool | Description |
|------|-------------|
| `mnemo_recall` | Semantic recall for the current agent. Returns relevant chunks from past sessions. |
| `mnemo_search` | Cross-agent search. Find memories from any agent in the system. |
| `mnemo_save` | Write a summary or key facts to Mnemo Cortex for future recall. |
| `opie_startup` | Full orientation loader — reads brain lane, reference files, and recent memory. Call first in every session. |
| `read_brain_file` | Read any file from the brain directory. |
| `list_brain_files` | List all available brain lane files. |
| `write_brain_file` | Update brain lane files (with safety guards on protected files). |

## Quick start

```bash
git clone https://github.com/GuyMannDude/mnemo-cortex-mcp.git
cd mnemo-cortex-mcp
npm install
```

Add to your Claude Desktop config (`~/.config/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mnemo-cortex": {
      "command": "node",
      "args": ["/path/to/mnemo-cortex-mcp/server.js"],
      "env": {
        "MNEMO_URL": "http://localhost:50001",
        "MNEMO_AGENT_ID": "opie",
        "BRAIN_DIR": "/path/to/your/brain/directory"
      }
    }
  }
}
```

Restart Claude Desktop. The tools will appear automatically.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MNEMO_URL` | `http://artforge:50001` | URL of your Mnemo Cortex instance |
| `MNEMO_AGENT_ID` | `opie` | Agent identity for recall and save operations |
| `BRAIN_DIR` | `~/github/sparks-brain-guy/brain` | Directory containing brain lane markdown files |

## Requirements

- Node.js 18+
- A running [Mnemo Cortex](https://github.com/GuyMannDude/mnemo-cortex) instance
- Claude Desktop or any MCP-compatible client

## How it works

```
Claude Desktop  ←→  mnemo-cortex-mcp (stdio)  ←→  Mnemo Cortex API (HTTP)
                                               ←→  Brain files (filesystem)
```

The server runs as a stdio MCP process spawned by Claude Desktop. It translates MCP tool calls into HTTP requests to your Mnemo Cortex instance and filesystem reads/writes to your brain directory.

Memory is semantic — queries are matched by meaning using embeddings, not exact keywords. This means "what did we decide about the router" will find relevant context even if those exact words were never used.

## Works with any setup

While the defaults are configured for Project Sparks (Opie on IGOR talking to THE VAULT), every value is configurable via environment variables. Point `MNEMO_URL` at your own Mnemo Cortex instance, set your own `MNEMO_AGENT_ID`, and use your own brain directory.

## License

MIT — Project Sparks / Guy Hutchins
