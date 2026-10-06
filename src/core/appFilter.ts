/** The part of a macOS app's Info.plist that says which documents it opens. */
export interface AppInfo {
  CFBundleDocumentTypes?: {
    LSItemContentTypes?: string[]
    CFBundleTypeExtensions?: string[]
  }[]
}

const TEXT_TYPES = new Set([
  'public.text',
  'public.plain-text',
  'public.utf8-plain-text',
  'public.source-code',
  'net.daringfireball.markdown'
])
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'text'])

/** Whether an app declares that it opens plain text or markdown — i.e. it is a text editor. */
export function opensTextFiles(info: AppInfo): boolean {
  return (info.CFBundleDocumentTypes ?? []).some(
    (type) =>
      (type.LSItemContentTypes ?? []).some((uti) => TEXT_TYPES.has(uti)) ||
      (type.CFBundleTypeExtensions ?? []).some((ext) => TEXT_EXTENSIONS.has(ext.toLowerCase()))
  )
}
