/**
 * @file lib/groups.ts
 * Single source of truth for the default employee groups. "All Employees"
 * anywhere in the app means these groups combined, not a distinct group of
 * its own — components should never hardcode this list separately.
 */
export const DEFAULT_GROUPS = ['Main Employees', 'Remote Employees', 'Contractors'] as const;

export const ALL_EMPLOYEES_LABEL = 'All Employees';
