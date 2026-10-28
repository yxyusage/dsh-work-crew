/**
 * Knowledge base: curated references that get injected into briefs.
 *
 * The crew's output quality depends on what the workers look at. Prose
 * instructions ("make it beautiful") do nothing; a concrete reference with a
 * "how to use / what not to do" line changes the result.
 *
 * Entries live as markdown files in two places:
 *   <plugin>/knowledge/*.md      built-in, shipped with the plugin
 *   <project>/.dsh-team/knowledge/*.md   project-specific, overrides by id
 *
 * File format:
 *   # id
 *   title: ...
 *   tags: a, b
 *   keywords: 中文关键词, 逗号或空格分隔
 *   url: ...
 *   use: 一句话，怎么用
 *   avoid: 一句话，别这样
 *
 *   - 规则 1
 *   - 规则 2
 */
import fs from 'node:fs';
import path from 'node:path';

const FIELD = /^([a-z]+):\s*(.+)$/i;

export function parseEntry(text, file = '') {
  const lines = text.split('\n');
  const entry = { id: path.basename(file, '.md'), title: '', tags: [], keywords: [], url: '', use: '', avoid: '', gates: [], rules: [], file };
  let i = 0;
  if (lines[i]?.startsWith('#')) {
    entry.id = lines[i].replace(/^#\s*/, '').trim() || entry.id;
    i += 1;
  }
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) { i += 1; break; }
    const match = FIELD.exec(line);
    if (!match) break;
    const [, key, raw] = match;
    const value = raw.trim();
    if (key.toLowerCase() === 'title') entry.title = value;
    else if (key.toLowerCase() === 'url') entry.url = value;
    else if (key.toLowerCase() === 'use') entry.use = value;
    else if (key.toLowerCase() === 'avoid') entry.avoid = value;
    else if (key.toLowerCase() === 'tags') entry.tags = value.split(/[,，\s]+/).filter(Boolean);
    else if (key.toLowerCase() === 'keywords') entry.keywords = value.split(/[,，]+/).map((k) => k.trim()).filter(Boolean);
    else if (key.toLowerCase() === 'gates') entry.gates = value.split(/[,，\s]+/).filter(Boolean);
  }
  entry.rules = lines.slice(i).map((line) => line.trim()).filter((line) => /^[-*]\s+/.test(line)).map((line) => line.replace(/^[-*]\s+/, ''));
  return entry;
}

export function loadEntries(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    try {
      entries.push(parseEntry(fs.readFileSync(path.join(dir, name), 'utf8'), path.join(dir, name)));
    } catch { /* a broken note must not break a dispatch */ }
  }
  return entries;
}

export function loadAll(pluginDir, projectDir) {
  const merged = new Map();
  for (const entry of loadEntries(path.join(pluginDir, 'knowledge'))) merged.set(entry.id, entry);
  for (const entry of loadEntries(path.join(projectDir, '.dsh-team', 'knowledge'))) merged.set(entry.id, entry);
  return [...merged.values()];
}

/**
 * Pick the entries a task should see.
 * Explicit tags win; otherwise Chinese/English keywords in the task text decide.
 * `worker` shifts the ranking so each role sees what it is accountable for.
 */
export function select(entries, { tags = [], text = '', limit = 4, worker = '' } = {}) {
  const haystack = `${text}`.toLowerCase();
  const wanted = new Set(tags.map((tag) => tag.toLowerCase()));
  const focus = new Set((WORKER_FOCUS[worker] || []).map((tag) => tag.toLowerCase()));
  const scored = [];
  for (const entry of entries) {
    let score = 0;
    for (const tag of entry.tags) {
      if (wanted.has(tag.toLowerCase())) score += 3;
      if (focus.has(tag.toLowerCase())) score += 2;
    }
    for (const word of entry.keywords) {
      if (word && haystack.includes(word.toLowerCase())) score += 2;
    }
    // The de-slop checklist applies to interface work only — on a backend task it
    // is noise that pushes a useful reference out of the four slots.
    const uiish = ['frontend', 'ui', 'design', 'copy', 'content'].some((tag) => wanted.has(tag))
      || /页面|界面|设计|文案|前端|审美/.test(`${text}`);
    if (entry.id === 'de-ai-slop' && uiish && !scored.some((item) => item.entry.id === 'de-ai-slop')) score += 1;
    if (score > 0) scored.push({ entry, score });
  }
  const sorted = scored.sort((a, b) => b.score - a.score).map((item) => item.entry);
  // For interface work these two are not optional; scoring alone can push them out
  // when a task matches many entries.
  const uiish = ['frontend', 'ui', 'design', 'copy', 'content'].some((tag) => wanted.has(tag))
    || /页面|界面|设计|文案|前端|审美/.test(`${text}`);
  const mandatory = uiish ? sorted.filter((entry) => ['de-ai-slop', 'frontend-ui'].includes(entry.id)) : [];
  const rest = sorted.filter((entry) => !mandatory.includes(entry));
  return [...mandatory, ...rest].slice(0, limit);
}

/**
 * What each worker is responsible for.
 *
 * Handing the same four entries to everyone wastes their context and blurs the
 * division of labour: the visual reviewer should be held to motion and hierarchy,
 * the auditor to security and structure, the writer to copy and docs.
 */
export const WORKER_FOCUS = {
  workbuddy: ['frontend', 'api', 'testing', 'pattern'],
  doubao: ['design', 'ui', 'motion', 'visual', 'copy'],
  zcode: ['copy', 'docs', 'writing', 'review'],
  qoder: ['security', 'backend', 'review', 'audit'],
};

/** Compact text for a brief: title, link, one line of how-to, one line of dont. */
export function render(entries, { maxRules = 3 } = {}) {
  if (!entries.length) return '';
  const parts = ['## 参考（动手前看，交付前对照）', ''];
  for (const entry of entries) {
    parts.push(`### ${entry.title || entry.id}${entry.url ? ` — ${entry.url}` : ''}`);
    if (entry.use) parts.push(`用：${entry.use}`);
    if (entry.avoid) parts.push(`别：${entry.avoid}`);
    for (const rule of entry.rules.slice(0, maxRules)) parts.push(`- ${rule}`);
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * Review-time checklist: the rules this artifact was supposed to follow.
 *
 * A reviewer told "check it" writes an opinion. A reviewer told "judge these 8
 * rules, each as done / not done with a location / not applicable" writes findings
 * the orchestrator can act on.
 */
export function renderChecklist(entries, { maxRules = 8 } = {}) {
  if (!entries.length) return '';
  // Round-robin across entries so the checklist covers every source instead of
  // spending all eight slots on the first one.
  const queue = entries.map((entry) => ({ entry, rules: [...entry.rules] }));
  const picked = [];
  while (picked.length < maxRules) {
    let progressed = false;
    for (const bucket of queue) {
      if (!bucket.rules.length) continue;
      picked.push({ entry: bucket.entry, rule: bucket.rules.shift() });
      progressed = true;
      if (picked.length >= maxRules) break;
    }
    if (!progressed) break;
  }
  const lines = ['## 对照清单（逐条判：做到了 / 没做到（指位置）/ 不适用）', ''];
  picked.forEach((item, index) => {
    lines.push(`${index + 1}. 【${item.entry.title || item.entry.id}】${item.rule}`);
  });
  return lines.join('\n');
}
