import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "already-v2",
  async setup(ctx) {
    await ctx.storage.set("loaded", true)
  },
})
