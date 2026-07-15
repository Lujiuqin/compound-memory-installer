import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVER_VERSION = "0.1.1";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CONFIG_PATH = process.env.COMPOUND_MEMORY_CONFIG || path.join(os.homedir(), ".compound-memory", "config.json");

const normalize = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const dateKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const timestampKey = (date = new Date()) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const relativeUnix = (root, file) => path.relative(root, file).replaceAll("\\", "/");
const textResult = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - start) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function sanitizeFilename(value) {
  const cleaned = String(value || "记录").normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, " ").trim();
  return (cleaned || "记录").slice(0, 80);
}

async function loadConfig() {
  let config;
  try {
    config = JSON.parse((await fsp.readFile(CONFIG_PATH, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Compound Memory is not configured. Run the installer or memoryctl doctor. Expected ${CONFIG_PATH}`);
  }
  const vaultPath = path.resolve(process.env.COMPOUND_MEMORY_VAULT || config.vaultPath || "");
  if (!vaultPath || !fs.existsSync(vaultPath)) throw new Error(`Configured vault does not exist: ${vaultPath}`);
  return { ...config, vaultPath };
}

function safePath(vaultPath, relativePath) {
  const clean = String(relativePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  const resolved = path.resolve(vaultPath, clean);
  const root = `${path.resolve(vaultPath)}${path.sep}`;
  if (resolved !== path.resolve(vaultPath) && !resolved.startsWith(root)) throw new Error("Path escapes the configured vault");
  return resolved;
}

async function listMarkdown(vaultPath) {
  const results = [];
  const ignored = new Set([".git", ".obsidian", ".trash", "node_modules", "_Assets"]);
  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) results.push(full);
    }
  }
  await walk(vaultPath);
  return results;
}

async function readLimited(filePath) {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`Note is larger than ${MAX_FILE_BYTES} bytes`);
  return fsp.readFile(filePath, "utf8");
}

function parseFrontmatter(content) {
  const result = {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return result;
  const lines = match[1].split(/\r?\n/);
  let arrayKey = null;
  for (const line of lines) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && arrayKey) {
      result[arrayKey].push(item[1].replace(/^['"]|['"]$/g, ""));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const value = raw.trim();
    arrayKey = null;
    if (["aliases", "sources", "domains"].includes(key) && !value) {
      result[key] = [];
      arrayKey = key;
    } else if (value === "[]") result[key] = [];
    else if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value.slice(1, -1).split(",").map((x) => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
    } else result[key] = value.replace(/^['"]|['"]$/g, "");
  }
  return result;
}

const wikilinks = (content) => [...content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((match) => match[1].trim());

function shingles(value) {
  const source = normalize(value);
  const set = new Set();
  for (let i = 0; i < source.length - 1; i += 1) set.add(source.slice(i, i + 2));
  return set;
}

function similarity(left, right) {
  const a = shingles(left);
  const b = shingles(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

async function noteIndex(vaultPath) {
  const notes = [];
  for (const fullPath of await listMarkdown(vaultPath)) {
    const content = await readLimited(fullPath);
    notes.push({
      fullPath,
      relativePath: relativeUnix(vaultPath, fullPath),
      title: path.basename(fullPath, path.extname(fullPath)),
      content,
      frontmatter: parseFrontmatter(content),
      links: wikilinks(content)
    });
  }
  return notes;
}

async function resolveNote(vaultPath, requested) {
  const direct = safePath(vaultPath, requested);
  for (const candidate of [direct, direct.endsWith(".md") ? direct : `${direct}.md`]) {
    if (fs.existsSync(candidate) && (await fsp.stat(candidate)).isFile()) return candidate;
  }
  const key = normalize(path.basename(String(requested), ".md"));
  const matches = (await noteIndex(vaultPath)).filter((note) =>
    normalize(note.title) === key || (Array.isArray(note.frontmatter.aliases) && note.frontmatter.aliases.some((alias) => normalize(alias) === key))
  );
  if (matches.length === 1) return matches[0].fullPath;
  if (matches.length > 1) throw new Error(`Ambiguous note name: ${requested}`);
  throw new Error(`Note not found: ${requested}`);
}

async function atomicWrite(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.compound-memory-${process.pid}.tmp`;
  await fsp.writeFile(temp, content, "utf8");
  await fsp.rename(temp, filePath);
}

async function git(vaultPath, args, allowFailure = false) {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", vaultPath, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    if (!allowFailure) throw new Error(error.stderr || error.message);
    return { ok: false, stdout: String(error.stdout || "").trim(), stderr: String(error.stderr || error.message).trim() };
  }
}

async function gitState(vaultPath) {
  const isRepo = await git(vaultPath, ["rev-parse", "--is-inside-work-tree"], true);
  if (!isRepo.ok) return { isRepo: false, clean: false, conflicts: [], status: "not initialized" };
  const status = await git(vaultPath, ["status", "--porcelain=v1", "--branch"]);
  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  const conflicts = lines.filter((line) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(line));
  return { isRepo: true, clean: lines.slice(1).length === 0, conflicts, status: status.stdout };
}

async function assertWritable(vaultPath) {
  const state = await gitState(vaultPath);
  if (state.isRepo && state.conflicts.length) throw new Error("Git conflicts detected. Memory writes are paused until resolved.");
  return state;
}

async function appendEvent(vaultPath, event) {
  const eventPath = safePath(vaultPath, "_System/Metrics/events.jsonl");
  await fsp.mkdir(path.dirname(eventPath), { recursive: true });
  await fsp.appendFile(eventPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
}

async function memoryStatus() {
  const config = await loadConfig();
  const state = await gitState(config.vaultPath);
  const notes = await listMarkdown(config.vaultPath);
  const lastCommit = state.isRepo ? await git(config.vaultPath, ["log", "-1", "--format=%h %cI %s"], true) : { stdout: "" };
  return { configured: true, vaultPath: config.vaultPath, deviceId: config.deviceId || os.hostname(), noteCount: notes.length, git: state, lastCommit: lastCommit.stdout || null };
}

async function memorySearch(args) {
  const { vaultPath } = await loadConfig();
  const query = String(args.query || "").trim();
  if (!query) throw new Error("query is required");
  const limit = Math.min(Math.max(Number(args.limit || 10), 1), 50);
  return (await noteIndex(vaultPath))
    .filter((note) => !args.type || note.frontmatter.type === args.type)
    .map((note) => {
      const titleScore = normalize(note.title).includes(normalize(query)) ? 4 : 0;
      const aliasScore = Array.isArray(note.frontmatter.aliases) && note.frontmatter.aliases.some((alias) => normalize(alias).includes(normalize(query))) ? 3 : 0;
      const bodyScore = normalize(note.content).includes(normalize(query)) ? 2 : similarity(query, note.content.slice(0, 8000));
      return {
        path: note.relativePath,
        title: note.title,
        type: note.frontmatter.type || null,
        status: note.frontmatter.status || null,
        score: Number((titleScore + aliasScore + bodyScore).toFixed(3)),
        excerpt: note.content.replace(/^---[\s\S]*?---\s*/, "").replace(/\s+/g, " ").slice(0, 220)
      };
    })
    .filter((item) => item.score > 0.05)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

async function memoryRead(args) {
  const { vaultPath } = await loadConfig();
  const filePath = await resolveNote(vaultPath, args.path);
  return { path: relativeUnix(vaultPath, filePath), content: await readLimited(filePath) };
}

async function memoryCapture(args) {
  const { vaultPath } = await loadConfig();
  await assertWritable(vaultPath);
  const body = String(args.content || "").trim();
  if (!body) throw new Error("content is required");
  const now = new Date();
  const title = sanitizeFilename(args.title || body.split(/\r?\n/)[0].slice(0, 50));
  const relativePath = `01-收件箱/Codex/${dateKey(now)} ${title} ${timestampKey(now).slice(9, 15)}.md`;
  const filePath = safePath(vaultPath, relativePath);
  if (fs.existsSync(filePath)) throw new Error(`Capture already exists: ${relativePath}`);
  const source = String(args.source || "Codex").replaceAll("\n", " ");
  const domains = Array.isArray(args.tags) ? args.tags.map((tag) => String(tag).replaceAll("\n", " ")) : [];
  const markdown = `---\nid: capture-${timestampKey(now).toLowerCase()}\ntype: capture\nstatus: inbox\ncreated: ${dateKey(now)}\nupdated: ${dateKey(now)}\ndomains: [${domains.join(", ")}]\naliases: []\nsources:\n  - ${source}\nreview_after:\n---\n\n# ${title}\n\n## 原始内容\n\n${body}\n\n## 处理建议\n\n- [ ] 搜索并更新已有观点\n- [ ] 补充来源与相关链接\n`;
  await atomicWrite(filePath, markdown);
  await appendEvent(vaultPath, { action: "capture", target: relativePath, source });
  return { created: relativePath, message: "Captured to the Codex inbox. Search existing notes before promotion." };
}

async function memoryAppend(args) {
  const { vaultPath } = await loadConfig();
  await assertWritable(vaultPath);
  const filePath = await resolveNote(vaultPath, args.path);
  const increment = String(args.content || "").trim();
  if (!increment) throw new Error("content is required");
  const section = String(args.section || "增量记录").trim();
  let content = await readLimited(filePath);
  const dated = `- ${dateKey()}：${increment}`;
  const heading = `## ${section}`;
  const index = content.indexOf(heading);
  if (index < 0) content = `${content.trimEnd()}\n\n${heading}\n\n${dated}\n`;
  else {
    const afterHeading = index + heading.length;
    const nextHeading = content.slice(afterHeading).search(/\n##\s+/);
    const insertion = nextHeading < 0 ? content.length : afterHeading + nextHeading;
    content = `${content.slice(0, insertion).trimEnd()}\n${dated}\n\n${content.slice(insertion).replace(/^\s+/, "")}`;
  }
  content = content.replace(/^(updated:\s*).+$/m, `$1${dateKey()}`);
  await atomicWrite(filePath, content);
  const relativePath = relativeUnix(vaultPath, filePath);
  await appendEvent(vaultPath, { action: "append", target: relativePath, section });
  return { updated: relativePath, section, appendOnly: true };
}

async function memoryRelated(args) {
  const { vaultPath } = await loadConfig();
  let query = String(args.query || "");
  let exclude = null;
  if (args.path) {
    const filePath = await resolveNote(vaultPath, args.path);
    query = await readLimited(filePath);
    exclude = relativeUnix(vaultPath, filePath);
  }
  if (!query.trim()) throw new Error("query or path is required");
  const limit = Math.min(Math.max(Number(args.limit || 10), 1), 30);
  return (await noteIndex(vaultPath))
    .map((note) => ({ path: note.relativePath, title: note.title, similarity: Number(similarity(query.slice(0, 12000), `${note.title}\n${note.content.slice(0, 12000)}`).toFixed(3)) }))
    .filter((item) => item.path !== exclude && item.similarity >= 0.08)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

async function memoryHealth() {
  const { vaultPath } = await loadConfig();
  const notes = await noteIndex(vaultPath);
  const byTitle = new Map();
  const existing = new Set();
  const incoming = new Map();
  const result = { duplicates: [], missingMetadata: [], missingSources: [], staleInbox: [], brokenLinks: [], orphans: [] };

  for (const note of notes) {
    existing.add(normalize(note.title));
    existing.add(normalize(note.relativePath.replace(/\.md$/i, "")));
    for (const alias of Array.isArray(note.frontmatter.aliases) ? note.frontmatter.aliases : []) existing.add(normalize(alias));
  }
  for (const note of notes) for (const link of note.links) incoming.set(normalize(link), (incoming.get(normalize(link)) || 0) + 1);

  for (const note of notes) {
    if (note.relativePath.startsWith("_System/Reports/") || note.relativePath.startsWith("_System/Templates/")) continue;
    for (const value of [note.title, ...(Array.isArray(note.frontmatter.aliases) ? note.frontmatter.aliases : [])]) {
      const key = normalize(value);
      if (!key) continue;
      if (byTitle.has(key) && byTitle.get(key) !== note.relativePath) result.duplicates.push(`${byTitle.get(key)} ↔ ${note.relativePath}`);
      else byTitle.set(key, note.relativePath);
    }
    if (/^(03-观点卡|04-项目|05-来源)\//.test(note.relativePath)) {
      const missing = ["id", "type", "status", "created", "updated"].filter((key) => note.frontmatter[key] === undefined || note.frontmatter[key] === "");
      if (missing.length) result.missingMetadata.push({ path: note.relativePath, missing });
    }
    if (note.frontmatter.type === "evergreen" && (!Array.isArray(note.frontmatter.sources) || note.frontmatter.sources.length === 0)) result.missingSources.push(note.relativePath);
    if (note.relativePath.startsWith("01-收件箱/") && !note.relativePath.endsWith("收件箱说明.md")) {
      const stat = await fsp.stat(note.fullPath);
      const ageDays = Math.floor((Date.now() - stat.mtimeMs) / 86400000);
      if (ageDays >= 3) result.staleInbox.push({ path: note.relativePath, ageDays });
    }
    for (const link of note.links) if (!existing.has(normalize(link))) result.brokenLinks.push(`${note.relativePath} → [[${link}]]`);
    if (note.relativePath.startsWith("03-观点卡/") && !note.relativePath.endsWith("观点卡说明.md")) {
      const stat = await fsp.stat(note.fullPath);
      const ageDays = Math.floor((Date.now() - stat.birthtimeMs) / 86400000);
      if (ageDays >= 14 && note.links.length === 0 && !(incoming.get(normalize(note.title)) || 0)) result.orphans.push(note.relativePath);
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    noteCount: notes.length,
    ...result,
    duplicates: [...new Set(result.duplicates)],
    brokenLinks: [...new Set(result.brokenLinks)],
    git: await gitState(vaultPath)
  };
}

async function readEvents(vaultPath, since) {
  const eventPath = safePath(vaultPath, "_System/Metrics/events.jsonl");
  if (!fs.existsSync(eventPath)) return [];
  return (await fsp.readFile(eventPath, "utf8")).split(/\r?\n/).filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((event) => event && new Date(event.timestamp) >= since);
}

async function memoryReview(args) {
  const { vaultPath } = await loadConfig();
  const period = args.period === "monthly" ? "monthly" : "weekly";
  const days = period === "monthly" ? 30 : 7;
  const events = await readEvents(vaultPath, new Date(Date.now() - days * 86400000));
  const captures = events.filter((event) => event.action === "capture").length;
  const appends = events.filter((event) => event.action === "append").length;
  const health = await memoryHealth();
  const upgradeRatio = appends + captures ? appends / (appends + captures) : 0;
  const proposals = [];
  if (health.staleInbox.length) proposals.push("缩短捕获字段，优先处理超过3天的收件箱内容。");
  if (health.duplicates.length) proposals.push("加强创建前搜索与别名匹配，复核精确重复候选。");
  if (health.orphans.length) proposals.push("把孤立观点加入项目、主题地图或相关知识链接。");
  if (upgradeRatio < 0.4 && captures + appends >= 5) proposals.push("提高旧观点候选曝光；下周期优先追加而不是新建。");
  if (health.git.conflicts.length) proposals.unshift("先解决 Git 冲突；在此之前暂停所有自动写入。");
  const key = period === "weekly" ? isoWeekKey() : dateKey().slice(0, 7);
  const relativePath = period === "weekly" ? `07-复盘/系统复盘/${key}.md` : `_System/Proposals/${key} 系统升级提案.md`;
  const markdown = `---\nid: ${period === "weekly" ? "system-review" : "system-proposal"}-${key}\ntype: ${period === "weekly" ? "system-review" : "system-proposal"}\nstatus: generated\ncreated: ${dateKey()}\nupdated: ${dateKey()}\ndomains: [系统]\naliases: []\nsources: []\nreview_after:\n---\n\n# ${key} ${period === "weekly" ? "系统复盘" : "系统升级提案"}\n\n## 自动指标\n\n- 捕获：${captures}\n- 增量更新：${appends}\n- 旧知识升级率：${(upgradeRatio * 100).toFixed(1)}%\n- 重复候选：${health.duplicates.length}\n- 收件箱积压：${health.staleInbox.length}\n- 孤立观点：${health.orphans.length}\n- 失效链接：${health.brokenLinks.length}\n\n## 系统建议\n\n${proposals.length ? proposals.map((item) => `- ${item}`).join("\n") : "- 当前没有触发升级建议。"}\n\n## 三个真实反馈\n\n1. 本周期真正复用了哪条旧知识？\n2. 哪次搜索没有找到想要的内容？\n3. 哪个维护步骤最麻烦？\n\n## 只选择一个实验\n\n- [ ] \n`;
  if (args.write !== false) {
    await assertWritable(vaultPath);
    await atomicWrite(safePath(vaultPath, relativePath), markdown);
    await appendEvent(vaultPath, { action: "review", target: relativePath, period });
  }
  return { period, metrics: { captures, appends, upgradeRatio, duplicates: health.duplicates.length, staleInbox: health.staleInbox.length, orphans: health.orphans.length, brokenLinks: health.brokenLinks.length }, proposals, written: args.write !== false ? relativePath : null, markdown };
}

async function memorySync(args) {
  const { vaultPath, deviceId } = await loadConfig();
  const mode = args.mode === "backup" ? "backup" : "pull";
  const state = await gitState(vaultPath);
  if (!state.isRepo) throw new Error("Vault is not a Git repository");
  if (state.conflicts.length) throw new Error("Git conflicts detected; synchronization is paused");
  await git(vaultPath, ["fetch", "origin"]);
  const upstream = await git(vaultPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], true);
  if (!upstream.ok) throw new Error("Current branch has no upstream remote");
  const counts = await git(vaultPath, ["rev-list", "--left-right", "--count", `HEAD...${upstream.stdout}`]);
  const [ahead, behind] = counts.stdout.split(/\s+/).map(Number);
  const refreshed = await gitState(vaultPath);
  if (mode === "pull") {
    if (!refreshed.clean) throw new Error("Local changes exist. Back them up before pulling.");
    if (ahead > 0 && behind > 0) throw new Error("Local and remote histories diverged; manual review is required.");
    if (behind > 0) await git(vaultPath, ["pull", "--ff-only"]);
    return { mode, ahead, behind, action: behind > 0 ? "fast-forwarded" : "already-current" };
  }
  if (behind > 0) throw new Error("Remote has newer commits. Pull on a clean worktree before backup.");
  if (!refreshed.clean) {
    await git(vaultPath, ["add", "-A"]);
    const message = String(args.commit_message || `backup[${deviceId || os.hostname()}]: ${new Date().toISOString()}`);
    await git(vaultPath, ["commit", "-m", message]);
  }
  await git(vaultPath, ["push", "origin", "HEAD"]);
  return { mode, action: refreshed.clean ? "pushed-existing-commits" : "committed-and-pushed" };
}

const TOOLS = [
  { name: "memory_status", description: "Check configured vault, note count and Git status before memory work.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "memory_search", description: "Search note titles, aliases and bodies in the private memory vault.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, type: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { name: "memory_read", description: "Read one note by relative path, title or unique alias.", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } }, additionalProperties: false } },
  { name: "memory_capture", description: "Create an append-only raw capture in the Codex inbox; never creates an evergreen note directly.", inputSchema: { type: "object", required: ["content"], properties: { content: { type: "string" }, title: { type: "string" }, source: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, additionalProperties: false } },
  { name: "memory_append", description: "Append a dated increment to an existing note without deleting or semantically rewriting prior content.", inputSchema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" }, section: { type: "string" } }, additionalProperties: false } },
  { name: "memory_related", description: "Find related or duplicate notes using deterministic local similarity.", inputSchema: { type: "object", properties: { query: { type: "string" }, path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 30 } }, additionalProperties: false } },
  { name: "memory_health", description: "Detect duplicates, missing metadata, sources, stale inbox items, broken links, orphans and Git conflicts.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "memory_review", description: "Generate a weekly review or monthly evolution proposal from local events and health signals.", inputSchema: { type: "object", properties: { period: { type: "string", enum: ["weekly", "monthly"] }, write: { type: "boolean" } }, additionalProperties: false } },
  { name: "memory_sync", description: "Safely fast-forward pull or explicitly commit and push; refuses conflicts and divergent history.", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["pull", "backup"] }, commit_message: { type: "string" } }, additionalProperties: false } }
];

async function callTool(name, args = {}) {
  const calls = { memory_status: memoryStatus, memory_search: memorySearch, memory_read: memoryRead, memory_capture: memoryCapture, memory_append: memoryAppend, memory_related: memoryRelated, memory_health: memoryHealth, memory_review: memoryReview, memory_sync: memorySync };
  if (!calls[name]) throw new Error(`Unknown tool: ${name}`);
  return calls[name](args);
}

async function runCli() {
  const command = process.argv[3] || "status";
  const mapping = {
    status: ["memory_status", {}],
    doctor: ["memory_health", {}],
    sync: ["memory_sync", { mode: process.argv.includes("--backup") ? "backup" : "pull" }],
    review: ["memory_review", { period: process.argv.includes("--monthly") ? "monthly" : "weekly", write: true }]
  };
  if (!mapping[command]) throw new Error(`Unknown memoryctl command: ${command}`);
  console.log(JSON.stringify(await callTool(...mapping[command]), null, 2));
}

async function runMcp() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.method === "notifications/initialized") continue;
    try {
      let result;
      if (request.method === "initialize") result = { protocolVersion: request.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "compound-memory", version: SERVER_VERSION } };
      else if (request.method === "tools/list") result = { tools: TOOLS };
      else if (request.method === "tools/call") result = textResult(await callTool(request.params?.name, request.params?.arguments || {}));
      else if (request.method === "ping") result = {};
      else throw new Error(`Unsupported method: ${request.method}`);
      if (request.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    } catch (error) {
      if (request.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: error.message }], isError: true } })}\n`);
    }
  }
}

if (process.argv[2] === "--cli") runCli().catch((error) => { console.error(error.message); process.exitCode = 1; });
else runMcp().catch((error) => { console.error(error.message); process.exitCode = 1; });
