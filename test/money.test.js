// Every country's currency: the list the browser offers, checked on the server, and amounts
// written the way each currency is written (src/money.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanProfile } from '../src/iam.js';
import { mergeImpact } from '../src/settings.js';
import { currencies, formatMoney, validCurrency } from '../src/money.js';

test('every current currency is known; anything else is refused', () => {
  assert.ok(currencies().size > 150, `${currencies().size} currencies`);
  for (const code of ['USD', 'EUR', 'INR', 'JPY', 'AED', 'BRL', 'ZAR', 'KES', 'ILS', 'VND']) assert.equal(validCurrency(code), code);
  assert.equal(validCurrency(' inr '), 'INR');
  assert.equal(validCurrency('XYZ'), '');
  assert.equal(validCurrency('euros'), '');
  assert.equal(validCurrency(''), '');
  assert.equal(mergeImpact({ currency: 'USD' }, { currency: 'sgd' }).currency, 'SGD');
  assert.throws(() => mergeImpact({ currency: 'USD' }, { currency: 'XYZ' }), /choose a currency from the list/);
});

test('amounts are written in their currency\'s own way', () => {
  assert.equal(formatMoney(1234.5, 'USD'), '$1,235');
  assert.equal(formatMoney(1234.5, 'EUR', { digits: 2 }), '€1,234.5');
  assert.equal(formatMoney(123456.7, 'INR', { locale: 'en-IN' }), '₹1,23,457');
  assert.equal(formatMoney(1234, 'JPY'), '¥1,234');
  assert.equal(formatMoney(null, 'USD'), '—');
  assert.match(formatMoney(5, 'XYZ'), /^XYZ\s5$/, 'a well-formed code Intl does not know: the code with the amount');
});

test('your profile keeps a currency of your own and the rate from the organisation\'s', () => {
  assert.deepEqual(cleanProfile({ currency: 'inr', currencyRate: '83.2' }), { currency: 'INR', currencyRate: 83.2 });
  assert.deepEqual(cleanProfile({ currency: '', currencyRate: null }), { currency: '', currencyRate: null });
  assert.throws(() => cleanProfile({ currency: 'XYZ' }), /not a currency/);
  assert.throws(() => cleanProfile({ currencyRate: 0 }), /above 0/);
  assert.throws(() => cleanProfile({ currencyRate: 'abc' }), /above 0/);
});
