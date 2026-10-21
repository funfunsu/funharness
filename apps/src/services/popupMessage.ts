import * as vscode from 'vscode';

export const POPUP_TEXT_MAX = 320;
export const POPUP_DETAIL_MAX = 1200;
export const POPUP_WRAP_TOKEN_MAX = 80;

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
    return vscode.window.showWarningMessage(sanitizePopupText(message));
}

export function showErrorMessageSafe(
    message: string,
    options?: { modal?: boolean; detail?: string },
): Thenable<string | undefined> {
    const detail = options?.detail
        ? sanitizePopupText(options.detail, POPUP_DETAIL_MAX)
        : undefined;
    return vscode.window.showErrorMessage(sanitizePopupText(message), {
        modal: options?.modal,
        detail,
    });
}
