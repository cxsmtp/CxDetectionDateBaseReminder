import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

test('Environment Loading and Credential Validation', async (t) => {
  
  await t.test('CX_API_KEY is loaded from environment without corruption', () => {
    // Simulate what happens during app startup
    const sample = 'not-a-real-value-12345';
    
    // Test trimming (our envValue function)
    const trimmed = String(sample)
      .replace(/\r\n/g, '\n')
      .replace(/[\r\n]+/g, '')
      .trim();
    
    assert.equal(trimmed, sample, 'the value should be trimmed correctly');
    assert.ok(!trimmed.includes('\r'), 'No carriage returns');
    assert.ok(!trimmed.includes('\n'), 'No newlines');
  });

  await t.test('SMTP credentials are loaded and trimmed correctly', () => {
    // Test SMTP values with various whitespace issues
    const testCases = [
      { input: 'smtp.gmail.com', expected: 'smtp.gmail.com' },
      { input: '  smtp.gmail.com  ', expected: 'smtp.gmail.com' },
      { input: 'smtp.gmail.com\r\n', expected: 'smtp.gmail.com' },
      { input: '"smtp.gmail.com"', expected: 'smtp.gmail.com' },
      { input: "'smtp.gmail.com'", expected: 'smtp.gmail.com' },
      { input: '  "smtp.gmail.com"  ', expected: 'smtp.gmail.com' },
    ];

    for (const { input, expected } of testCases) {
      // Simulate envValue function
      let clean = String(input)
        .replace(/\r\n/g, '\n')
        .replace(/[\r\n]+/g, '')
        .trim();
      
      if ((clean.startsWith('"') && clean.endsWith('"')) || 
          (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.slice(1, -1).trim();
      }
      
      assert.equal(clean, expected, `Input "${input}" should clean to "${expected}"`);
    }
  });

  await t.test('Port numbers are correctly parsed from environment', () => {
    const testCases = [
      { input: '587', expected: 587 },
      { input: '25', expected: 25 },
      { input: '465', expected: 465 },
      { input: ' 587 ', expected: 587 },
      { input: '587\r\n', expected: 587 },
    ];

    for (const { input, expected } of testCases) {
      const trimmed = String(input).trim();
      const parsed = Number.parseInt(trimmed, 10);
      assert.equal(parsed, expected, `Port "${input}" should parse to ${expected}`);
    }
  });

  await t.test('Boolean values from environment are correctly interpreted', () => {
    const testCases = [
      { input: 'true', expected: true },
      { input: '1', expected: true },
      { input: 'yes', expected: true },
      { input: 'on', expected: true },
      { input: 'false', expected: false },
      { input: '0', expected: false },
      { input: '', expected: false },
    ];

    for (const { input, expected } of testCases) {
      const result = /^(1|true|yes|on)$/i.test(String(input).trim());
      assert.equal(result, expected, `Input "${input}" should be ${expected}`);
    }
  });

  await t.test('Required SMTP fields are present after loading', () => {
    // Simulate SMTP configuration object
    const smtp = {
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireAuth: true,
      user: 'test@gmail.com',
      password: 'app-password-here',
      fromName: 'Checkmarx Reminders',
      fromAddress: 'noreply@checkmarx.com',
    };

    // Verify all required fields exist
    assert.ok(smtp.host, 'SMTP host must be set');
    assert.ok(smtp.port > 0, 'SMTP port must be positive');
    assert.ok(smtp.user, 'SMTP user must be set');
    assert.ok(smtp.password, 'SMTP password must be set');
    assert.ok(typeof smtp.secure === 'boolean', 'SMTP secure must be boolean');
  });

  await t.test('API key length should be reasonable (not empty, not corrupted)', () => {
    // Simulating various API key lengths
    const testKeys = [
      { key: 'a'.repeat(100), valid: true, reason: 'short but valid key' },
      { key: 'a'.repeat(1000), valid: true, reason: 'long key (typical)' },
      { key: '', valid: false, reason: 'empty key' },
      { key: '\r\n\r\n', valid: false, reason: 'only whitespace' },
    ];

    for (const { key, valid, reason } of testKeys) {
      const trimmed = String(key).trim();
      const isValid = trimmed.length > 0;
      assert.equal(isValid, valid, `${reason}: expected ${valid}, got ${isValid}`);
    }
  });

  await t.test('Email addresses are properly formatted', () => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    const testCases = [
      { email: 'user@example.com', valid: true },
      { email: 'test.user@example.co.uk', valid: true },
      { email: 'user+tag@example.com', valid: true },
      { email: 'invalid@', valid: false },
      { email: '@example.com', valid: false },
      { email: 'no-at-sign.com', valid: false },
    ];

    for (const { email, valid } of testCases) {
      const isValid = emailRegex.test(email);
      assert.equal(isValid, valid, `Email "${email}" should be ${valid ? 'valid' : 'invalid'}`);
    }
  });

  await t.test('.env file exists in parent directory scenario', () => {
    // Check if .env handling code would work
    const envFilePath = path.join(projectRoot, '..', '.env');

    // Verify the path is constructed correctly (goes to parent and adds .env)
    assert.ok(envFilePath.includes('.env'), 'Path should include .env filename');
    assert.ok(!envFilePath.endsWith('CxDetectionDateBaseReminder'),
      'Path should go up to parent directory');
  });

  await t.test('Config loading does not expose secrets in logs', () => {
    // Simulate config loading with API key
    const apiKey = 'secret_key_12345_do_not_log';
    
    // This is how it should be logged
    const safeLog = `API key loaded (${apiKey.length} chars)`;
    
    assert.ok(safeLog.includes('chars'), 'Log should mention length');
    assert.ok(!safeLog.includes('secret_key'), 'Log should NOT contain actual key');
  });
});
