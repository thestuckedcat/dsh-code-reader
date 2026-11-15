#!/usr/bin/env node
// Read-only reader for the pinned Harness Electron archive (resources/app.asar).
//
// Independent verifier implementation for the 04 read-only workbench slice. The
// ASAR container mechanism (8-byte pickle size header, V8-serialized header
// payload holding a little-endian uint32 size, then a JSON entry tree, then
// offset-addressed file payloads) follows the same reviewed mechanism used by
// 08-workbench-ui/tools/host-rc5/asar.mjs; this file is a separate, smaller
// implementation and does not import 08 code. It only reads bytes:
//   * it never executes archive content,
//   * it never writes into the archive,
//   * every read is bounds-checked against the archive size.
//
// API: sha256(buffer), sha256File(path), readArchiveHeader(archive),
//      lookupEntry(header, entryPath), readEntry(archive, header, dataOffset,
//      entryPath), readJsonEntry(archive, entryPath), listEntries(header).
import {createHash} from 'node:crypto';
import {closeSync, openSync, readFileSync, readSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEFAULT_EXECUTABLE = 'E:/dsh/DeepSeek Harness.exe';
export const DEFAULT_ARCHIVE = 'E:/dsh/resources/app.asar';
export const HOST_ROOT = 'E:/dsh/resources/app.asar/dsh';

const MAX_HEADER_BYTES = 64 * 1024 * 1024;

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      position += read;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function readExact(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const chunk = readSync(fd, buffer, read, length - read, position + read);
    if (chunk === 0) throw new Error(`unexpected end of asar archive at byte ${position + read}`);
    read += chunk;
  }
  return buffer;
}

/**
 * Read and parse the ASAR header.
 * @returns {{header: object, dataOffset: number, headerSize: number, archiveSize: number}}
 */
export function readArchiveHeader(archive = DEFAULT_ARCHIVE) {
  const archiveSize = statSync(archive).size;
  const fd = openSync(archive, 'r');
  try {
    const sizeBuf = readExact(fd, 8, 0);
    const headerSize = sizeBuf.readUInt32LE(4);
    if (!Number.isSafeInteger(headerSize) || headerSize <= 0 || headerSize > MAX_HEADER_BYTES) {
      throw new Error(`implausible asar header size ${headerSize}`);
    }
    if (headerSize > archiveSize - 8) throw new Error('asar header exceeds archive size');
    const headerBuf = readExact(fd, headerSize, 8);
    const payloadSize = headerBuf.readUInt32LE(0);
    const stringSize = headerBuf.readUInt32LE(4);
    if (stringSize + 8 > Math.min(payloadSize + 4, headerSize)) {
      throw new Error('asar header JSON string exceeds pickle payload');
    }
    const json = headerBuf.subarray(8, 8 + stringSize).toString('utf8');
    let header;
    try {
      header = JSON.parse(json);
    } catch (error) {
      throw new Error(`asar header is not valid JSON: ${error.message}`);
    }
    if (header === null || typeof header !== 'object' || typeof header.files !== 'object') {
      throw new Error('asar header has no files tree');
    }
    return {header, dataOffset: 8 + headerSize, headerSize, archiveSize};
  } finally {
    closeSync(fd);
  }
}

function splitPath(entryPath) {
  return String(entryPath).replace(/^[/\\]+|[/\\]+$/g, '').split(/[/\\]/).filter((part) => part !== '');
}

/** Resolve one archive entry node; returns null when absent or a directory. */
export function lookupEntry(header, entryPath) {
  let node = {files: header.files ?? {}};
  for (const part of splitPath(entryPath)) {
    if (node === null || node.files === undefined || !(part in node.files)) return null;
    node = node.files[part];
  }
  return node?.files === undefined ? node : null;
}

/** Iterate leaf entries; filter is a path substring, max bounds the result. */
export function listEntries(header, {filter = '', max = 4000} = {}) {
  const rows = [];
  const matches = (path) => filter === '' || path.includes(filter);
  const walk = (node, prefix) => {
    if (rows.length >= max) return;
    for (const [name, entry] of Object.entries(node?.files ?? {})) {
      const full = prefix === '' ? name : `${prefix}/${name}`;
      if (entry?.files !== undefined) walk(entry, full);
      else if (matches(full)) {
        rows.push({
          path: full,
          size: entry?.size ?? 0,
          unpacked: entry?.unpacked === true,
          executable: entry?.executable === true,
        });
      }
      if (rows.length >= max) return;
    }
  };
  walk({files: header.files ?? {}}, '');
  return rows;
}

/** Read one entry's bytes. `unpacked` entries are read from app.asar.unpacked. */
export function readEntry(archive, header, dataOffset, entryPath) {
  const entry = lookupEntry(header, entryPath);
  if (entry === null) throw new Error(`asar entry not found: ${entryPath}`);
  if (entry.unpacked === true) {
    return readFileSync(resolve(dirname(archive), 'app.asar.unpacked', ...splitPath(entryPath)));
  }
  const offset = dataOffset + Number(entry.offset);
  const size = Number(entry.size);
  if (!Number.isFinite(offset) || !Number.isFinite(size) || size < 0) throw new Error(`asar entry ${entryPath} has invalid offset/size`);
  const archiveSize = statSync(archive).size;
  if (offset + size > archiveSize) throw new Error(`asar entry ${entryPath} exceeds archive size`);
  const fd = openSync(archive, 'r');
  try {
    return readExact(fd, size, offset);
  } finally {
    closeSync(fd);
  }
}

/** Read and JSON-parse one archive entry (UTF-8, BOM tolerated). */
export function readJsonEntry(archive, entryPath) {
  const {header, dataOffset} = readArchiveHeader(archive);
  const bytes = readEntry(archive, header, dataOffset, entryPath);
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

/** Convenience: archive header + readers bound to one archive path. */
export function openArchive(archive = DEFAULT_ARCHIVE) {
  const {header, dataOffset, headerSize, archiveSize} = readArchiveHeader(archive);
  return {
    archive,
    header,
    dataOffset,
    headerSize,
    archiveSize,
    lookup: (entryPath) => lookupEntry(header, entryPath),
    read: (entryPath) => readEntry(archive, header, dataOffset, entryPath),
    readJson: (entryPath) => JSON.parse(readEntry(archive, header, dataOffset, entryPath).toString('utf8').replace(/^\uFEFF/, '')),
    list: (options) => listEntries(header, options),
  };
}

// --- minimal CLI -----------------------------------------------------------
function main(argv) {
  const positional = [];
  let archive = DEFAULT_ARCHIVE;
  let filter = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--archive') archive = argv[++index];
    else if (argv[index] === '--filter') filter = argv[++index];
    else positional.push(argv[index]);
  }
  const command = positional[0];
  if (command === 'list') {
    const {header} = readArchiveHeader(archive);
    for (const row of listEntries(header, {filter})) {
      process.stdout.write(`${row.size}\t${row.unpacked ? 'unpacked' : 'packed'}\t${row.path}\n`);
    }
    return 0;
  }
  if (command === 'stat') {
    const {header} = readArchiveHeader(archive);
    process.stdout.write(`${JSON.stringify(lookupEntry(header, positional[1]))}\n`);
    return 0;
  }
  if (command === 'cat') {
    const {header, dataOffset} = readArchiveHeader(archive);
    process.stdout.write(readEntry(archive, header, dataOffset, positional[1]));
    return 0;
  }
  if (command === 'sha256') {
    const {header, dataOffset} = readArchiveHeader(archive);
    const bytes = readEntry(archive, header, dataOffset, positional[1]);
    process.stdout.write(`${sha256(bytes)}\t${bytes.length}\t${positional[1]}\n`);
    return 0;
  }
  process.stderr.write('usage: node asar.mjs list [--filter text] | stat <path> | cat <path> | sha256 <path> [--archive <path>]\n');
  return 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
