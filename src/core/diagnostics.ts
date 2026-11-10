/** Structured, location-aware findings. Everything the tool reports is one of these. */
import { z } from "zod"

export const Severity = z.enum(["info", "warning", "error"])
export type Severity = z.infer<typeof Severity>

export const SourceRange = z.object({
  file: z.string(),
  /** 0-based offset of the node start in the source file. */
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
})
export type SourceRange = z.infer<typeof SourceRange>

export const Diagnostic = z.object({
  code: z.string(),
  severity: Severity,
  message: z.string(),
  range: SourceRange.optional(),
  hint: z.string().optional(),
  /** Hook, tool, or module region this finding came from. */
  origin: z.string().optional(),
})
export type Diagnostic = z.infer<typeof Diagnostic>

export function locationOf(file: string, start: number, end: number, line: number, column: number): SourceRange {
  return { file, start, end, line, column }
}
