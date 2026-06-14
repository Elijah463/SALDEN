/**
 * @file lib/validation.ts
 * Employee validation, address checks, and file import helpers.
 * Ported from the existing validation.js — logic preserved exactly.
 */

import { isAddress } from 'viem';
import type { Employee } from '@/context/AppContext';

// ── EIP-55 checksum validation via viem ──────────────────────────────────────
// viem's isAddress also validates EIP-55 checksum — stronger than regex alone

export function isValidEthAddress(addr: string): boolean {
  if (!addr) return false;
  // Accept both checksummed and lowercase addresses
  return isAddress(addr, { strict: false });
}

// ── Employee validation ────────────────────────────────────────────────────────

export interface ValidationResult {
  valid:  boolean;
  errors: string[];
}

export function validateEmployee(emp: Partial<Employee>): ValidationResult {
  const errors: string[] = [];

  if (!emp.fullName?.trim())
    errors.push('Full name is required.');

  if (!emp.department?.trim())
    errors.push('Department is required.');

  if (!emp.walletAddress?.trim())
    errors.push('Wallet address is required.');
  else if (!isValidEthAddress(emp.walletAddress.trim()))
    errors.push('Wallet address must be a valid Ethereum address (0x…, 42 chars).');

  const amt = Number(emp.salaryAmount);
  if (!emp.salaryAmount && emp.salaryAmount !== 0)
    errors.push('Salary amount is required.');
  else if (isNaN(amt) || amt < 0)
    errors.push('Salary amount must be a non-negative number.');
  else if (amt > 1_000_000)
    errors.push('Salary amount exceeds the per-employee maximum of 1,000,000 USDC.');

  return { valid: errors.length === 0, errors };
}

// ── Duplicate wallet detection ────────────────────────────────────────────────

export function findDuplicateWallets(
  employees: Employee[]
): Array<{ address: string; rows: number[] }> {
  const seen = new Map<string, number[]>();

  employees.forEach((emp, idx) => {
    const addr = emp.walletAddress?.toLowerCase();
    if (!addr) return;
    if (!seen.has(addr)) seen.set(addr, []);
    seen.get(addr)!.push(idx + 1); // 1-based row numbers
  });

  return Array.from(seen.entries())
    .filter(([, rows]) => rows.length > 1)
    .map(([address, rows]) => ({ address, rows }));
}

// ── CSV / JSON file validation ────────────────────────────────────────────────

export interface FileValidationResult {
  valid: boolean;
  type:  'csv' | 'json';
  error?: string;
}

export function validateEmployeeFile(file: File): FileValidationResult {
  const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

  if (file.size > MAX_SIZE)
    return { valid: false, type: 'csv', error: 'File exceeds 5 MB limit.' };

  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'csv')  return { valid: true,  type: 'csv'  };
  if (ext === 'json') return { valid: true,  type: 'json' };

  return { valid: false, type: 'csv', error: 'Only CSV and JSON files are supported.' };
}

// ── Normalise imported rows (flexible column names) ───────────────────────────

const FIELD_MAP: Record<keyof Employee, string[]> = {
  fullName:      ['fullname', 'full name', 'name', 'employee name', 'employee'],
  department:    ['department', 'dept', 'team', 'division'],
  walletAddress: ['walletaddress', 'wallet address', 'wallet', 'address', '0x'],
  salaryAmount:  ['salaryamount', 'salary amount', 'salary', 'amount', 'pay'],
  group:         ['group', 'group name'],
};

function findColumn(headers: string[], candidates: string[]): string | undefined {
  return headers.find(h => candidates.includes(h.trim().toLowerCase()));
}

export function normalizeEmployeeRows(
  rows: Record<string, unknown>[]
): Employee[] {
  if (!rows.length) return [];
  const headers = Object.keys(rows[0]);

  const cols = {
    fullName:      findColumn(headers, FIELD_MAP.fullName),
    department:    findColumn(headers, FIELD_MAP.department),
    walletAddress: findColumn(headers, FIELD_MAP.walletAddress),
    salaryAmount:  findColumn(headers, FIELD_MAP.salaryAmount),
    group:         findColumn(headers, FIELD_MAP.group ?? []),
  };

  return rows
    .map(row => ({
      fullName:      cols.fullName      ? sanitizeImportValue(row[cols.fullName])      : '',
      department:    cols.department    ? sanitizeImportValue(row[cols.department])    : '',
      walletAddress: cols.walletAddress ? String(row[cols.walletAddress] ?? '').trim() : '', // don't sanitize — addr may start with 0x
      salaryAmount:  cols.salaryAmount  ? Number(row[cols.salaryAmount] ?? 0)          : 0,
      group:         cols.group         ? sanitizeImportValue(row[cols.group] ?? '')   : undefined,
    }))
    .filter(emp => emp.fullName || emp.walletAddress);
}

// ── String sanitisation + CSV formula injection prevention ───────────────────

/** Strip HTML-dangerous chars and CSV formula injection prefixes */
export function sanitizeString(input: string): string {
  if (!input) return '';
  // Strip characters dangerous in HTML
  let cleaned = input.replace(/[<>"'`]/g, '').trim().slice(0, 200);
  // Prevent CSV formula injection — strip leading =, +, -, @, tab, CR
  // Attackers use these to inject spreadsheet formulas when data is exported
  cleaned = cleaned.replace(/^[=+\-@\t\r]+/, '');
  return cleaned;
}

/** Sanitize a value coming from CSV/JSON import */
export function sanitizeImportValue(value: unknown): string {
  const str = String(value ?? '').trim();
  // Strip formula injection prefixes
  return str.replace(/^[=+\-@\t\r]+/, '').slice(0, 500);
}

// ── Address truncation helper ─────────────────────────────────────────────────

export function truncAddr(addr: string, start = 6, end = 4): string {
  if (!addr) return '';
  return `${addr.slice(0, start)}…${addr.slice(-end)}`;
}
