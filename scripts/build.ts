import { $ } from 'bun'

await $`bun add zod@4.0 --no-save` // build doesn't work without this
await $`bun build index.ts --define NODE_ENV=production --outdir dist --target bun --minify`

const outFile = 'dist/index.js'
const content = await Bun.file(outFile).text()
if (!content.startsWith('#!')) {
  await Bun.write(outFile, `#!/usr/bin/env bun\n${content}`)
}
await $`chmod +x ${outFile}`

console.log(`Built ${outFile}`)
