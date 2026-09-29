/**
 * Build script for dsh-taskboard-kit.
 *
 * Host face:    src/host/index.ts   → lib/index.js   (ESM, node20)
 * Browser face: src/client/index.ts → lib/client.js  (CJS body inside the
 *               official `window.__ModuleLoader__.load({ id, factory })`
 *               envelope the dsh client module system serves over /plugins)
 *
 * The host build externalizes every bare specifier (the profile's node_modules
 * already provides @deepseek-ai/*) and bundles our own relative sources. The
 * browser build externalizes only the specifiers the module loader can resolve
 * at run time: the shell-seeded platform baseline (react and its jsx runtime).
 *
 * Run: `npm run build` (node 20+).
 */

import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * Bare specifiers the browser factory may require. Everything here must be
 * satisfiable by the dsh client module system — react and react/jsx-runtime are
 * part of the shell-seeded platform baseline.
 */
const clientExternals = ['react', 'react/jsx-runtime']

async function main() {
  rmSync(join(root, 'lib'), { recursive: true, force: true })
  mkdirSync(join(root, 'lib'), { recursive: true })

  // ---- host face ---------------------------------------------------------
  await build({
    entryPoints: [join(root, 'src/host/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: join(root, 'lib/index.js'),
    packages: 'external',
    logLevel: 'info',
  })

  // ---- browser face ------------------------------------------------------
  const head = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n`
  const tail = `\n\t\treturn module.exports;\n\t}\n});\n`
  const bodyFile = join(root, 'lib/.client.body.js')
  await build({
    entryPoints: [join(root, 'src/client/index.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    outfile: bodyFile,
    external: clientExternals,
    banner: { js: head },
    footer: { js: tail },
    logLevel: 'info',
  })

  // Read the body back and PROVE it is the bundle before publishing it.
  // On a churning filesystem (cloud-synced working tree) that immediate
  // read-back can come back empty: this used to write a 270-byte envelope with
  // an empty factory over lib/client.js and delete the only copy of the real
  // bundle — a silently broken browser face that only shows up as a kanban tab
  // that will not render. Fail loudly, and keep the body so a retry can use it.
  const body = readFileSync(bodyFile, 'utf8')
  if (body.length < 1000 || !body.includes('window.__ModuleLoader__.load')) {
    throw new Error(
      `client bundle read-back looks wrong (${body.length} bytes); ${bodyFile} was kept — re-run the build`,
    )
  }
  writeFileSync(join(root, 'lib/client.js'), body)
  rmSync(bodyFile, { force: true })

  console.log(`[build] lib/index.js + lib/client.js written (client ${body.length} bytes)`)

  // The host bundle deserves the same proof: a truncated one imports "fine"
  // until something calls a missing export.
  const host = readFileSync(join(root, 'lib/index.js'), 'utf8')
  if (host.length < 1000 || !host.includes('taskboard-kit')) {
    throw new Error(`host bundle read-back looks wrong (${host.length} bytes); re-run the build`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
