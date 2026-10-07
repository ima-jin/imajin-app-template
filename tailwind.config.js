/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // Scheme-aware tokens backed by CSS variables in app/globals.css.
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        muted: 'var(--muted)',
        danger: 'var(--danger)',
        link: 'var(--link)',
        field: 'var(--field-bg)',
        'field-border': 'var(--field-border)',
      },
    },
  },
  plugins: [],
};
