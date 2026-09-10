export type ShiftNote = {
  id: string
  facilityId: string
  title: string
  body: string
  authorName: string
  createdAt: string
}

type ShiftNoteRow = {
  id: string
  facility_id: string
  title: string
  body: string
  author_name: string
  created_at: string
}

export function toShiftNote(row: ShiftNoteRow): ShiftNote {
  return {
    id: row.id,
    facilityId: row.facility_id,
    title: row.title,
    body: row.body,
    authorName: row.author_name,
    createdAt: row.created_at,
  }
}

/** 一覧の 1 行に出す要約。本文の先頭 40 文字を切り出す */
export function summarizeShiftNote(note: ShiftNote): string {
  const head = note.body.slice(0, 40)
  return `${note.title}（${note.authorName}）: ${head}`
}
