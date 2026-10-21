import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let cachedHostMap: Map<string, string> | null = null;

function parseHostAliases(content: string): Map<string, string> {
    const map = new Map<string, string>();
    const lines = content.split(/\r?\n/);
    let currentHosts: string[] = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const commentIndex = line.indexOf('#');
        const cleanLine = commentIndex >= 0 ? line.slice(0, commentIndex).trim() : line;
        if (!cleanLine) {
            continue;
        }

        const firstSpace = cleanLine.search(/\s/);
        if (firstSpace <= 0) {
            continue;
        }

        const key = cleanLine.slice(0, firstSpace).toLowerCase();
        const value = cleanLine.slice(firstSpace).trim();
        if (!value) {
            continue;
        }

        if (key === 'host') {
            currentHosts = value
                .split(/\s+/)
                .map(item => item.trim().toLowerCase())
                .filter(item => item.length > 0 && !item.includes('*') && !item.includes('?') && !item.startsWith('!'));
            continue;
        }

        if (key === 'hostname' && currentHosts.length > 0) {
            const hostName = value.split(/\s+/)[0]?.trim().toLowerCase();
            if (!hostName) {
                continue;
            }
            for (const alias of currentHosts) {
                if (!map.has(alias)) {
                    map.set(alias, hostName);
                }
            }
        }
    }

    return map;
}

function loadHostMap(): Map<string, string> {
    const home = os.homedir();
    if (!home) {
        return new Map<string, string>();
    }

    const configPath = path.join(home, '.ssh', 'config');
    if (!fs.existsSync(configPath)) {
        return new Map<string, string>();
    }

    try {
        const content = fs.readFileSync(configPath, 'utf8');
        return parseHostAliases(content);
    } catch {
        return new Map<string, string>();
    }
}

export function resolveSshHostAlias(host: string): string | undefined {
    const normalized = (host || '').trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }

    if (!cachedHostMap) {
        cachedHostMap = loadHostMap();
    }

    const mapped = cachedHostMap.get(normalized);
    return mapped && mapped.trim() ? mapped.trim() : undefined;
}
