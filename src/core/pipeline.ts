/**
 * A small, typed, observable pipeline. Stages declare the schema of their output so
 * every boundary in the migration is validated, not trusted. The builder preserves
 * the output type of one stage as the input type of the next, so a stage that changes
 * its result shape breaks compilation rather than silently feeding the next stage.
 */
import { z } from "zod"

export interface RunContext {
  /** Repository / working directory of the CLI. */
  readonly root: string
  /** Where generated output is written. */
  readonly outDir: string
  readonly log: (message: string) => void
  /** Tool-level switches available to stages (for example `dual`). */
  readonly options?: Readonly<Record<string, unknown>>
}

export interface Stage<I, O> {
  readonly name: string
  readonly input: z.ZodType<I>
  readonly output: z.ZodType<O>
  run(input: I, ctx: RunContext): Promise<O>
}

export type StageEvent =
  | { type: "start"; stage: string }
  | { type: "finish"; stage: string; ms: number }
  | { type: "fail"; stage: string; ms: number; error: unknown }

export interface Pipeline<In, Out> {
  readonly stages: ReadonlyArray<Stage<unknown, unknown>>
  run(input: In, ctx: RunContext): Promise<Out>
}

export interface StageDefinition<I, O> {
  name: string
  input: z.ZodType<I>
  output: z.ZodType<O>
  run(input: I, ctx: RunContext): Promise<O>
}

export function stage<I, O>(def: StageDefinition<I, O>): Stage<I, O> {
  return def
}

export class PipelineBuilder<In, Out> {
  readonly #stages: Stage<unknown, unknown>[] = []
  readonly #listeners: Array<(event: StageEvent) => void> = []

  /** Append a stage. `T` becomes the pipeline's new output type. */
  pipe<T>(def: StageDefinition<Out, T>): PipelineBuilder<In, T> {
    this.#stages.push(def as Stage<unknown, unknown>)
    return this as unknown as PipelineBuilder<In, T>
  }

  /** Observe stage lifecycle without changing the pipeline. */
  onStage(listener: (event: StageEvent) => void): this {
    this.#listeners.push(listener)
    return this
  }

  build(): Pipeline<In, Out> {
    const stages = [...this.#stages]
    const listeners = [...this.#listeners]
    const emit = (event: StageEvent) => {
      for (const listener of listeners) listener(event)
    }

    return {
      stages,
      async run(input: In, ctx: RunContext): Promise<Out> {
        let current: unknown = input
        for (const item of stages) {
          const parsed = item.input.safeParse(current)
          if (!parsed.success) {
            throw new Error(
              `stage "${item.name}" received invalid input:\n${z.prettifyError(parsed.error)}`,
            )
          }
          emit({ type: "start", stage: item.name })
          const started = performance.now()
          try {
            const output = await item.run(parsed.data, ctx)
            const validated = item.output.safeParse(output)
            if (!validated.success) {
              throw new Error(
                `stage "${item.name}" produced invalid output:\n${z.prettifyError(validated.error)}`,
              )
            }
            current = validated.data
            emit({ type: "finish", stage: item.name, ms: performance.now() - started })
          } catch (error) {
            emit({ type: "fail", stage: item.name, ms: performance.now() - started, error })
            throw error
          }
        }
        return current as Out
      },
    }
  }
}

export function pipeline<In>(): PipelineBuilder<In, In> {
  return new PipelineBuilder<In, In>()
}
