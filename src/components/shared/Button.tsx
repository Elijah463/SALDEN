'use client';
import { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'brand' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  children,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const colors: Record<string, { bg: string; hover: string; text: string; border?: string }> = {
    primary: { bg: '#14B8A6', hover: '#0D9488', text: '#fff' },
    brand:   { bg: '#14B8A6', hover: '#0D9488', text: '#fff' },
    outline: { bg: 'transparent', hover: '#F0FDFA', text: '#14B8A6', border: '1.5px solid #14B8A6' },
    ghost:   { bg: 'transparent', hover: '#F1F5F9', text: '#64748B', border: '1.5px solid #E2E8F0' },
    danger:  { bg: '#DC2626', hover: '#B91C1C', text: '#fff' },
  };

  const sizes = {
    sm: { padding: '7px 14px', fontSize: '13px' },
    md: { padding: '10px 20px', fontSize: '14px' },
    lg: { padding: '13px 28px', fontSize: '15px' },
  };

  const c = colors[variant];
  const s = sizes[size];

  return (
    <button
      disabled={disabled || loading}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: s.padding,
        background: c.bg,
        color: c.text,
        border: c.border ?? 'none',
        borderRadius: 10,
        fontSize: s.fontSize,
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled || loading ? 0.55 : 1,
        transition: 'all 0.15s ease',
        whiteSpace: 'nowrap',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled && !loading) {
          (e.currentTarget as HTMLButtonElement).style.background = c.hover;
        }
      }}
      onMouseLeave={(e) => {
        if (!disabled && !loading) {
          (e.currentTarget as HTMLButtonElement).style.background = c.bg;
        }
      }}
      {...props}
    >
      {loading ? (
        <span style={{
          width: 14, height: 14, border: '2px solid currentColor',
          borderTopColor: 'transparent', borderRadius: '50%',
          animation: 'spin 0.7s linear infinite', display: 'inline-block',
        }} />
      ) : icon}
      {children}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </button>
  );
}
