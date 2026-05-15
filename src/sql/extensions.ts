import type { Driver } from './driver.ts'

let _postgresVersion: number | null = null

export function resetPostgresVersionCache(): void {
  _postgresVersion = null
}

export async function getPostgresVersion(driver: Driver): Promise<number> {
  if (_postgresVersion !== null) return _postgresVersion

  const rows = await driver.executeQuery('SHOW server_version')
  if (!rows || rows.length === 0) return 0

  const versionString = String(rows[0]?.cells['server_version'] ?? '')
  const major = parseInt(versionString.split('.').at(0) ?? '0', 10)
  _postgresVersion = major
  return major
}

export async function checkPostgresVersionRequirement(
  driver: Driver,
  minVersion: number,
  featureName: string,
): Promise<[boolean, string]> {
  const version = await getPostgresVersion(driver)

  if (version >= minVersion) {
    return [
      true,
      `PostgreSQL version ${version} meets the requirement for ${featureName}`,
    ]
  }

  return [
    false,
    `This feature (${featureName}) requires PostgreSQL ${minVersion} or later. Your current version is PostgreSQL ${version || 'unknown'}.`,
  ]
}

export interface ExtensionStatus {
  isInstalled: boolean
  isAvailable: boolean
  name: string
  message: string
  defaultVersion: string | null
}

export async function checkExtension(
  driver: Driver,
  extensionName: string,
  includeMessages = true,
  messageType: 'plain' | 'markdown' = 'plain',
): Promise<ExtensionStatus> {
  const installedRows = await driver.executeParamQuery(
    'SELECT extversion FROM pg_extension WHERE extname = $1',
    [extensionName],
  )

  const result: ExtensionStatus = {
    isInstalled: false,
    isAvailable: false,
    name: extensionName,
    message: '',
    defaultVersion: null,
  }

  if (installedRows && installedRows.length > 0) {
    const version = String(installedRows[0]?.cells['extversion'] ?? 'unknown')
    result.isInstalled = true
    result.isAvailable = true

    if (includeMessages) {
      result.message =
        messageType === 'markdown'
          ? `The **${extensionName}** extension (version ${version}) is already installed.`
          : `The ${extensionName} extension (version ${version}) is already installed.`
    }
    return result
  }

  const availableRows = await driver.executeParamQuery(
    'SELECT default_version FROM pg_available_extensions WHERE name = $1',
    [extensionName],
  )

  if (availableRows && availableRows.length > 0) {
    result.isAvailable = true
    result.defaultVersion =
      (availableRows[0]?.cells['default_version'] as string | undefined) ?? null

    if (includeMessages) {
      result.message =
        messageType === 'markdown'
          ? `The **${extensionName}** extension is available but not installed.\n\nYou can install it by running: \`CREATE EXTENSION ${extensionName};\`.`
          : `The ${extensionName} extension is available but not installed.\nYou can install it by running: CREATE EXTENSION ${extensionName};`
    }
    return result
  }

  if (includeMessages) {
    result.message =
      messageType === 'markdown'
        ? `The **${extensionName}** extension is not available on this PostgreSQL server.\n\nTo install it, you need to:\n1. Install the extension package on the server\n2. Run: \`CREATE EXTENSION ${extensionName};\``
        : `The ${extensionName} extension is not available on this PostgreSQL server.\nTo install it, you need to:\n1. Install the extension package on the server\n2. Run: CREATE EXTENSION ${extensionName};`
  }

  return result
}

/**
 * Extensions checkers
 */

export async function checkPgStatStatements(
  driver: Driver,
  includeMessages = true,
  messageType: 'plain' | 'markdown' = 'plain',
): Promise<ExtensionStatus> {
  return checkExtension(
    driver,
    'pg_stat_statements',
    includeMessages,
    messageType,
  )
}
