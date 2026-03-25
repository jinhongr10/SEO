import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSeoGenerator, scoreSeoOutput } from '../seo.js';

describe('DeterministicSeoGenerator', () => {
  const gen = createSeoGenerator('none');

  it('generates all four fields', async () => {
    const result = await gen.generate({
      filename: 'soap-dispenser-pro.jpg',
      currentTitle: 'Soap Dispenser',
      currentAlt: '',
      currentCaption: '',
      currentDescription: '',
      defaultKeywords: ['soap dispenser', 'commercial restroom'],
      postTitle: 'Wall Mounted Soap Dispenser',
      altMaxChars: 125,
    });

    assert.ok(result.title.length > 0);
    assert.ok(result.alt_text.length > 0);
    assert.ok(result.caption.length > 0);
    assert.ok(result.description.length > 0);
    assert.ok(result.title.length <= 70);
    assert.ok(result.alt_text.length <= 125);
  });

  it('includes series context when siblings are present', async () => {
    const result = await gen.generate({
      filename: 'product-front.jpg',
      currentTitle: '',
      currentAlt: '',
      currentCaption: '',
      currentDescription: '',
      defaultKeywords: ['soap dispenser'],
      altMaxChars: 125,
      siblingFilenames: ['product-front.jpg', 'product-side.jpg', 'product-back.jpg'],
      siblingIndex: 1,
    });

    assert.ok(result.title.includes('1 of 3') || result.alt_text.includes('1 of 3'));
  });

  it('respects altMaxChars limit', async () => {
    const result = await gen.generate({
      filename: 'very-long-product-name-stainless-steel-commercial-soap-dispenser.jpg',
      currentTitle: 'A very long title that might exceed limits',
      currentAlt: '',
      currentCaption: '',
      currentDescription: '',
      defaultKeywords: ['soap dispenser', 'commercial restroom', 'stainless steel', 'wall mounted'],
      altMaxChars: 60,
    });

    assert.ok(result.alt_text.length <= 60);
  });

  it('attaches a quality score', async () => {
    const result = await gen.generate({
      filename: 'soap-dispenser.jpg',
      currentTitle: 'Soap Dispenser',
      currentAlt: '',
      currentCaption: '',
      currentDescription: '',
      defaultKeywords: ['soap dispenser'],
      altMaxChars: 125,
    });

    assert.ok(typeof result.qualityScore === 'number');
    assert.ok(result.qualityScore >= 0 && result.qualityScore <= 100);
  });
});

describe('scoreSeoOutput', () => {
  it('returns a score between 0 and 100', () => {
    const score = scoreSeoOutput(
      {
        title: 'Commercial Soap Dispenser - Wall Mounted',
        alt_text: 'Stainless steel wall mounted commercial soap dispenser for restrooms',
        caption: 'Premium commercial soap dispenser for professional spaces.',
        description: 'This commercial soap dispenser is designed for high-traffic restrooms. Durable stainless steel construction ensures long-lasting performance.',
      },
      ['soap dispenser', 'commercial restroom'],
    );

    assert.ok(score.total >= 0);
    assert.ok(score.total <= 100);
    assert.ok(score.lengthScore >= 0);
    assert.ok(score.keywordScore >= 0);
    assert.ok(score.uniquenessScore >= 0);
    assert.ok(score.readabilityScore >= 0);
  });

  it('penalizes identical fields', () => {
    const good = scoreSeoOutput(
      {
        title: 'Soap Dispenser',
        alt_text: 'Commercial soap dispenser wall mounted',
        caption: 'Premium dispenser for commercial use.',
        description: 'High quality commercial soap dispenser for restrooms.',
      },
      ['soap dispenser'],
    );

    const bad = scoreSeoOutput(
      {
        title: 'Soap Dispenser',
        alt_text: 'Soap Dispenser',
        caption: 'Soap Dispenser',
        description: 'Soap Dispenser',
      },
      ['soap dispenser'],
    );

    assert.ok(good.uniquenessScore > bad.uniquenessScore);
  });

  it('rewards keyword presence', () => {
    const withKw = scoreSeoOutput(
      {
        title: 'soap dispenser commercial',
        alt_text: 'wall mounted soap dispenser',
        caption: 'commercial restroom product',
        description: 'soap dispenser for commercial restroom use',
      },
      ['soap dispenser', 'commercial restroom'],
    );

    const noKw = scoreSeoOutput(
      {
        title: 'product image',
        alt_text: 'photo of item',
        caption: 'item detail',
        description: 'a product for various uses',
      },
      ['soap dispenser', 'commercial restroom'],
    );

    assert.ok(withKw.keywordScore > noKw.keywordScore);
  });
});
