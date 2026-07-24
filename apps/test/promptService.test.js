'use strict';

/**
 * Unit tests for PromptService.
 * Coverage: domain summary prompt includes explicit domain context.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { PromptService } = require('../out/services/promptService');

describe('PromptService', () => {
    test('buildDomainSummaryPrompt includes explicit domain context', () => {
        const prompt = PromptService.buildDomainSummaryPrompt({
            canonical: 'billing',
            displayName: 'Billing',
            capabilities: [
                { reqId: 'Req-1', title: 'Collect invoice status', status: 'active' },
            ],
            registryCanonicals: ['billing', 'auth'],
        });

        assert.equal(prompt.includes('领域：Billing（billing）'), true);
        assert.equal(prompt.includes('"domain"'), true);
        assert.equal(prompt.includes('"canonical": "billing"'), true);
        assert.equal(prompt.includes('"displayName": "Billing"'), true);
    });
});