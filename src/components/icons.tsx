/* 内联 SVG 图标集（16px 视口，currentColor） */
import type { CSSProperties } from 'react'

const P: CSSProperties = { width: 16, height: 16, display: 'block' }

function S({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" style={{ ...P, ...style }} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

export const IconDb = () => (
  <S>
    <ellipse cx="8" cy="3.5" rx="5.5" ry="2" />
    <path d="M2.5 3.5v9c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2v-9" />
    <path d="M2.5 8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2" />
  </S>
)
export const IconSchema = () => (
  <S>
    <rect x="1.5" y="2" width="13" height="4" rx="1" />
    <rect x="1.5" y="10" width="13" height="4" rx="1" />
    <path d="M8 6v4" />
  </S>
)
export const IconTable = () => (
  <S>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.2" />
    <path d="M1.5 6h13M6 6v7.5M10.5 6v7.5" />
  </S>
)
export const IconView = () => (
  <S>
    <path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
  </S>
)
export const IconCaret = () => (
  <S style={{ width: 12, height: 12 }}>
    <path d="M5.5 3.5 10 8l-4.5 4.5" />
  </S>
)
export const IconChevronDown = () => (
  <S style={{ width: 13, height: 13 }}>
    <path d="m3.5 6 4.5 4.5L12.5 6" />
  </S>
)
export const IconChevronUp = () => (
  <S style={{ width: 13, height: 13 }}>
    <path d="m3.5 10 4.5-4.5 4.5 4.5" />
  </S>
)
export const IconChevronLeft = () => (
  <S style={{ width: 13, height: 13 }}>
    <path d="M10.5 3.5 6 8l4.5 4.5" />
  </S>
)
export const IconChevronRight = () => (
  <S style={{ width: 13, height: 13 }}>
    <path d="m3.5 3.5 4.5 4.5-4.5 4.5" />
  </S>
)
export const IconSearch = () => (
  <S>
    <circle cx="7" cy="7" r="4.2" />
    <path d="m10.4 10.4 3.1 3.1" />
  </S>
)
export const IconPlay = () => (
  <S style={{ width: 13, height: 13 }}>
    <path d="M4 2.8v10.4L13 8 4 2.8Z" fill="currentColor" stroke="none" />
  </S>
)
export const IconSave = () => (
  <S>
    <path d="M3 1.5h8.5L13.5 4.5V13a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V3A1.5 1.5 0 0 1 3 1.5Z" />
    <path d="M4.5 1.5V5h6V1.5M4.5 14v-4.5h7V14" />
  </S>
)
export const IconTrash = () => (
  <S>
    <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4M6.5 7v4.5M9.5 7v4.5" />
  </S>
)
export const IconCopy = () => (
  <S>
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.2" />
    <path d="M10.5 5.5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h2.5" />
  </S>
)
export const IconDownload = () => (
  <S>
    <path d="M8 1.5v8m0 0L4.8 6.3M8 9.5l3.2-3.2M2.5 12v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V12" />
  </S>
)
export const IconPlus = () => (
  <S>
    <path d="M8 2.5v11M2.5 8h11" />
  </S>
)
export const IconSun = () => (
  <S>
    <circle cx="8" cy="8" r="3.2" />
    <path d="M8 1.2v1.6M8 13.2v1.6M14.8 8h-1.6M2.8 8H1.2M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2 3.1 3.1" />
  </S>
)
export const IconMoon = () => (
  <S>
    <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
  </S>
)
export const IconKey = () => (
  <S>
    <circle cx="5" cy="8" r="3" />
    <path d="M8 8h6.5m-2 0v2.5M10 8v2" />
  </S>
)
export const IconWrench = () => (
  <S>
    <path d="M9.5 6.5 13 3a3.5 3.5 0 0 1-4.7 4.2L3 12.4a1.6 1.6 0 0 0 2.3 2.3l5.2-5.3A3.5 3.5 0 0 1 14.6 5l-3.3 3.3-1.8-1.8Z" />
  </S>
)
export const IconHistory = () => (
  <S>
    <path d="M2.2 8a5.8 5.8 0 1 1 1.7 4.1M2.2 8H.8m1.4 0 1.5-1.5M8 4.8V8l2.3 1.4" />
  </S>
)
export const IconDoc = () => (
  <S>
    <path d="M3 1.5h6.5L13.5 5v8.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" />
    <path d="M9.5 1.5V5h4M4.5 8h7M4.5 11h7" />
  </S>
)
export const IconPlug = () => (
  <S>
    <path d="M5.5 1.5v3m5-3v3M3.5 4.5h9v3a4.5 4.5 0 0 1-9 0v-3ZM8 12v2.5" />
  </S>
)
export const IconRefresh = () => (
  <S>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3" />
  </S>
)
export const IconInfo = () => (
  <S>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 7.2V11M8 5v.2" />
  </S>
)
export const IconWarn = () => (
  <S>
    <path d="M8 1.8 15 14H1L8 1.8Z" />
    <path d="M8 6.5v3.5M8 12v.2" />
  </S>
)
export const IconEdit = () => (
  <S>
    <path d="M2 14h12M11.5 1.7 14.3 4.5 5.8 13H3v-2.8l8.5-8.5Z" />
  </S>
)
export const IconConnect = () => (
  <S>
    <path d="M2.5 8.5v-3a3 3 0 0 1 3-3h5a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3h-1.8M6.3 5.3 4 7.6l2.3 2.3M4 7.6h6.5" />
  </S>
)

/* GitHub 官方 Logo（octicon mark-github，填充式） */
export const IconGithub = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" style={P} fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
)
