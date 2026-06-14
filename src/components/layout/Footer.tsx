'use client';
/**
 * @file components/layout/Footer.tsx
 * Persistent footer — matches the original React version structure exactly.
 * Logo · Contacts (X, Discord, GitHub, Dev contact) · Copyright
 */

import Link from 'next/link';
import { SaldenLogo } from '@/components/shared/Logo';

// ── Social icon SVGs (inline — no Phosphor dependency) ────────────────────────
function XIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.265 5.638L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z"/>
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/>
    </svg>
  );
}

export function Footer() {
  const twitterCompanyUrl = process.env.NEXT_PUBLIC_TWITTER_COMPANY_URL ?? 'https://x.com/SaldenPayroll';
  const twitterDevUrl     = process.env.NEXT_PUBLIC_TWITTER_DEV_URL     ?? 'https://x.com/Elijah463_';
  const githubUrl         = process.env.NEXT_PUBLIC_GITHUB_URL           ?? 'https://github.com/Elijah463/Salden-Dapp';

  const linkStyle: React.CSSProperties = {
    display:         'flex',
    alignItems:      'center',
    gap:             6,
    padding:         '6px 10px',
    borderRadius:    8,
    fontSize:        13,
    color:           '#64748B',
    textDecoration:  'none',
    transition:      'color 0.15s, background 0.15s',
    fontWeight:      500,
  };

  return (
    <footer
      style={{
        borderTop:  '1px solid #E2E8F0',
        background: 'rgba(248,249,250,0.8)',
        padding:    '0',
      }}
    >
      <div className="footer-inner">
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SaldenLogo size={36} />
        </div>

        {/* Contacts */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginRight: 4 }}>
            Contacts:
          </span>

          <a
            href={twitterCompanyUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={linkStyle}
            aria-label="Salden on X"
            onMouseEnter={e => {
              (e.currentTarget as HTMLAnchorElement).style.color      = '#0F172A';
              (e.currentTarget as HTMLAnchorElement).style.background = '#F1F5F9';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLAnchorElement).style.color      = '#64748B';
              (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
            }}
          >
            <XIcon />
            <span className="footer-link-label">X</span>
          </a>

          <a
            href="#"
            style={linkStyle}
            aria-label="Discord"
            onMouseEnter={e => {
              (e.currentTarget as HTMLAnchorElement).style.color      = '#0F172A';
              (e.currentTarget as HTMLAnchorElement).style.background = '#F1F5F9';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLAnchorElement).style.color      = '#64748B';
              (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
            }}
          >
            <DiscordIcon />
            <span className="footer-link-label">Discord</span>
          </a>

          <a
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={linkStyle}
            aria-label="GitHub"
            onMouseEnter={e => {
              (e.currentTarget as HTMLAnchorElement).style.color      = '#0F172A';
              (e.currentTarget as HTMLAnchorElement).style.background = '#F1F5F9';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLAnchorElement).style.color      = '#64748B';
              (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
            }}
          >
            <GitHubIcon />
            <span className="footer-link-label">GitHub</span>
          </a>

          <span style={{ color: '#E2E8F0', margin: '0 4px', fontSize: 16 }}>|</span>

          <a
            href={twitterDevUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...linkStyle, color: '#4F46E5' }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLAnchorElement).style.color      = '#3730A3';
              (e.currentTarget as HTMLAnchorElement).style.background = '#EEF2FF';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLAnchorElement).style.color      = '#4F46E5';
              (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
            }}
          >
            Contact Developer
          </a>
        </div>

        {/* Copyright */}
        <p style={{ fontSize: 12, color: '#94A3B8', margin: 0 }}>
          Copyright &copy; Salden Limited 2026
        </p>
      </div>
    </footer>
  );
}
