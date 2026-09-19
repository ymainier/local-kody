import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { packagesDir } from './paths.ts'

// A package is a folder with a package.json whose `exports` map names the
// callable modules. Code imports them as `kody:@scope/leaf/<export>`.
export type PackageManifest = {
	name: string
	description: string
	exports: Record<string, string>
}

const packageNamePattern = /^@[a-z0-9-]+\/[a-z0-9-]+$/

function packageRoot(name: string) {
	if (!packageNamePattern.test(name)) {
		throw new Error(`Package name "${name}" must look like @scope/leaf (lowercase)`)
	}
	return join(packagesDir, name)
}

export function savePackage(input: PackageManifest & { files: Record<string, string> }) {
	const root = packageRoot(input.name)
	for (const [relativePath, source] of Object.entries(input.files)) {
		const target = normalize(join(root, relativePath))
		if (!target.startsWith(root + '/')) {
			throw new Error(`File path "${relativePath}" escapes the package folder`)
		}
		mkdirSync(dirname(target), { recursive: true })
		writeFileSync(target, source)
	}
	for (const [exportName, target] of Object.entries(input.exports)) {
		if (!exportName.startsWith('./')) {
			throw new Error(`Export "${exportName}" must start with ./`)
		}
		if (!existsSync(join(root, target))) {
			throw new Error(`Export "${exportName}" points at missing file ${target}`)
		}
	}
	const manifest: PackageManifest = {
		name: input.name,
		description: input.description,
		exports: input.exports,
	}
	writeFileSync(join(root, 'package.json'), JSON.stringify(manifest, null, 2))
	return manifest
}

export function listPackages(): Array<PackageManifest> {
	const manifests: Array<PackageManifest> = []
	for (const scope of readdirSync(packagesDir)) {
		if (!scope.startsWith('@')) continue
		for (const leaf of readdirSync(join(packagesDir, scope))) {
			const manifestPath = join(packagesDir, scope, leaf, 'package.json')
			if (existsSync(manifestPath)) {
				manifests.push(JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest)
			}
		}
	}
	return manifests
}

export function getPackage(name: string) {
	const manifestPath = join(packageRoot(name), 'package.json')
	if (!existsSync(manifestPath)) return null
	return JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
}

// `kody:@me/what-shipped/whatShipped` -> absolute file path of that export.
export function resolveKodyImport(specifier: string) {
	const match = /^kody:(@[a-z0-9-]+\/[a-z0-9-]+)\/(.+)$/.exec(specifier)
	if (!match) throw new Error(`Bad package import "${specifier}"`)
	const [, name, exportName] = match
	const manifest = getPackage(name)
	if (!manifest) throw new Error(`No saved package named ${name}`)
	const target = manifest.exports[`./${exportName}`]
	if (!target) {
		throw new Error(
			`Package ${name} has no export "./${exportName}". Exports: ${Object.keys(manifest.exports).join(', ')}`,
		)
	}
	return join(packageRoot(name), target)
}
