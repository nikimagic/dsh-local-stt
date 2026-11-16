/**
 * Минимальный ZIP: запись и чтение без внешних зависимостей.
 *
 * Свой писатель нужен ради воспроизводимости: фиксированные даты записей и
 * порядок файлов дают одинаковые байты при повторной сборке, поэтому SHA-256
 * архива можно держать в манифесте.
 */
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
const FLAG_UTF8 = 0x0800
/** 2026-01-01 00:00:00 — фиксированная дата записей. */
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index++) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Имя записи в архиве: всегда прямые слеши, без ведущих слешей. */
function normalizeName(name) {
  return name.replaceAll('\\', '/').replace(/^\/+/, '')
}

/**
 * Записать zip.
 * @param entries - `[{ name, data }]`; `name` — путь внутри архива.
 * @param outPath - куда положить архив.
 * @returns { size, sha256 } записанного файла.
 */
export async function writeZip(entries, outPath) {
  const sorted = [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of sorted) {
    const name = Buffer.from(normalizeName(entry.name), 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const deflated = deflateRawSync(data, { level: 9 })
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE
    const crc = crc32(data)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_HEADER, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(FLAG_UTF8, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(DOS_TIME, 10)
    header.writeUInt16LE(DOS_DATE, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)

    const centralEntry = Buffer.alloc(46)
    centralEntry.writeUInt32LE(CENTRAL_HEADER, 0)
    centralEntry.writeUInt16LE(20, 4)
    centralEntry.writeUInt16LE(20, 6)
    centralEntry.writeUInt16LE(FLAG_UTF8, 8)
    centralEntry.writeUInt16LE(method, 10)
    centralEntry.writeUInt16LE(DOS_TIME, 12)
    centralEntry.writeUInt16LE(DOS_DATE, 14)
    centralEntry.writeUInt32LE(crc, 16)
    centralEntry.writeUInt32LE(body.length, 20)
    centralEntry.writeUInt32LE(data.length, 24)
    centralEntry.writeUInt16LE(name.length, 28)
    centralEntry.writeUInt16LE(0, 30)
    centralEntry.writeUInt16LE(0, 32)
    centralEntry.writeUInt16LE(0, 34)
    centralEntry.writeUInt16LE(0, 36)
    centralEntry.writeUInt32LE(0, 38)
    centralEntry.writeUInt32LE(offset, 42)

    chunks.push(header, name, body)
    central.push(centralEntry, name)
    offset += header.length + name.length + body.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(sorted.length, 8)
  end.writeUInt16LE(sorted.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  const archive = Buffer.concat([...chunks, centralBuffer, end])
  await fsp.mkdir(dirname(outPath), { recursive: true })
  await fsp.writeFile(outPath, archive)
  return { size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }
}

/**
 * Прочитать центральную директорию архива.
 * @param buffer - весь архив в памяти.
 * @returns записи `{ name, method, compressedSize, size, offset }`.
 */
function readCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 66_000)
  let eocd = -1
  for (let index = buffer.length - 22; index >= minOffset; index--) {
    if (buffer.readUInt32LE(index) === END_OF_CENTRAL) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('Архив повреждён: не найдена центральная директория')

  const count = buffer.readUInt16LE(eocd + 10)
  const start = buffer.readUInt32LE(eocd + 16)
  const entries = []
  let cursor = start
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER) throw new Error('Архив повреждён: плохой заголовок записи')
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const offset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    if (flags & 0x0001) throw new Error(`Архив зашифрован: ${name}`)
    entries.push({ name, method, compressedSize, size, offset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Безопасный путь распаковки: запись не должна выйти за пределы каталога. */
function safeTarget(root, name) {
  const clean = normalize(name).replace(/^([/\\])+/, '')
  if (isAbsolute(clean) || /^[a-zA-Z]:/.test(clean)) throw new Error(`Абсолютный путь в архиве: ${name}`)
  const target = join(root, clean)
  const inside = relative(root, target)
  if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) {
    throw new Error(`Запись выходит за пределы каталога: ${name}`)
  }
  return target
}

/**
 * Распаковать zip.
 * @param buffer - весь архив в памяти.
 * @param destination - каталог распаковки.
 * @param options.signal - отмена между записями.
 * @param options.onProgress - `{ resource, completedBytes, totalBytes }`.
 * @returns число записанных файлов.
 */
export async function extractZip(buffer, destination, { signal, onProgress } = {}) {
  const entries = readCentralDirectory(buffer)
  const files = entries.filter((entry) => !entry.name.endsWith('/'))
  const total = files.reduce((sum, entry) => sum + entry.size, 0)
  let written = 0
  let lastReport = 0

  for (const entry of files) {
    signal?.throwIfAborted()
    const target = safeTarget(destination, entry.name)
    await fsp.mkdir(dirname(target), { recursive: true })
    const local = entry.offset
    if (buffer.readUInt32LE(local) !== LOCAL_HEADER) throw new Error(`Архив повреждён: ${entry.name}`)
    const nameLength = buffer.readUInt16LE(local + 26)
    const extraLength = buffer.readUInt16LE(local + 28)
    const start = local + 30 + nameLength + extraLength
    const body = buffer.subarray(start, start + entry.compressedSize)
    let data
    if (entry.method === METHOD_STORE) data = Buffer.from(body)
    else if (entry.method === METHOD_DEFLATE) data = inflateRawSync(body)
    else throw new Error(`Неизвестный метод сжатия ${entry.method}: ${entry.name}`)
    if (data.length !== entry.size) throw new Error(`Размер записи не совпал: ${entry.name}`)
    await fsp.writeFile(target, data)
    written += data.length
    const now = Date.now()
    if (onProgress && now - lastReport >= 300) {
      lastReport = now
      onProgress({ resource: entry.name, completedBytes: written, totalBytes: total })
    }
  }
  if (onProgress) onProgress({ resource: 'архив', completedBytes: total, totalBytes: total })
  return files.length
}

/** Прочитать zip целиком. */
export async function readZip(path) {
  return await fsp.readFile(path)
}
