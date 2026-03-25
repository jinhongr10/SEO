import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectCategory, DEFAULT_CATEGORIES } from '../keywords.js';

describe('detectCategory', () => {
  it('detects soap dispenser from filename', () => {
    const result = detectCategory('wall-soap-dispenser-pro.jpg', '2024/01/', DEFAULT_CATEGORIES);
    assert.ok(result);
    assert.equal(result.slug, 'soap-dispenser');
  });

  it('detects paper towel dispenser', () => {
    const result = detectCategory('c-fold-towel-holder.jpg', 'products/', DEFAULT_CATEGORIES);
    assert.ok(result);
    assert.equal(result.slug, 'paper-towel-dispenser');
  });

  it('detects hand dryer', () => {
    const result = detectCategory('jet-dryer-2000.png', '', DEFAULT_CATEGORIES);
    assert.ok(result);
    assert.equal(result.slug, 'hand-dryer');
  });

  it('detects air freshener', () => {
    const result = detectCategory('air-freshener-unit.jpg', '', DEFAULT_CATEGORIES);
    assert.ok(result);
    assert.equal(result.slug, 'air-freshener');
  });

  it('detects waste receptacle', () => {
    const result = detectCategory('stainless-trash-bin.jpg', '', DEFAULT_CATEGORIES);
    assert.ok(result);
    assert.equal(result.slug, 'waste-receptacle');
  });

  it('returns null for unrecognized filename', () => {
    const result = detectCategory('random-image-12345.jpg', '', DEFAULT_CATEGORIES);
    assert.equal(result, null);
  });

  it('uses relative path for matching', () => {
    const result = detectCategory('product.jpg', 'restroom/accessories/', DEFAULT_CATEGORIES);
    assert.ok(result);
    assert.equal(result.slug, 'restroom-equipment');
  });

  it('prioritizes longer (more specific) patterns', () => {
    // "foaming-dispenser" is more specific than "dispenser" alone
    const result = detectCategory('foaming-dispenser-pro.jpg', '', DEFAULT_CATEGORIES);
    assert.ok(result);
    assert.equal(result.slug, 'soap-dispenser');
  });
});
