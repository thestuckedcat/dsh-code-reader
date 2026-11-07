// Packaged skill provider: exposes skills/<name>/SKILL.md to the Host
// `ctx.skills` registry so every agent preset can discover them. Bodies are
// read on demand; the package directory is derived from import.meta.url, never
// from user configuration.
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_ROOT = join(PACKAGE_ROOT, 'skills')
const PROVIDER_NAME = 'dsh-code-reader'
const PACKAGED_SKILL_RANK = 550
const SOURCE = 'custom'

export function parseSkillFrontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const block = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const metadata = {}
  let current = null
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line.trim()) continue
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (match) {
      current = match[1]
      let value = match[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      metadata[current] = value
    } else if (current && /^\s+\S/.test(rawLine)) {
      metadata[current] = `${metadata[current]} ${line.trim()}`.trim()
    }
  }
  return { metadata, body }
}

async function parseSkillFile(skillFile, signal) {
  let text
  try {
    text = await readFile(skillFile, 'utf8')
  } catch {
    return undefined
  }
  if (signal?.aborted) return undefined
  const parsed = parseSkillFrontmatter(text)
  if (parsed === null) return undefined
  const name = typeof parsed.metadata.name === 'string' ? parsed.metadata.name : ''
  const description = typeof parsed.metadata.description === 'string' ? parsed.metadata.description : ''
  if (!name || !description) return undefined
  return {
    name,
    description,
    whenToUse: parsed.metadata.whenToUse,
    metadata: parsed.metadata,
    content: parsed.body,
  }
}

async function discover(skillsRoot, signal) {
  let entries
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const entry of entries) {
    if (signal?.aborted) break
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsRoot, entry.name)
    const skillFile = join(skillDir, 'SKILL.md')
    const parsed = await parseSkillFile(skillFile, signal)
    if (parsed === undefined) continue
    candidates.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: { modelInvocable: true, userInvocable: true },
      source: SOURCE,
      provider: PROVIDER_NAME,
      rank: PACKAGED_SKILL_RANK,
      locator: skillDir,
      path: skillFile,
      ...(Object.keys(parsed.metadata).length > 0 ? { metadata: parsed.metadata } : {}),
    })
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name))
  return candidates
}

export function createSkillProvider({ skillsRoot = SKILLS_ROOT } = {}) {
  return () => ({
    name: PROVIDER_NAME,
    async list(options = {}) {
      return discover(skillsRoot, options.signal)
    },
    async get(candidate, options = {}) {
      const parsed = await parseSkillFile(candidate.path, options.signal)
      if (parsed === undefined) return undefined
      return {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
        invocation: { modelInvocable: true, userInvocable: true },
        source: SOURCE,
        provider: PROVIDER_NAME,
        resourceBase: { kind: 'directory', path: candidate.locator },
        path: candidate.path,
        ...(Object.keys(parsed.metadata).length > 0 ? { metadata: parsed.metadata } : {}),
        content: parsed.content,
      }
    },
  })
}

export function registerSkillProvider(ctx, options = {}) {
  const factory = createSkillProvider(options)
  return ctx.effect(() => ctx.skills.registerProvider(factory), 'dsh-code-reader: learn-code-workspace skill')
}

export { PACKAGE_ROOT, SKILLS_ROOT, PROVIDER_NAME, PACKAGED_SKILL_RANK, SOURCE }
