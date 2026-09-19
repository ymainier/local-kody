import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { secretsFile } from './paths.ts'

// MVP store: a 0600 JSON file. Next step: macOS Keychain via `security`.
type SecretRecord = { value: string; allowedHosts: Array<string> }
type SecretStore = Record<string, SecretRecord>

const placeholderPattern = /\{\{secret:([a-zA-Z0-9_]+)\}\}/g

function readStore(): SecretStore {
	if (!existsSync(secretsFile)) return {}
	return JSON.parse(readFileSync(secretsFile, 'utf8')) as SecretStore
}

function writeStore(store: SecretStore) {
	writeFileSync(secretsFile, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export function setSecret(name: string, value: string, allowedHosts: Array<string>) {
	const store = readStore()
	store[name] = { value, allowedHosts }
	writeStore(store)
}

export function allowSecretHost(name: string, host: string) {
	const store = readStore()
	const secret = store[name]
	if (!secret) throw new Error(`No secret named "${name}"`)
	secret.allowedHosts = [...new Set([...secret.allowedHosts, host])]
	writeStore(store)
}

// Names and hosts only. There is deliberately no way to read a value back.
export function listSecretNames() {
	return Object.entries(readStore()).map(([name, secret]) => ({
		name,
		allowedHosts: secret.allowedHosts,
	}))
}

export function hostOf(url: string) {
	return new URL(url.replace(placeholderPattern, 'placeholder')).hostname
}

export function substituteSecrets(text: string, host: string) {
	const store = readStore()
	return text.replace(placeholderPattern, (_, name: string) => {
		const secret = store[name]
		if (!secret) {
			throw new Error(
				`Missing secret "${name}". Ask the user to run: npm run secret -- set ${name} <value> --host ${host}`,
			)
		}
		if (!secret.allowedHosts.includes(host)) {
			throw new Error(
				`Secret "${name}" is not approved for host ${host}. Ask the user to run: npm run secret -- allow ${name} ${host}`,
			)
		}
		return secret.value
	})
}
