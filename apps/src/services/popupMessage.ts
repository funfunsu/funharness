import * as vscode from 'vscode';

export const POPUP_TEXT_MAX = 320;
export const POPUP_DETAIL_MAX = 1200;
export const POPUP_WRAP_TOKEN_MAX = 80;
export const POPUP_MESSAGE_MAX = 140;
export const POPUP_DETAIL_LINE_MAX = 12;

function truncateWithEllipsis(text: string, maxLen: number): string {
    if (text.length <= maxLen) {
        return text;
    }
    return `${text.slice(0, maxLen)}...`;
}

export function sanitizePopupMessage(input: string, maxLen: number = POPUP_MESSAGE_MAX): string {
    const raw = String(input || '').replace(/\r\n/g, '\n').trim();
    if (!raw) {
        return '';
    }
    // Keep modal body short and single-line so action buttons remain visible.
    const compact = raw.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ');
    return truncateWithEllipsis(compact, maxLen);
}

export function sanitizePopupDetail(
    input: string,
    maxLen: number = POPUP_DETAIL_MAX,
    maxLines: number = POPUP_DETAIL_LINE_MAX,
): string {
    const raw = String(input || '').replace(/\r\n/g, '\n').trim();
    if (!raw) {
        return '';
    }
    const wrapped = raw.replace(new RegExp(`(\\S{${POPUP_WRAP_TOKEN_MAX}})(?=\\S)`, 'g'), '$1\n');
    const lines = wrapped.split('\n').map(line => line.trimEnd());
    const limited = lines.slice(0, maxLines);
    if (lines.length > maxLines) {
        limited.push(`...（其余 ${lines.length - maxLines} 行已省略）`);
    }
    return truncateWithEllipsis(limited.join('\n'), maxLen);
}

export function sanitizePopupText(input: string, maxLen: number = POPUP_TEXT_MAX): string {
    const raw = String(input || '').replace(/\r\n/g, '\n').trim();
    if (!raw) {
        return '';
    }
    // Prevent single-line long tokens from stretching popup width out of viewport.
    const wrapped = raw.replace(new RegExp(`(\\S{${POPUP_WRAP_TOKEN_MAX}})(?=\\S)`, 'g'), '$1\n');
    if (wrapped.length <= maxLen) {
        return wrapped;
    }
    return `${wrapped.slice(0, maxLen)}...`;
}

export function showWarningMessageSafe(message: string): Thenable<string | undefined> {
    return vscode.window.showWarningMessage(sanitizePopupMessage(message));
}

export function showErrorMessageSafe(
    message: string,
    options?: { modal?: boolean; detail?: string },
): Thenable<string | undefined> {
    const rawMessage = String(message || '');
    const compactMessage = sanitizePopupMessage(rawMessage);
    const detailSource = options?.detail || (compactMessage !== rawMessage.trim() ? rawMessage : '');
    const detail = detailSource
        ? sanitizePopupDetail(detailSource, POPUP_DETAIL_MAX)
        : undefined;
    return vscode.window.showErrorMessage(compactMessage, {
        modal: options?.modal,
        detail,
    });
}
