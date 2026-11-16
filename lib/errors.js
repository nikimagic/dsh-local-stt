/** Ошибка подготовки файлов плагина с причиной, понятной карточке DSH. */
export class AssetError extends Error {
  constructor(message, reason, extra = {}) {
    super(message)
    this.name = 'AssetError'
    this.reason = reason
    Object.assign(this, extra)
  }
}

/** Причина по системной ошибке: сеть, диск, сертификат, таймаут. */
export function reasonOf(error) {
  if (error instanceof AssetError) return error.reason
  const message = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' ? String(error.code || '') : ''
  if (/ENOSPC|EDQUOT|EACCES|EPERM|EROFS/i.test(code) || /no space|space left/i.test(message)) {
    return 'storage'
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(code) || /\bdns\b/i.test(message)) return 'dns'
  if (/CERT|SSL|TLS/i.test(code) || /certificate/i.test(message)) return 'certificate'
  if (/timeout|stall|ETIMEDOUT/i.test(message)) return 'timeout'
  return 'network'
}
