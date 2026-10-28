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
  const entry = { id: path.basename(file, '.md'), title: '', tags: [], keywords: [], url: '', use: '', avoid: '', rules: [], file };
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
 */
export function select(entries, { tags = [], text = '', limit = 4 } = {}) {
  const haystack = `${text}`.toLowerCase();
  const wanted = new Set(tags.map((tag) => tag.toLowerCase()));
  const scored = [];
  for (const entry of entries) {
    let score = 0;
    for (const tag of entry.tags) {
      if (wanted.has(tag.toLowerCase())) score += 3;
    }
    for (const word of entry.keywords) {
      if (word && haystack.includes(word.toLowerCase())) score += 2;
    }
    // The de-slop checklist applies to any interface work, even without a match.
    if (entry.id === 'de-ai-slop' && !scored.some((item) => item.entry.id === 'de-ai-slop')) score += 1;
    if (score > 0) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((item) => item.entry);
}

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
