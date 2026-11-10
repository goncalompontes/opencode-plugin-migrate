export default async function jsPlugin(ctx) {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash" && String(output.args.command).includes("rm -rf")) {
        throw new Error(`blocked in ${ctx.directory}`)
      }
    },
  }
}
