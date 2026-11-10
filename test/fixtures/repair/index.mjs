export default async function repairPlugin() {
  return {
    "tool.execute.after": async (input, output) => {
      function first(value) {
        return String(value)
      }
      function second(value) {
        return String(value)
      }
      if (input.tool === "demo") output.output = first(1) + second(2)
    },
  }
}
