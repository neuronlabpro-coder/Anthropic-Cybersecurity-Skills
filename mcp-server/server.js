import express from "express";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SKILLS_DIR = process.env.SKILLS_DIR || path.join(__dirname, "repo", "skills");
const INDEX_PATH = process.env.INDEX_PATH || path.join(__dirname, "repo", "index.json");
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const PORT = parseInt(process.env.PORT || "3000", 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "100", 10);

// --- helpers ----------------------------------------------------------------

async function readFileSafe(filePath) {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function getSkillDir(skillName) {
  const dir = path.join(SKILLS_DIR, skillName);
  try {
    await fs.access(dir);
    return dir;
  } catch {
    return null;
  }
}

async function loadIndex() {
  const raw = await readFileSafe(INDEX_PATH);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return parsed.skills || [];
}

// --- MCP tool handlers -------------------------------------------------------

async function toolListSkills({ filter, limit, offset }) {
  const skills = await loadIndex();

  let results = skills;

  if (filter) {
    const lc = filter.toLowerCase();
    results = results.filter(
      (s) =>
        s.name.toLowerCase().includes(lc) ||
        (s.description || "").toLowerCase().includes(lc) ||
        (s.domain || "").toLowerCase().includes(lc)
    );
  }

  const total = results.length;
  const start = offset || 0;
  const end = start + (limit || 50);
  const page = results.slice(start, end);

  // Enrich with SKILL.md frontmatter for paged results
  const enriched = await Promise.all(
    page.map(async (skill) => {
      const skillPath = path.join(SKILLS_DIR, skill.name, "SKILL.md");
      const raw = await readFileSafe(skillPath);
      if (!raw) return skill;
      const { data: frontmatter } = matter(raw);
      return { ...skill, frontmatter };
    })
  );

  return {
    total,
    offset: start,
    limit: end - start,
    skills: enriched,
  };
}

async function toolGetSkill({ skill_name }) {
  const dir = await getSkillDir(skill_name);
  if (!dir) {
    return { error: `Skill '${skill_name}' not found.` };
  }

  const raw = await readFileSafe(path.join(dir, "SKILL.md"));
  if (!raw) {
    return { error: `SKILL.md not found for '${skill_name}'.` };
  }

  const { data: frontmatter, content } = matter(raw);
  return { skill_name, frontmatter, content, raw };
}

async function toolGetSkillScripts({ skill_name }) {
  const dir = await getSkillDir(skill_name);
  if (!dir) {
    return { error: `Skill '${skill_name}' not found.` };
  }

  const scriptsDir = path.join(dir, "scripts");
  let files = [];
  try {
    files = await fs.readdir(scriptsDir);
  } catch {
    return { skill_name, scripts: [], message: "No scripts directory found." };
  }

  const scripts = await Promise.all(
    files.map(async (file) => {
      const content = await readFileSafe(path.join(scriptsDir, file));
      return { filename: file, content: content || "" };
    })
  );

  return { skill_name, scripts };
}

async function toolGetSkillReferences({ skill_name }) {
  const dir = await getSkillDir(skill_name);
  if (!dir) {
    return { error: `Skill '${skill_name}' not found.` };
  }

  const refsDir = path.join(dir, "references");
  let files = [];
  try {
    files = await fs.readdir(refsDir);
  } catch {
    return { skill_name, references: [], message: "No references directory found." };
  }

  const references = await Promise.all(
    files.map(async (file) => {
      const content = await readFileSafe(path.join(refsDir, file));
      return { filename: file, content: content || "" };
    })
  );

  return { skill_name, references };
}

// --- MCP server setup --------------------------------------------------------

function createMcpServer() {
  const server = new McpServer({
    name: "cybersecurity-skills",
    version: "1.0.0",
  });

  server.tool(
    "list_skills",
    "List all available cybersecurity skills with frontmatter metadata. Supports filtering and pagination.",
    {
      filter: z.string().optional().describe("Optional keyword to filter by name, description, or domain"),
      limit: z.number().int().min(1).max(200).optional().describe("Max results per page (default 50)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
    },
    async (args) => {
      const result = await toolListSkills(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_skill",
    "Retrieve the full SKILL.md content and parsed frontmatter for a specific skill by name.",
    {
      skill_name: z.string().describe("Exact skill directory name (e.g. 'analyzing-linux-elf-malware')"),
    },
    async (args) => {
      const result = await toolGetSkill(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_skill_scripts",
    "Retrieve all script files (Python agents, shell scripts, etc.) for a specific skill.",
    {
      skill_name: z.string().describe("Exact skill directory name"),
    },
    async (args) => {
      const result = await toolGetSkillScripts(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_skill_references",
    "Retrieve all reference files (API references, standards, workflows) for a specific skill.",
    {
      skill_name: z.string().describe("Exact skill directory name"),
    },
    async (args) => {
      const result = await toolGetSkillReferences(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  return server;
}

// --- Express + auth + rate limit --------------------------------------------

const app = express();
app.use(express.json());

// Health check (no auth, no rate-limit — must come first)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", skills_dir: SKILLS_DIR });
});

// Auth middleware
function authMiddleware(req, res, next) {
  if (!MCP_AUTH_TOKEN) return next();

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (token !== MCP_AUTH_TOKEN) {
    res.status(401).json({ error: "Unauthorized: invalid or missing MCP_AUTH_TOKEN" });
    return;
  }
  next();
}

// Rate limiter
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: `Rate limit exceeded: max ${RATE_LIMIT_MAX} requests per minute` },
});

app.use(limiter);
app.use(authMiddleware);

// SSE transport map: one transport per session
const transports = new Map();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  res.on("close", () => {
    transports.delete(sessionId);
  });

  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);

  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  await transport.handlePostMessage(req, res);
});

// --- REST endpoints ----------------------------------------------------------

app.get("/skills", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 1000);
  const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);
  const filter = req.query.filter || "";

  try {
    const result = await toolListSkills({ filter: filter || undefined, limit, offset });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/skills/:skill_name", async (req, res) => {
  const { skill_name } = req.params;

  try {
    const result = await toolGetSkill({ skill_name });
    if (result.error) {
      res.status(404).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`MCP Skills server listening on port ${PORT}`);
  console.log(`Skills directory: ${SKILLS_DIR}`);
  console.log(`Auth: ${MCP_AUTH_TOKEN ? "enabled" : "disabled"}`);
  console.log(`Rate limit: ${RATE_LIMIT_MAX} req/min`);
});
