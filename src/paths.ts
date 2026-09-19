import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export const kodyHome = process.env.KODY_HOME ?? join(homedir(), '.local-kody')
export const packagesDir = join(kodyHome, 'packages')
export const storageDir = join(kodyHome, 'storage')
export const secretsFile = join(kodyHome, 'secrets.json')
export const guidesDir = join(projectRoot, 'guides')
export const denoBin =
	process.env.KODY_DENO_BIN ?? join(projectRoot, 'node_modules', '.bin', 'deno')

for (const directory of [kodyHome, packagesDir, storageDir]) {
	mkdirSync(directory, { recursive: true })
}
