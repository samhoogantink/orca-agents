import { existsSync, readFileSync } from 'node:fs'
import { unknownUsage, type ProviderUsage, type UsageWindow } from './types.ts'

/**
 * Claude Code passes `rate_limits` (five_hour / seven_day, used_percentage, resets_at in epoch
 * seconds) to its status line command for Pro and Max subscribers. scripts/claude-statusline.mjs
 * writes that object to a feed file, and this probe reads it back.
 */
const STALE_AFTER_MS = 6 * 3600 * 1000

type FeedWindow = { used_percentage?: number; resets_at?: number }
export type ClaudeFeed = { writtenAt?: number; rate_limits?: Record<string, FeedWindow | undefined> }

const NAMES: Record<string, string> = { five_hour: 'session', seven_day: 'weekly' }

export function mapClaudeFeed(feed: ClaudeFeed, now = Date.now()): ProviderUsage {
	if (!feed.writtenAt || now - feed.writtenAt > STALE_AFTER_MS) {
		return { ...unknownUsage('claude', 'claude-statusline', 'feed is stale; open a Claude Code session to refresh it'), fetchedAt: now }
	}
	const windows: UsageWindow[] = []
	for (const [key, raw] of Object.entries(feed.rate_limits ?? {})) {
		if (typeof raw?.used_percentage !== 'number') continue
		windows.push({
			name: NAMES[key] ?? key,
			pool: 'included',
			usedPercent: raw.used_percentage,
			resetsAt: typeof raw.resets_at === 'number' ? raw.resets_at * 1000 : null
		})
	}
	if (!windows.length) return { ...unknownUsage('claude', 'claude-statusline', 'feed has no rate_limits'), fetchedAt: now }
	return { provider: 'claude', status: 'ok', source: 'claude-statusline', windows, fetchedAt: now }
}

export function probeClaude(feedPath: string): ProviderUsage {
	if (!existsSync(feedPath)) {
		return unknownUsage('claude', 'claude-statusline', `no feed at ${feedPath}; see scripts/claude-statusline.mjs`)
	}
	try {
		return mapClaudeFeed(JSON.parse(readFileSync(feedPath, 'utf8')) as ClaudeFeed)
	} catch (err) {
		return unknownUsage('claude', 'claude-statusline', `unreadable feed: ${String(err)}`)
	}
}
