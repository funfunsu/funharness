import { createHash } from 'crypto';
import { Feature } from '../models';
const TinyPinyin = require('tiny-pinyin') as {
    isSupported?: (forceRedetect?: boolean) => boolean;
    convertToPinyin?: (input: string, separator?: string, lowerCase?: boolean) => string;
};

const MAX_SEMANTIC_PART_LEN = 42;
const MAX_ASCII_TOKENS = 4;
const MAX_BRANCH_NAME_LEN = 64;

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'for', 'from', 'with', 'without', 'by',
    'of', 'in', 'on', 'at', 'is', 'are', 'be', 'as', 'it', 'this', 'that', 'task',
    'todo', 'fix', 'feature', 'update', 'add', 'remove', 'create', 'init'
]);

function sanitizeAsciiSegment(input: string): string {
    return (input || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function collectAsciiTokens(input: string): string[] {
    if (!input) {
        return [];
    }
    const matches = input.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) || [];
    const normalized = matches
        .map(token => sanitizeAsciiSegment(token))
        .filter(token => token.length >= 2)
        .filter(token => !STOP_WORDS.has(token));
    return Array.from(new Set(normalized));
}

function transliterateWithTinyPinyin(input: string): string {
    const value = (input || '').trim();
    if (!value) {
        return '';
    }

    try {
        const supported = typeof TinyPinyin.isSupported === 'function' ? TinyPinyin.isSupported() : true;
        if (!supported || typeof TinyPinyin.convertToPinyin !== 'function') {
            return '';
        }
        return TinyPinyin.convertToPinyin(value, ' ', true);
    } catch {
        return '';
    }
}

function codePointHint(input: string): string {
    const chars = Array.from(input || '').slice(0, 3);
    const parts = chars
        .map(ch => ch.codePointAt(0))
        .filter((value): value is number => Number.isFinite(value))
        .map(value => value.toString(16));
    return parts.length > 0 ? `u${parts.join('-u')}` : '';
}

function buildSemanticPart(task: Feature): string {
    const transliteratedTokens = [
        ...collectAsciiTokens(transliterateWithTinyPinyin(task.name || '')),
        ...collectAsciiTokens(transliterateWithTinyPinyin(task.desc || '')),
    ];

    const asciiTokens = [
        ...collectAsciiTokens(task.name || ''),
        ...collectAsciiTokens(task.desc || ''),
        ...transliteratedTokens,
    ];

    if (asciiTokens.length > 0) {
        return sanitizeAsciiSegment(asciiTokens.slice(0, MAX_ASCII_TOKENS).join('-')).slice(0, MAX_SEMANTIC_PART_LEN);
    }

    const unicodeHint = sanitizeAsciiSegment(codePointHint(task.name || task.desc || ''));
    if (unicodeHint) {
        return unicodeHint.slice(0, MAX_SEMANTIC_PART_LEN);
    }

    return 'work-item';
}

function buildHashSuffix(task: Feature): string {
    const raw = `${task.id}|${task.name}|${task.desc}`;
    return createHash('sha1').update(raw).digest('hex').slice(0, 6);
}

function normalizeBranch(branch: string): string {
    // Keep output strictly git-safe and ASCII only.
    return (branch || '')
        .replace(/\.lock$/i, '')
        .replace(/\.{2,}/g, '.')
        .replace(/\/@\{/g, '/')
        .replace(/[^a-z0-9/_-]+/gi, '-')
        .replace(/-+/g, '-')
        .replace(/\/+/g, '/')
        .replace(/^[-/.]+|[-/.]+$/g, '')
        .toLowerCase();
}

function clampBranchLength(branch: string, hash: string, fallbackId: string): string {
    const normalized = normalizeBranch(branch);
    if (!normalized) {
        return normalizeBranch(`task/${fallbackId}-${hash}`).slice(0, MAX_BRANCH_NAME_LEN);
    }
    if (normalized.length <= MAX_BRANCH_NAME_LEN) {
        return normalized;
    }

    const fixedTail = `-${hash}`;
    const hardFallback = normalizeBranch(`task/${fallbackId}${fixedTail}`).slice(0, MAX_BRANCH_NAME_LEN);
    const cutLen = MAX_BRANCH_NAME_LEN - fixedTail.length;
    if (cutLen <= 0) {
        return hardFallback;
    }

    const head = normalized.slice(0, cutLen).replace(/[-/.]+$/g, '');
    const clamped = normalizeBranch(`${head}${fixedTail}`);
    return clamped || hardFallback;
}

/**
 * Generate a stable, git-safe branch name from task metadata.
 * - Task display name can stay in Chinese.
 * - Branch is always ASCII and carries lightweight task semantics.
 */
export function deriveIterationBranchName(task: Feature): string {
    const existing = (task.iterationBranch || '').trim();
    if (existing) {
        return existing;
    }

    const semantic = buildSemanticPart(task);
    const hash = buildHashSuffix(task);
    const fallbackId = sanitizeAsciiSegment((task.id || '').replace(/^task_/, 'task-')).slice(0, 18) || 'task';
    const branch = `task/${semantic || fallbackId}-${hash}`;
    return clampBranchLength(branch, hash, fallbackId);
}
