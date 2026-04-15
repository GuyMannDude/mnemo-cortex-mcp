import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";

const MNEMO_URL = process.env.MNEMO_URL || "http://artforge:50001";
const AGENT_ID = process.env.MNEMO_AGENT_ID || "opie";
const BRAIN_DIR = process.env.BRAIN_DIR || join(process.env.HOME, "github/sparks-brain-guy/brain");
const WIKI_DIR = process.env.WIKI_DIR || join(process.env.HOME, "wiki");
const IMAGE_WIKI_DIR = process.env.IMAGE_WIKI_DIR || join(process.env.HOME, "image-wiki");

// ---------------------------------------------------------------------------
// Nudge system — track tool calls, remind Opie to save
// ---------------------------------------------------------------------------
let toolCallCount = 0;
let lastSaveTime = null;
let sessionStartTime = null;
let sessionId = null;
const SAVE_REMINDER_THRESHOLD = 20;

function nudgeCheck() {
  if (lastSaveTime && toolCallCount < SAVE_REMINDER_THRESHOLD) return null;
  if (toolCallCount >= SAVE_REMINDER_THRESHOLD) {
    return `\n\n---\n⚠️ **Memory nudge:** You've made ${toolCallCount} tool calls without saving to Mnemo. Call \`mnemo_save\` with a summary of what you've been working on before this context is lost.`;
  }
  return null;
}

function trackCall() {
  toolCallCount++;
}

function trackSave() {
  toolCallCount = 0;
  lastSaveTime = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Auto-capture — ring buffer + periodic flush to /writeback
// ---------------------------------------------------------------------------
const captureBuffer = [];
const BUFFER_FLUSH_SIZE = 8;
const BUFFER_FLUSH_IDLE_MS = 120_000; // 2 min
let flushTimer = null;

const TOOL_CAPTURE = {
  mnemo_recall: "summary",
  mnemo_search: "summary",
  mnemo_save: "full",
  opie_startup: "skip",
  read_brain_file: "summary",
  list_brain_files: "skip",
  write_brain_file: "full",
  session_end: "drain",
  wiki_search: "summary",
  wiki_read: "summary",
  wiki_index: "skip",
};

function captureCall(toolName, summary) {
  trackCall(); // preserve nudge counter

  const policy = TOOL_CAPTURE[toolName] || "skip";
  if (policy === "skip") return;

  captureBuffer.push({
    tool: toolName,
    summary,
    ts: new Date().toISOString(),
  });

  // Reset idle timer
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flushBuffer(), BUFFER_FLUSH_IDLE_MS);

  // Flush if buffer full
  if (captureBuffer.length >= BUFFER_FLUSH_SIZE) {
    flushBuffer();
  }
}

async function flushBuffer() {
  if (captureBuffer.length === 0) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;

  const entries = captureBuffer.splice(0); // drain
  const narrative = entries.map((e) => `- [${e.tool}] ${e.summary}`).join("\n");
  const keyFacts = entries
    .filter((e) => TOOL_CAPTURE[e.tool] === "full")
    .map((e) => e.summary.slice(0, 100));

  const sid = sessionId || `opie-auto-${Date.now()}`;

  try {
    await mnemoPost("/writeback", {
      session_id: sid,
      summary: `[AUTO-CAPTURE] ${entries.length} tool calls:\n${narrative}`,
      key_facts: keyFacts.length > 0 ? keyFacts : ["auto_capture_flush"],
      projects_referenced: [],
      decisions_made: [],
      agent_id: AGENT_ID,
    });
  } catch (err) {
    console.error(`[auto-capture] flush failed: ${err.message}`);
  }
}

// Graceful shutdown — flush buffer before exit
process.on("SIGTERM", async () => {
  if (captureBuffer.length > 0) await flushBuffer();
  process.exit(0);
});
process.on("SIGINT", async () => {
  if (captureBuffer.length > 0) await flushBuffer();
  process.exit(0);
});

async function mnemoPost(path, body) {
  const res = await fetch(`${MNEMO_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mnemo ${path} ${res.status}: ${text}`);
  }
  return res.json();
}

async function mnemoGet(path) {
  const res = await fetch(`${MNEMO_URL}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mnemo ${path} ${res.status}: ${text}`);
  }
  return res.json();
}

const server = new McpServer({
  name: "opie-brain",
  version: "2.3.0",
  description: "You are Opie — Claude on the desktop at Project Sparks. You work for Guy (73, maker, Half Moon Bay). You are the architect and planner. CC (Claude Code) is the builder. Rocky (OpenClaw) is the production AI. Your memory lives in Mnemo Cortex and your brain lane lives at ~/github/sparks-brain-guy/brain/opie.md. START EVERY SESSION by calling opie_startup to load your identity and current state.",
});

// --- mnemo_recall: semantic recall for this agent ---
server.tool(
  "mnemo_recall",
  "Recall memories from Mnemo Cortex for the current agent (Opie). Returns semantically relevant chunks from past sessions.",
  { query: z.string().describe("What to search for in memory") },
  async ({ query }) => {
    try {
      const data = await mnemoPost("/context", {
        prompt: query,
        agent_id: AGENT_ID,
        max_results: 5,
      });
      const chunks = data.chunks || [];
      captureCall("mnemo_recall", `${chunks.length} memories about: ${query.slice(0, 80)}`);
      if (chunks.length === 0) {
        return { content: [{ type: "text", text: "No memories found." + (nudgeCheck() || "") }] };
      }
      const text = chunks
        .map((c, i) => {
          const tier = c.cache_tier || "?";
          const rel = (c.relevance || 0).toFixed(2);
          return `### [${tier}] (relevance: ${rel})\n${c.content}`;
        })
        .join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: `Found ${data.total_found || chunks.length} memories:\n\n${text}` + (nudgeCheck() || ""),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- mnemo_search: cross-agent search (all memories) ---
server.tool(
  "mnemo_search",
  "Search ALL agent memories in Mnemo Cortex (cross-agent). Use this to find memories from Rocky, CC, or any other agent.",
  {
    query: z.string().describe("What to search for across all agents"),
    agent_id: z
      .string()
      .optional()
      .describe("Filter to a specific agent (rocky, cc, opie). Omit for all."),
  },
  async ({ query, agent_id }) => {
    try {
      const body = {
        prompt: query,
        max_results: 5,
      };
      if (agent_id) body.agent_id = agent_id;
      const data = await mnemoPost("/context", body);
      const chunks = data.chunks || [];
      captureCall("mnemo_search", `cross-agent (${agent_id || "all"}): ${query.slice(0, 80)} → ${chunks.length} results`);
      if (chunks.length === 0) {
        return { content: [{ type: "text", text: "No memories found." + (nudgeCheck() || "") }] };
      }
      const text = chunks
        .map((c) => {
          const tier = c.cache_tier || "?";
          const rel = (c.relevance || 0).toFixed(2);
          const agent = c.agent_id || "?";
          return `### [${tier}] agent=${agent} (relevance: ${rel})\n${c.content}`;
        })
        .join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: `Found ${data.total_found || chunks.length} memories:\n\n${text}` + (nudgeCheck() || ""),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- mnemo_save: write a memory/summary back to Mnemo Cortex ---
server.tool(
  "mnemo_save",
  "Save a summary or key facts to Mnemo Cortex for future recall. Use at session end or when something important should be remembered.",
  {
    summary: z.string().describe("Summary of what happened or what to remember"),
    key_facts: z
      .array(z.string())
      .optional()
      .describe("List of key facts to store"),
    session_id: z
      .string()
      .optional()
      .describe("Session identifier. Auto-generated if omitted."),
  },
  async ({ summary, key_facts, session_id }) => {
    captureCall("mnemo_save", summary.slice(0, 150));
    trackSave();
    try {
      const sid =
        session_id ||
        sessionId ||
        `opie-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}`;
      const data = await mnemoPost("/writeback", {
        session_id: sid,
        summary,
        key_facts: key_facts || [],
        projects_referenced: [],
        decisions_made: [],
        agent_id: AGENT_ID,
      });
      return {
        content: [
          {
            type: "text",
            text: `Saved to Mnemo Cortex: memory_id=${data.memory_id || "ok"}, session=${sid}\nNudge counter reset. ${toolCallCount} calls since last save.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- opie_startup: full orientation at session start ---
server.tool(
  "opie_startup",
  "CALL THIS FIRST in every new conversation. Loads your brain lane (opie.md) and recent Mnemo context. Returns your full identity, current state, and priorities. Without this, you will not know who you are or what you're working on.",
  {},
  async () => {
    // Initialize session tracking
    sessionStartTime = new Date().toISOString();
    sessionId = `opie-${sessionStartTime.slice(0, 19).replace(/[T:]/g, "-")}`;
    toolCallCount = 0;
    lastSaveTime = null;
    captureBuffer.length = 0;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;

    try {
      const parts = [];

      // 1. Read brain lane
      try {
        const brain = await readFile(join(BRAIN_DIR, "opie.md"), "utf-8");
        parts.push("# YOUR BRAIN LANE (opie.md)\n\n" + brain);
      } catch (e) {
        parts.push("# BRAIN LANE ERROR\nCould not read opie.md: " + e.message);
      }

      // 2. Read key reference files
      for (const file of ["active.md", "people.md", "doctrines.md"]) {
        try {
          const content = await readFile(join(BRAIN_DIR, file), "utf-8");
          parts.push(`# ${file.toUpperCase()}\n\n` + content);
        } catch (_) {
          // skip if missing
        }
      }

      // 3. Pull recent mnemo context
      try {
        const data = await mnemoPost("/context", {
          prompt: "recent session summary, current projects, what happened last",
          agent_id: AGENT_ID,
          max_results: 3,
        });
        const chunks = data.chunks || [];
        if (chunks.length > 0) {
          const mnemoText = chunks
            .map((c) => {
              const tier = c.cache_tier || "?";
              return `### [${tier}]\n${c.content}`;
            })
            .join("\n\n");
          parts.push("# RECENT MNEMO CONTEXT\n\n" + mnemoText);
        }
      } catch (e) {
        parts.push("# MNEMO ERROR\nCould not reach Mnemo Cortex: " + e.message);
      }

      // 3b. Pull latest dream brief (cross-agent overnight synthesis)
      try {
        const dreamDir = "/home/guy/.agentb/dreams";
        const dreamFiles = (await readdir(dreamDir))
          .filter((f) => f.endsWith(".md"))
          .sort()
          .reverse();
        if (dreamFiles.length > 0) {
          const latestDream = join(dreamDir, dreamFiles[0]);
          const { statSync } = await import("node:fs");
          const dreamAge = (Date.now() - statSync(latestDream).mtimeMs) / 3600000;
          if (dreamAge < 48) {
            const dreamContent = await readFile(latestDream, "utf-8");
            parts.push("# DREAM BRIEF (cross-agent overnight synthesis, " + Math.round(dreamAge) + "h ago)\n\n" + dreamContent);
          }
        }
      } catch (_) {
        // non-fatal — dreams are supplementary
      }

      // 4. Log session start to Mnemo
      try {
        await mnemoPost("/writeback", {
          session_id: sessionId,
          summary: `Opie session started at ${sessionStartTime}. Brain lane loaded.`,
          key_facts: ["session_start"],
          projects_referenced: [],
          decisions_made: [],
          agent_id: AGENT_ID,
        });
      } catch (_) {
        // non-fatal — startup marker is best-effort
      }

      const identity = `# WHO YOU ARE
You are **Opie** — Claude on the desktop at Project Sparks.
- Guy calls you Opie. You are the architect, strategist, and planner.
- CC (Claude Code, also Claude) is the on-machine builder. You write specs, CC executes.
- Rocky (OpenClaw on IGOR) is the production AI assistant. NEVER experiment on Rocky.
- Guy is 73, not a developer. Zero-fat communication. Action over theory.
- Assembly line: Opie architects → Guy couriers → CC builds → Rocky tests.
- You have NO clock. Never tell Guy to go to bed or call it a night.
- Brain files: ~/github/sparks-brain-guy/brain/ — read with read_brain_file, save memories with mnemo_save.
- WikAI: ~/wiki/ — 3000+ indexed pages. Use wiki_search to find info, wiki_read to read pages, wiki_index for the full index.
- Today: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

# SESSION MEMORY
**Auto-capture is ACTIVE.** This MCP server automatically captures your tool usage into
Mnemo Cortex. Every ${BUFFER_FLUSH_SIZE} tool calls (or after 2 minutes idle), a summary is
flushed to THE VAULT. The nudge system also reminds you after ${SAVE_REMINDER_THRESHOLD} calls without a manual save.
Session ID: ${sessionId}

**You still SHOULD call \`mnemo_save\` for important decisions, specs, and deliverables.**
Auto-capture records what tools you used. Manual saves record what you *decided* and *why*.
Both matter. Auto-capture is the safety net; manual saves are the high-signal memory.

**SAVE PROTOCOL:**
- Call \`mnemo_save\` after major decisions, specs, or deliverables
- Call \`session_end\` before wrapping up — it flushes auto-capture, saves, and commits your brain lane
- Auto-capture handles the rest

`;

      return {
        content: [{ type: "text", text: identity + parts.join("\n\n---\n\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Startup error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- read_brain_file: read any brain lane file ---
server.tool(
  "read_brain_file",
  "Read a file from the Sparks Brain directory (~/github/sparks-brain-guy/brain/). Use this to check brain lanes, reference docs, or any .md file in the brain.",
  {
    filename: z.string().describe("Filename to read, e.g. 'opie.md', 'active.md', 'stack.md'"),
  },
  async ({ filename }) => {
    captureCall("read_brain_file", `read ${filename}`);
    try {
      // Sanitize — only allow filenames, no path traversal
      const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "");
      const content = await readFile(join(BRAIN_DIR, safe), "utf-8");
      return { content: [{ type: "text", text: content + (nudgeCheck() || "") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error reading ${filename}: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- list_brain_files: see what's in the brain ---
server.tool(
  "list_brain_files",
  "List all files in the Sparks Brain directory. Use to discover what brain lanes and reference docs are available.",
  {},
  async () => {
    try {
      const files = await readdir(BRAIN_DIR);
      const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
      return {
        content: [{ type: "text", text: `Brain files:\n${mdFiles.map((f) => `- ${f}`).join("\n")}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error listing brain: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- write_brain_file: update brain lane files ---
server.tool(
  "write_brain_file",
  "Write or update a file in the Sparks Brain directory. Use at session end to update opie.md or other brain files you own. Do NOT write to cc-session.md (CC only) or CLAUDE.md.",
  {
    filename: z.string().describe("Filename to write, e.g. 'opie.md', 'active.md'"),
    content: z.string().describe("Full file content to write"),
  },
  async ({ filename, content }) => {
    captureCall("write_brain_file", `wrote ${filename} (${content.length} bytes)`);
    try {
      const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "");
      // Guard CC-only and system files
      if (["cc-session.md", "CLAUDE.md"].includes(safe)) {
        return {
          content: [{ type: "text", text: `Refused: ${safe} is not yours to write.` }],
          isError: true,
        };
      }
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(BRAIN_DIR, safe), content, "utf-8");
      return { content: [{ type: "text", text: `Wrote ${safe} (${content.length} bytes)` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error writing ${filename}: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- session_end: wrap-up save + brain commit ---
server.tool(
  "session_end",
  "Call this before ending a session. Saves a final summary to Mnemo Cortex and commits brain lane changes. This is your last chance to preserve what happened in this conversation.",
  {
    summary: z.string().describe("Final session summary — what was accomplished, decided, and what's next"),
    key_facts: z
      .array(z.string())
      .optional()
      .describe("Key facts to remember from this session"),
  },
  async ({ summary, key_facts }) => {
    // Drain auto-capture buffer before final save
    await flushBuffer();
    trackSave();
    const results = [];

    // 1. Save to Mnemo
    try {
      const sid = sessionId || `opie-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}`;
      const data = await mnemoPost("/writeback", {
        session_id: sid,
        summary: `[SESSION END] ${summary}`,
        key_facts: key_facts || [],
        projects_referenced: [],
        decisions_made: [],
        agent_id: AGENT_ID,
      });
      results.push(`Mnemo save: OK (memory_id=${data.memory_id || "ok"})`);
    } catch (err) {
      results.push(`Mnemo save: FAILED (${err.message})`);
    }

    // 2. Git commit + push brain lane changes
    try {
      const { execSync } = await import("node:child_process");
      const gitStatus = execSync("git status --porcelain", { cwd: BRAIN_DIR, encoding: "utf-8" }).trim();
      if (gitStatus) {
        execSync("git add -A", { cwd: BRAIN_DIR });
        execSync(`git commit -m "brain: Opie session end — ${new Date().toISOString().slice(0, 10)}"`, { cwd: BRAIN_DIR });
        execSync("git push", { cwd: BRAIN_DIR });
        results.push("Brain commit + push: OK");
      } else {
        results.push("Brain commit: no changes to commit");
      }
    } catch (err) {
      results.push(`Brain commit: FAILED (${err.message})`);
    }

    const elapsed = sessionStartTime
      ? `Session duration: ${Math.round((Date.now() - new Date(sessionStartTime).getTime()) / 60000)} minutes.`
      : "";

    return {
      content: [
        {
          type: "text",
          text: `Session end complete.\n${results.join("\n")}\n${elapsed}\nTotal tool calls this session: ${toolCallCount}`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// WikAI tools — search and read the local knowledge wiki
// ---------------------------------------------------------------------------

server.tool(
  "wiki_search",
  "Search the WikAI knowledge base (~/wiki/) — 3000+ pages of indexed project docs, session transcripts, entities, and concepts. Uses grep under the hood. Returns matching filenames and context lines. Use this to find information about projects, people, decisions, or any topic the Librarian has indexed.",
  {
    query: z.string().describe("Search term or phrase to find in the wiki"),
    section: z
      .enum(["all", "projects", "entities", "concepts", "sources"])
      .optional()
      .describe("Limit search to a wiki section. Default: all"),
    max_results: z
      .number()
      .optional()
      .describe("Max files to return (default 10)"),
  },
  async ({ query, section, max_results }) => {
    const limit = max_results || 10;
    const searchDir = section && section !== "all" ? join(WIKI_DIR, section) : WIKI_DIR;
    captureCall("wiki_search", `wiki search: "${query}" in ${section || "all"} → `);
    try {
      // Use grep -ril for case-insensitive file matching, then grab context
      const grepResult = execSync(
        `grep -ril --include='*.md' ${JSON.stringify(query)} ${JSON.stringify(searchDir)} 2>/dev/null | head -${limit}`,
        { encoding: "utf-8", timeout: 10000 }
      ).trim();

      if (!grepResult) {
        return { content: [{ type: "text", text: `No wiki pages found for "${query}".` + (nudgeCheck() || "") }] };
      }

      const files = grepResult.split("\n");
      const results = [];

      for (const filePath of files) {
        const relPath = filePath.replace(WIKI_DIR + "/", "");
        try {
          // Get matching lines with context
          const context = execSync(
            `grep -in -C 1 ${JSON.stringify(query)} ${JSON.stringify(filePath)} 2>/dev/null | head -12`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim();
          results.push(`### ${relPath}\n\`\`\`\n${context}\n\`\`\``);
        } catch (_) {
          results.push(`### ${relPath}\n(matched but could not extract context)`);
        }
      }

      const text = `Found ${files.length} wiki pages for "${query}":\n\n${results.join("\n\n")}`;
      return { content: [{ type: "text", text: text + (nudgeCheck() || "") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Wiki search error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "wiki_read",
  "Read a specific WikAI page by path (relative to ~/wiki/). Example: 'projects/peter-widget.md', 'entities/rocky.md', 'sources/2026-04-09.md'. Use wiki_search first to find the right page, then wiki_read to get the full content.",
  {
    path: z.string().describe("Relative path within ~/wiki/, e.g. 'projects/peter-widget.md' or 'entities/guy.md'"),
  },
  async ({ path: wikiPath }) => {
    captureCall("wiki_read", `read wiki: ${wikiPath}`);
    try {
      // Sanitize — block path traversal
      const clean = wikiPath.replace(/\.\./g, "").replace(/^\//, "");
      const fullPath = join(WIKI_DIR, clean);

      // Verify it's still under WIKI_DIR
      if (!fullPath.startsWith(WIKI_DIR)) {
        return { content: [{ type: "text", text: "Path traversal blocked." }], isError: true };
      }

      const content = await readFile(fullPath, "utf-8");
      // Truncate very large pages (some source pages are huge)
      const MAX_CHARS = 12000;
      const truncated = content.length > MAX_CHARS
        ? content.slice(0, MAX_CHARS) + `\n\n---\n*[Truncated — ${content.length} chars total, showing first ${MAX_CHARS}]*`
        : content;

      return { content: [{ type: "text", text: truncated + (nudgeCheck() || "") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error reading wiki page "${wikiPath}": ${err.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "wiki_index",
  "Get the WikAI index — lists all projects, entities, and concepts in the wiki. Good starting point to see what knowledge is available.",
  {},
  async () => {
    try {
      const index = await readFile(join(WIKI_DIR, "index.md"), "utf-8");
      // Return just the structured sections (skip the giant sources list)
      const MAX_CHARS = 8000;
      const truncated = index.length > MAX_CHARS
        ? index.slice(0, MAX_CHARS) + "\n\n---\n*[Index truncated — use wiki_search for specific topics]*"
        : index;
      return { content: [{ type: "text", text: truncated }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error reading wiki index: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
