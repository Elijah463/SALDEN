'use client';
import { ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  maxWidth?: number;
}

export function Modal({ open, onClose, title, children, maxWidth = 480 }: ModalProps) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="modal-box"
        style={{ maxWidth }}
      >
        {title && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 24,
          }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#0F172A' }}>{title}</h3>
            <button
              onClick={onClose}
              style={{
                width: 32, height: 32, borderRadius: 8, border: 'none',
                background: '#F1F5F9', cursor: 'pointer', display: 'flex',
                alignItems: 'center', justifyContent: 'center', color: '#64748B',
              }}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
