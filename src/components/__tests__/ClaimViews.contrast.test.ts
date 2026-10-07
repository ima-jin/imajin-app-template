// @vitest-environment jsdom
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import HomePage from '../../../app/page';
import { ClaimFormView, ClaimSuccessView, type ClaimFormState } from '../ClaimViews';
import { buildStylesheet, collectContrastSamples, failures, type Scheme } from './contrast';

/**
 * Guards #19: the `/claim` page rendered dark-theme text (`text-white`,
 * `text-gray-400`) on the browser's default white canvas, so it was unreadable
 * in both colour schemes. These tests render every state of the page into a
 * DOM, build the app's real stylesheet, and assert WCAG AA contrast for each
 * text element, form control and input border under BOTH
 * `prefers-color-scheme: light` and `dark`.
 */

const noop = () => {};

function form(formState: ClaimFormState): ReactElement {
  return createElement(ClaimFormView, {
    claimCode: 'abc-123',
    formState,
    onClaimCodeChange: noop,
    onSubmit: noop,
  });
}

const views: Array<{ name: string; element: ReactElement; expectText: string }> = [
  { name: 'claim form', element: form({ status: 'idle' }), expectText: 'Claim this app' },
  {
    name: 'claim form with an error',
    element: form({ status: 'error', message: 'Claim code was rejected' }),
    expectText: 'Claim code was rejected',
  },
  { name: 'claim form while submitting', element: form({ status: 'submitting' }), expectText: 'Claiming…' },
  {
    name: 'App claimed result (App DID + public key)',
    element: createElement(ClaimSuccessView, {
      result: { appDid: 'did:imajin:app:example', publicKey: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK' },
    }),
    expectText: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
  },
];

views.push({ name: 'home page', element: createElement(HomePage), expectText: 'Imajin App Template' });

const schemes: Scheme[] = ['light', 'dark'];

async function render(element: ReactElement) {
  const markup = renderToStaticMarkup(element);
  const doc = globalThis.document;
  doc.body.innerHTML = `<main>${markup}</main>`;
  const css = await buildStylesheet(markup);
  return { css, main: doc.body.querySelector('main') as HTMLElement };
}

describe('claim page colour contrast (WCAG AA)', () => {
  for (const scheme of schemes) {
    for (const view of views) {
      it(`${view.name} is readable in ${scheme} scheme`, async () => {
        const { css, main } = await render(view.element);
        expect(main.textContent).toContain(view.expectText);

        const samples = collectContrastSamples(main, css, scheme);
        expect(samples.length).toBeGreaterThan(2);
        expect(failures(samples)).toEqual([]);
      });
    }
  }

  it('flags light text that inherits the default white canvas (regression for #19)', async () => {
    const { css, main } = await render(createElement('p', { className: 'text-white' }, 'White on white'));
    const samples = collectContrastSamples(main, css, 'light');
    expect(failures(samples)).toHaveLength(1);
  });

  it('flags text that is only styled for the other colour scheme', async () => {
    // Pairing a foreground with the wrong background must be caught: dark-theme
    // gray text on an explicitly white surface.
    const { css, main } = await render(
      createElement('div', { className: 'bg-white' }, createElement('p', { className: 'text-gray-400' }, 'Muted')),
    );
    expect(failures(collectContrastSamples(main, css, 'dark'))).toHaveLength(1);
  });
});
